import * as runtime from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import { AotDatabase, type AotImageStore } from "../adapters/aot-database.ts";
import {
  MoonImageStore,
  type ImageDelta,
} from "../adapters/moon-image-store.ts";
import { pageDelta, applyPageDelta } from "../adapters/page-delta.ts";
import {
  aotBindings,
  fromBase64,
  toBase64,
  sha256,
} from "../src/aot-values.ts";
import type { ImageStore } from "../src/persistence-contract.ts";
import type { Value } from "../src/contract.ts";

export type Strategy = "snapshot" | "semantic" | "pages";
export interface PersistenceFixture {
  artifact: string;
  artifactHash: string;
  image: string;
  sqlite: string;
  programId: string;
  emptyHash: string;
  rows: number;
  payload: number;
  id: number;
}
interface Sample {
  totalMs: number;
  prepareMs: number;
  idbMs: number;
  bytes: number;
  records: number;
  kind: string;
}
class ObservedStore implements AotImageStore {
  start = 0;
  latest: Omit<Sample, "totalMs"> = {
    prepareMs: 0,
    idbMs: 0,
    bytes: 0,
    records: 0,
    kind: "",
  };
  hold = false;
  held = false;
  forceCheckpoint = false;
  release?: () => void;
  commitDelta?: (expected: number, delta: ImageDelta) => Promise<number>;
  constructor(
    readonly raw: ImageStore,
    incremental: boolean,
  ) {
    if (incremental)
      this.commitDelta = (expected, delta) => this.write(expected, delta);
  }
  read() {
    return this.raw.read();
  }
  checkpointNeeded() {
    return this.forceCheckpoint || (this.raw.checkpointNeeded?.() ?? false);
  }
  close() {
    this.raw.close();
  }
  commit(expected: number, image: string) {
    return this.write(expected, image);
  }
  private async write(expected: number, data: string | ImageDelta) {
    const prepareMs = performance.now() - this.start;
    if (this.hold) {
      this.held = true;
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
      this.held = false;
      this.hold = false;
    }
    const start = performance.now();
    const result =
      typeof data === "string"
        ? await this.raw.commit(expected, data)
        : await this.raw.commitDelta!(expected, data);
    const idbMs = performance.now() - start;
    // Fixtures and generated metadata are ASCII. Avoid a second full encoding
    // in measured regions just to instrument payload size.
    const bytes =
      typeof data === "string"
        ? data.length
        : data.text.length +
          (data.blobs ?? []).reduce((n, b) => n + b.length, 0);
    this.latest = {
      prepareMs,
      idbMs,
      bytes,
      records: 2,
      kind: typeof data === "string" ? "checkpoint" : "delta",
    };
    this.forceCheckpoint = false;
    return result;
  }
}
function check<T extends { error?: string }>(text: string): T {
  const result = JSON.parse(text) as T;
  if (result.error) throw Error(result.error);
  return result;
}
class PageDatabase {
  constructor(
    private handle: ReturnType<typeof runtime.aot_open>,
    private store: ObservedStore,
    private generation: number,
    private image: Uint8Array,
  ) {}
  async execute(name: string, values: bigint[]) {
    const candidate = runtime.aot_clone(this.handle);
    check(runtime.aot_execute(candidate, name, aotBindings(values)));
    const sql = runtime.aot_export_sqlite(candidate);
    check(runtime.sqlite_info(sql));
    const image = runtime.sqlite_data(sql);
    const delta = pageDelta(this.image, image, 4096);
    // Compaction follows the same record/byte thresholds as semantic storage.
    if (this.store.checkpointNeeded())
      this.generation = await this.store.commit(
        this.generation,
        JSON.stringify({ format: "pages@1", data: toBase64(image) }),
      );
    else
      this.generation = await this.store.commitDelta!(this.generation, delta);
    this.handle = candidate;
    this.image = image;
  }
  query() {
    return check<{ error?: string; rows: unknown }>(
      runtime.aot_execute(this.handle, "scan", "[]"),
    ).rows;
  }
  async verifyPersistence() {
    const persisted = await this.store.read();
    const saved = JSON.parse(persisted.image!) as {
      format: string;
      data: string;
    };
    if (saved.format !== "pages@1") throw Error("invalid page checkpoint");
    let image: Uint8Array = fromBase64(saved.data);
    for (const delta of persisted.deltas ?? [])
      image = applyPageDelta(image, delta);
    if ((await sha256(image)) !== (await sha256(this.image)))
      throw Error("page replay mismatch");
    return toBase64(image);
  }
  close() {
    this.store.close();
  }
}
class Runner {
  private probe?: Promise<void>;
  private turn = 0;
  constructor(
    readonly strategy: Strategy,
    readonly id: number,
    private store: ObservedStore,
    private db: AotDatabase | PageDatabase,
    private artifact: string,
    private artifactHash: string,
    private name: string,
  ) {}
  private async update(name: "point" | "batch") {
    const value = BigInt(1000000 + this.id * 4 + (this.turn % 2));
    const args =
      name === "point"
        ? [value, BigInt(this.id)]
        : [
            this.turn % 2 === 0 ? 1n : -1n,
            BigInt(this.id),
            BigInt(this.id + 16),
          ];
    this.turn++;
    await this.db.execute(name, args);
  }
  async measure(name: "point" | "batch", runs: number, iterations: number, warmup = 2) {
    this.turn = 0;
    for (let i = 0; i < warmup; i++) await this.update(name);
    const samples: Sample[][] = [];
    for (let run = 0; run < runs; run++) {
      const list: Sample[] = [];
      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        this.store.start = start;
        await this.update(name);
        list.push({ totalMs: performance.now() - start, ...this.store.latest });
      }
      samples.push(list);
    }
    return samples;
  }
  async verify() {
    const rows =
      this.db instanceof PageDatabase
        ? this.db.query()
        : (await this.db.execute("scan")).rows;
    const normalized = JSON.stringify(rows, (_, value) =>
      typeof value === "bigint"
        ? { t: "integer", v: String(value) }
        : typeof value === "string"
          ? value
          : value,
    );
    // Normalize both paths through Cell arrays, independent of JS BigInt ABI.
    const cells =
      this.db instanceof PageDatabase
        ? rows
        : (rows as Value[][]).map((row) =>
            JSON.parse(aotBindings(row)),
          );
    const digest = await sha256(JSON.stringify(cells));
    let sqlite: string | undefined;
    if (this.db instanceof PageDatabase)
      sqlite = await this.db.verifyPersistence();
    else {
      await this.db.close();
      this.store = new ObservedStore(
        await MoonImageStore.open(this.name),
        this.strategy !== "snapshot",
      );
      this.db = await AotDatabase.withStore(
        this.artifact,
        this.artifactHash,
        this.store,
      );
      const after = await this.db.execute("scan");
      if (
        (await sha256(
          JSON.stringify(after.rows.map((row) => JSON.parse(aotBindings(row)))),
        )) !== digest
      )
        throw Error("semantic replay mismatch");
    }
    return { digest, sqlite, normalizedCharacters: normalized.length };
  }
  preparePeak() {
    // Match checkpoint phase across journal versions. This is only the untimed
    // memory probe; timed workloads retain their natural compaction schedule.
    this.store.forceCheckpoint = true;
  }
  startProbe() {
    this.store.hold = true;
    this.store.start = performance.now();
    this.probe = this.update("point");
  }
  get held() {
    return this.store.held;
  }
  async releaseProbe() {
    this.store.release?.();
    await this.probe;
    this.probe = undefined;
  }
  async close() {
    await this.db.close();
  }
}
export async function setup(
  strategy: Strategy,
  fixtureURL: string,
  name: string,
) {
  const f = (await (await fetch(fixtureURL)).json()) as PersistenceFixture;
  const raw = await MoonImageStore.open(name),
    store = new ObservedStore(raw, strategy !== "snapshot");
  let db: AotDatabase | PageDatabase;
  if (strategy === "pages") {
    const image = fromBase64(f.sqlite);
    await raw.commit(0, JSON.stringify({ format: "pages@1", data: f.sqlite }));
    const handle = runtime.aot_open(f.artifact, f.image);
    check(runtime.aot_info(handle));
    db = new PageDatabase(handle, store, 1, image);
  } else {
    await raw.commit(
      0,
      JSON.stringify({
        format: "moon-aot-store@1",
        programId: f.programId,
        image: f.image,
        head: "0",
        acked: "0",
        checkpointSerial: -1,
        base: "",
        baseHash: f.emptyHash,
        pending: [],
      }),
    );
    db = await AotDatabase.withStore(f.artifact, f.artifactHash, store);
  }
  window.persistenceBench = new Runner(
    strategy,
    f.id,
    store,
    db,
    f.artifact,
    f.artifactHash,
    name,
  );
}
declare global {
  interface Window {
    persistenceBench: Runner;
  }
}
