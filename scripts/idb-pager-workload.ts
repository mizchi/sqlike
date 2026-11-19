import { AotDatabase } from "../adapters/aot-database.ts";
import { MoonImageStore } from "../adapters/moon-image-store.ts";
import { IndexedDbAotPageStore } from "../adapters/aot-page-store.ts";
import type {
  ImageStore,
  ImageDelta,
  ImageSnapshot,
  ImageCheckpoint,
} from "../src/persistence-contract.ts";
import type {
  AotPageImageStore,
  AotLogicalPublication,
} from "../src/aot-checkpoint-contract.ts";
import { isAotPageImageStore } from "../src/aot-checkpoint-contract.ts";
import type { SqlitePageCommit } from "../src/sqlite-pager-contract.ts";
import { toBase64 } from "../src/aot-values.ts";
import { observeIdbRequests } from "./idb-pager-metrics.ts";

export type Strategy =
  | "inline"
  | "pager-json"
  | "pager"
  | "pager-chunks"
  | "pager-differential";
export type Phase = "natural" | "snapshot";
export interface PagerIdbFixture {
  artifact: string;
  hash: string;
  saved: string;
  count: number;
  payload: number;
}
interface Publication {
  kind: "journal" | "snapshot" | "journal+pages" | "snapshot+pages";
  milliseconds: number;
}
class ObservedStore implements ImageStore {
  force = false;
  calls: Publication[] = [];
  commitSnapshot?: (
    generation: number,
    snapshot: ImageSnapshot,
  ) => Promise<number>;
  commitCheckpoint?: (
    generation: number,
    checkpoint: ImageCheckpoint,
  ) => Promise<number>;
  constructor(
    readonly raw: ImageStore,
    chunks = false,
    differential = false,
  ) {
    if (differential && raw.commitCheckpoint)
      this.commitCheckpoint = async (generation, checkpoint) => {
        const start = performance.now();
        const result = await raw.commitCheckpoint!(generation, checkpoint);
        this.force = false;
        this.calls.push({
          kind: "snapshot",
          milliseconds: performance.now() - start,
        });
        return result;
      };
    if (chunks && raw.commitSnapshot)
      this.commitSnapshot = async (generation, snapshot) => {
        const start = performance.now();
        const result = await raw.commitSnapshot!(generation, snapshot);
        this.force = false;
        this.calls.push({
          kind: "snapshot",
          milliseconds: performance.now() - start,
        });
        return result;
      };
  }
  read() {
    return this.raw.read();
  }
  close() {
    this.raw.close();
  }
  checkpointNeeded() {
    return this.force || (this.raw.checkpointNeeded?.() ?? false);
  }
  async commit(generation: number, image: string) {
    const start = performance.now();
    const result = await this.raw.commit(generation, image);
    this.force = false;
    this.calls.push({
      kind: "snapshot",
      milliseconds: performance.now() - start,
    });
    return result;
  }
  async commitDelta(generation: number, delta: ImageDelta) {
    const start = performance.now();
    const result = await this.raw.commitDelta!(generation, delta);
    this.calls.push({
      kind: "journal",
      milliseconds: performance.now() - start,
    });
    return result;
  }
}
class ObservedPageStore extends ObservedStore implements AotPageImageStore {
  constructor(
    readonly provider: AotPageImageStore,
    readonly jsonChecksums = false,
    chunks = false,
    differential = false,
  ) {
    super(provider, chunks, differential);
  }
  get pages() {
    if (this.jsonChecksums)
      return {
        head: () => this.provider.pages.head(),
        readPage: (g: number, p: number) => this.provider.pages.readPage(g, p),
        readFile: (g: number, n: string) => this.provider.pages.readFile(g, n),
      };
    return this.provider.pages;
  }
  async commitWithPages(
    generation: number,
    logical: AotLogicalPublication,
    pageGeneration: number,
    value: SqlitePageCommit,
  ) {
    const start = performance.now();
    const result = await this.provider.commitWithPages(
      generation,
      logical,
      pageGeneration,
      value,
    );
    if (!logical.delta) this.force = false;
    this.calls.push({
      kind: logical.delta ? "journal+pages" : "snapshot+pages",
      milliseconds: performance.now() - start,
    });
    return result;
  }
}
class Bench {
  index = 0;
  mutations: { id: number; n: number }[] = [];
  private archived: Awaited<ReturnType<AotDatabase["pending"]>> = [];
  async archive() {
    const files = await this.db.pending();
    if (files.length) {
      this.archived.push(...files);
      const last = files.at(-1)!;
      await this.db.acknowledge(last.maxTXID, last.sha256);
    }
  }
  constructor(
    readonly count: number,
    readonly store: ObservedStore,
    private db: AotDatabase,
    readonly artifact: string,
    readonly hash: string,
    readonly strategy: Strategy,
    readonly name: string,
  ) {}
  async step(phase: Phase) {
    const id = 1 + ((this.index * 7919) % this.count),
      n = 101 + (this.index % 20);
    this.index++;
    this.store.calls = [];
    if (phase === "snapshot") this.store.force = true;
    const start = performance.now();
    await this.db.execute("update", [BigInt(id), BigInt(n)]);
    const written = performance.now();
    const checkpoint = await this.db.checkpoint();
    const end = performance.now();
    if (!checkpoint.created)
      throw Error("benchmark mutation did not checkpoint");
    if (
      this.strategy !== "inline" &&
      (checkpoint.pages?.snapshot || checkpoint.pages?.written !== 2)
    )
      throw Error("benchmark left the incremental UPDATE path");
    const calls = [...this.store.calls];
    if (
      phase === "snapshot" &&
      calls.filter((c) => c.kind === "snapshot" || c.kind === "snapshot+pages")
        .length !== 1
    )
      throw Error("snapshot phase must compact once");
    this.mutations.push({ id, n });
    return {
      totalMs: end - start,
      writeMs: written - start,
      checkpointMs: end - written,
      providerMs: calls.reduce((n, c) => n + c.milliseconds, 0),
      publications: calls,
      head: checkpoint.head,
      pages: checkpoint.pages,
    };
  }
  async io(phase: Phase) {
    const observer = observeIdbRequests();
    let operation;
    let statistics;
    try {
      operation = await this.step(phase);
    } finally {
      statistics = observer.stop();
    }
    return { operation, statistics };
  }
  async verify() {
    const logical = await this.db.execute("verify");
    const files = [...this.archived, ...(await this.db.pending())].map((f) => ({
      ...f,
      data: toBase64(f.data),
    }));
    const sqlite = toBase64(await this.db.exportSQLite());
    const generation = (await this.store.read()).generation;
    await this.db.close();
    const raw =
      this.strategy !== "inline"
        ? await IndexedDbAotPageStore.open(this.name)
        : await MoonImageStore.open(this.name);
    this.db = await AotDatabase.withStore(this.artifact, this.hash, raw, {
      sqlitePages: this.strategy !== "inline",
    });
    const reopened = await this.db.execute("verify");
    if (
      JSON.stringify(logical.rows.map((r) => r.map(String))) !==
      JSON.stringify(reopened.rows.map((r) => r.map(String)))
    )
      throw Error("logical reopen changed rows");
    if ((await this.db.checkpoint()).created)
      throw Error("no-op after reopen wrote a checkpoint");
    const last = (await this.db.pending()).at(-1)!;
    await this.db.acknowledge(last.maxTXID, last.sha256);
    if ((await this.db.pending()).length)
      throw Error("outbox GC did not complete");
    if (
      this.strategy !== "inline" &&
      isAotPageImageStore(raw) &&
      (await raw.pages.head())?.files?.length
    )
      throw Error("page files survived ACK");
    await this.db.close();
    return {
      logical: logical.rows.map((r) => r.map(String)),
      files,
      sqlite,
      mutations: this.mutations,
      generation,
    };
  }
}
let bench: Bench | undefined;
export async function setup(url: string, strategy: Strategy, name: string) {
  const f: PagerIdbFixture = await (await fetch(url)).json();
  const raw =
    strategy !== "inline"
      ? await IndexedDbAotPageStore.open(name)
      : await MoonImageStore.open(name);
  await raw.commit(0, f.saved);
  const store = isAotPageImageStore(raw)
    ? new ObservedPageStore(
        raw,
        strategy === "pager-json",
        strategy === "pager-chunks",
        strategy === "pager-differential",
      )
    : new ObservedStore(raw);
  const db = await AotDatabase.withStore(f.artifact, f.hash, store, {
    sqlitePages: strategy !== "inline",
  });
  await db.checkpoint();
  bench = new Bench(f.count, store, db, f.artifact, f.hash, strategy, name);
  await bench.step("natural");
  await bench.step("snapshot");
}
export function step(phase: Phase) {
  if (!bench) throw Error("benchmark not open");
  return bench.step(phase);
}
export function io(phase: Phase) {
  if (!bench) throw Error("benchmark not open");
  return bench.io(phase);
}
export function verify() {
  if (!bench) throw Error("benchmark not open");
  return bench.verify();
}

/** Bounded, unmeasured preparation for a 64-mutation compaction window. */
export async function prepare(updates: number) {
  if (!bench || !Number.isInteger(updates) || updates < 1 || updates > 64)
    throw Error("invalid compaction window");
  await bench.archive();
  await bench.step("snapshot");
  for (let i = 1; i < updates; i++) await bench.step("natural");
}
