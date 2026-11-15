import * as generated from "../_build/js/release/build/mizchi/sqlike/lsm/lsm.js";
import { LsmDatabase } from "../adapters/lsm-database.ts";
import { IndexedDbLsmStorage } from "../adapters/lsm-indexeddb.ts";
import { MoonImageStore } from "../adapters/moon-image-store.ts";
import { fromBase64, toBase64, sha256 } from "../src/aot-values.ts";
import type { Block, LsmCore } from "../src/lsm-core-contract.ts";
import type { ImageStore } from "../src/persistence-contract.ts";
import type { KvEdit, KvRange, LsmStorage } from "../src/lsm-contract.ts";
const core = generated as unknown as LsmCore;
function checked(block: Block) {
  const r = JSON.parse(core.lsm_info(block)) as { error?: string };
  if (r.error) throw Error(r.error);
  return block;
}
/** Benchmark-only reference: same MoonBit codec, latest-value merge and binary
 * batches as LSM, all rows retained in RAM, whole snapshot at ImageStore's
 * 128-record / 4-MiB threshold. This is not the production SQL engine. */
export class JournalKv {
  private constructor(
    private store: ImageStore,
    private generation: number,
    private block: Block,
  ) {}
  checkpoints = 0;
  private dirty = false;
  static async open(store: ImageStore) {
    const head = await store.read();
    let block =
      head.image === undefined
        ? core.lsm_new()
        : checked(core.lsm_decode(fromBase64(head.image)));
    for (const delta of head.deltas ?? []) {
      if (delta.text !== "lsm-kv-batch@1" || delta.blobs?.length !== 1)
        throw Error("invalid reference delta");
      block = checked(
        core.lsm_merge(block, checked(core.lsm_decode(delta.blobs[0]!))),
      );
    }
    const db = new JournalKv(store, head.generation, block);
    db.dirty = !!head.deltas?.length;
    return db;
  }
  async writeBatch(edits: readonly KvEdit[]) {
    if (!edits.length) return;
    const batch = core.lsm_new();
    for (const e of edits) {
      const r = JSON.parse(
        core.lsm_put(
          batch,
          String(e.key),
          this.generation + 1,
          e.value ?? new Uint8Array(),
          e.value === null,
        ),
      ) as { error?: string };
      if (r.error) throw Error(r.error);
    }
    const next = checked(core.lsm_merge(this.block, batch));
    if (this.generation === 0 || this.store.checkpointNeeded?.()) {
      this.generation = await this.store.commit(
        this.generation,
        toBase64(core.lsm_encode(next)),
      );
      this.checkpoints++;
    } else
      this.generation = await this.store.commitDelta!(this.generation, {
        text: "lsm-kv-batch@1",
        blobs: [core.lsm_encode(batch)],
      });
    this.block = next;
    this.dirty = true;
  }
  async get(key: bigint) {
    const i = core.lsm_seek(this.block, String(key));
    return i < core.lsm_count(this.block) &&
      core.lsm_key(this.block, i) === String(key) &&
      !core.lsm_deleted(this.block, i)
      ? core.lsm_value(this.block, i).slice()
      : undefined;
  }
  async *scan(range: KvRange = {}): AsyncGenerator<[bigint, Uint8Array]> {
    const block = this.block;
    for (
      let i =
        range.gte === undefined ? 0 : core.lsm_seek(block, String(range.gte));
      i < core.lsm_count(block);
      i++
    ) {
      const k = BigInt(core.lsm_key(block, i));
      if (range.lt !== undefined && k >= range.lt) return;
      if (!core.lsm_deleted(block, i))
        yield [k, core.lsm_value(block, i).slice()];
    }
  }
  async flush() {
    if (this.dirty) {
      this.generation = await this.store.commit(
        this.generation,
        toBase64(core.lsm_encode(this.block)),
      );
      this.checkpoints++;
      this.dirty = false;
    }
  }
  stats() {
    return {
      retainedEncodedBytes: core.lsm_size(this.block),
      checkpoints: this.checkpoints,
    };
  }
  close() {
    this.store.close();
  }
}
export function makeValue(
  id: number,
  size: number,
  n = 1000000 + id * 4,
): Uint8Array {
  const out = new Uint8Array(size + 8);
  new DataView(out.buffer).setBigInt64(0, BigInt(n), true);
  let state = id | 0;
  for (let i = 8; i < out.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) | 0;
    out[i] = (state >>> 16) & 255;
  }
  return out;
}
interface Counters {
  ioMs: number;
  readBytes: number;
  writeBytes: number;
  reads: number;
  writes: number;
  publications: number;
}
const zero = (): Counters => ({
  ioMs: 0,
  readBytes: 0,
  writeBytes: 0,
  reads: 0,
  writes: 0,
  publications: 0,
});
class Metrics {
  value = zero();
  async io<T>(call: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await call();
    } finally {
      this.value.ioMs += performance.now() - start;
    }
  }
  lsm(raw: LsmStorage): LsmStorage {
    return {
      close: () => raw.close(),
      readHead: () =>
        this.io(async () => {
          const r = await raw.readHead();
          this.value.reads++;
          return r;
        }),
      readBlock: (id) =>
        this.io(async () => {
          const b = await raw.readBlock(id);
          this.value.reads++;
          this.value.readBytes += b.length;
          return b;
        }),
      stageBlock: (id, bytes) =>
        this.io(async () => {
          await raw.stageBlock(id, bytes);
          this.value.writes++;
          this.value.writeBytes += bytes.length;
        }),
      publish: (expected, change) =>
        this.io(async () => {
          const g = await raw.publish(expected, change);
          this.value.publications++;
          this.value.writes +=
            1 + (change.append ? 1 : 0) + (change.manifest ? 1 : 0);
          this.value.writeBytes +=
            (change.append?.length ?? 0) + (change.manifest?.length ?? 0);
          return g;
        }),
    };
  }
  journal(raw: ImageStore): ImageStore {
    return {
      close: () => raw.close(),
      checkpointNeeded: () => raw.checkpointNeeded?.() ?? false,
      read: () => this.io(() => raw.read()),
      commit: (g, image) =>
        this.io(async () => {
          const n = await raw.commit(g, image);
          this.value.writes += 2;
          this.value.publications++;
          this.value.writeBytes += image.length;
          return n;
        }),
      commitDelta: (g, delta) =>
        this.io(async () => {
          const n = await raw.commitDelta!(g, delta);
          this.value.writes += 2;
          this.value.publications++;
          this.value.writeBytes +=
            delta.text.length +
            (delta.blobs ?? []).reduce((n, b) => n + b.length, 0);
          return n;
        }),
    };
  }
}
export interface LsmSample extends Counters {
  totalMs: number;
}
export type Strategy = "journal" | "lsm";
type Db = LsmDatabase | JournalKv;
class Runner {
  constructor(
    readonly strategy: Strategy,
    readonly rows: number,
    readonly width: number,
    private name: string,
    private db: Db,
    private metrics: Metrics,
  ) {}
  private async update(kind: "point" | "batch", turn: number) {
    const id = Math.floor(this.rows / 2),
      edits: KvEdit[] = [];
    for (let i = id; i < id + (kind === "point" ? 1 : 16); i++)
      edits.push({
        key: BigInt(i),
        value: makeValue(
          i,
          this.width,
          1000000 +
            i * 4 +
            (i === id ? 1 : 0) * (kind === "point" ? turn % 2 : 1) +
            (kind === "batch" ? (turn % 2 === 0 ? 1 : 0) : 0),
        ),
      });
    await this.db.writeBatch(edits);
  }
  async measure(
    kind: "point" | "batch" | "get" | "range",
    runs: number,
    iterations: number,
  ) {
    const samples: LsmSample[][] = [];
    const call = async (turn: number) => {
      if (kind === "point" || kind === "batch") await this.update(kind, turn);
      else if (kind === "get") {
        // Vary keys across the whole data set, including cold blocks.
        const bytes = await this.db.get(
          BigInt(1 + ((turn * 7919) % this.rows)),
        );
        if (!bytes || bytes.length !== this.width + 8)
          throw Error("point lookup mismatch");
      } else {
        let count = 0;
        const id = 1 + ((turn * 97) % (this.rows - 16));
        for await (const [k, value] of this.db.scan({
          gte: BigInt(id),
          lt: BigInt(id + 16),
        })) {
          if (k !== BigInt(id + count) || value.length !== this.width + 8)
            throw Error("range mismatch");
          count++;
        }
        if (count !== 16) throw Error("missing range rows");
      }
    };
    for (let i = 0; i < 2; i++) await call(i);
    let turn = 2;
    for (let run = 0; run < runs; run++) {
      const list: LsmSample[] = [];
      for (let i = 0; i < iterations; i++) {
        this.metrics.value = zero();
        const repetitions = kind === "get" ? 16 : 1,
          start = performance.now();
        for (let repeat = 0; repeat < repetitions; repeat++) await call(turn++);
        const totalMs = (performance.now() - start) / repetitions;
        const counters = Object.fromEntries(
          Object.entries(this.metrics.value).map(([k, v]) => [
            k,
            v / repetitions,
          ]),
        ) as unknown as Counters;
        list.push({ totalMs, ...counters });
      }
      samples.push(list);
    }
    return samples;
  }
  async digest() {
    const rows = [];
    for await (const [k, v] of this.db.scan())
      rows.push([
        String(k),
        String(new DataView(v.buffer, v.byteOffset, 8).getBigInt64(0, true)),
        toBase64(v.subarray(8)),
      ]);
    return sha256(JSON.stringify(rows));
  }
  async reopen() {
    const before = await this.digest();
    this.db.close();
    const start = performance.now();
    this.db = await open(this.strategy, this.name, this.metrics);
    const ms = performance.now() - start;
    if ((await this.digest()) !== before) throw Error("reopen/replay mismatch");
    return ms;
  }
  async drain() {
    const start = performance.now();
    await this.db.flush();
    return performance.now() - start;
  }
  stats() {
    return this.db.stats();
  }
  async disk() {
    if (this.strategy !== "lsm") return undefined;
    const raw = await IndexedDbLsmStorage.open(this.name);
    try {
      return await raw.diagnostics();
    } finally {
      raw.close();
    }
  }
  close() {
    this.db.close();
  }
}
async function open(
  strategy: Strategy,
  name: string,
  metrics: Metrics,
): Promise<Db> {
  return strategy === "lsm"
    ? LsmDatabase.open(metrics.lsm(await IndexedDbLsmStorage.open(name)))
    : JournalKv.open(metrics.journal(await MoonImageStore.open(name)));
}
export async function setup(
  strategy: Strategy,
  rows: number,
  width: number,
  name: string,
) {
  const metrics = new Metrics(),
    db = await open(strategy, name, metrics);
  for (let start = 1; start <= rows; start += 100) {
    const edits: KvEdit[] = [];
    for (let i = start; i < Math.min(start + 100, rows + 1); i++)
      edits.push({ key: BigInt(i), value: makeValue(i, width) });
    await db.writeBatch(edits);
  }
  await db.flush();
  window.lsmBench = new Runner(strategy, rows, width, name, db, metrics);
}
declare global {
  interface Window {
    lsmBench: Runner;
  }
}
