import * as generated from "../_build/js/release/build/mizchi/sqlike/lsm/lsm.js";
import type { Block, LsmCore } from "../src/lsm-core-contract.ts";
const core = generated as unknown as LsmCore;
import type {
  KvEdit,
  KvRange,
  KvSnapshot,
  OrderedKv,
  LsmStorage,
} from "../src/lsm-contract.ts";

interface BlockIndex {
  id: string;
  first: string;
  last: string;
  bytes: number;
  count: number;
}
interface Run {
  level: number;
  blocks: BlockIndex[];
}
interface Manifest {
  format: "sqlike-lsm@1";
  runs: Run[];
}
export interface LsmOptions {
  memtableBytes?: number;
  blockBytes?: number;
  cacheBytes?: number;
  fanout?: number;
}
const MIN_KEY = -9223372036854775808n,
  MAX_KEY = 9223372036854775807n;
const MAX_BATCH = 1024 * 1024;
const EMPTY: Manifest = { format: "sqlike-lsm@1", runs: [] };
function key(value: bigint): string {
  if (typeof value !== "bigint" || value < MIN_KEY || value > MAX_KEY)
    throw Error("key must be signed int64");
  return String(value);
}
function checked(block: Block): Block {
  const result = JSON.parse(core.lsm_info(block)) as { error?: string };
  if (result.error) throw Error(result.error);
  return block;
}
function result(text: string): void {
  const result = JSON.parse(text) as { error?: string };
  if (result.error) throw Error(result.error);
}
function integer(n: unknown, min: number, max: number): n is number {
  return (
    Number.isSafeInteger(n) && (n as number) >= min && (n as number) <= max
  );
}
function manifest(text: string | undefined): Manifest {
  if (text === undefined) return EMPTY;
  if (text.length > 16 * 1024 * 1024) throw Error("manifest resource limit");
  const m = JSON.parse(text) as Manifest;
  if (
    m?.format !== "sqlike-lsm@1" ||
    !Array.isArray(m.runs) ||
    m.runs.length > 256
  )
    throw Error("invalid manifest");
  const ids = new Set<string>();
  let count = 0;
  for (const run of m.runs) {
    if (
      !integer(run.level, 0, 31) ||
      !Array.isArray(run.blocks) ||
      !run.blocks.length
    )
      throw Error("invalid run");
    let previous: bigint | undefined;
    for (const b of run.blocks) {
      if (
        ++count > 65536 ||
        typeof b.id !== "string" ||
        !/^[0-9a-f-]{36}$/.test(b.id) ||
        ids.has(b.id) ||
        !integer(b.bytes, 28, 4 * 1024 * 1024) ||
        !integer(b.count, 1, 65536)
      )
        throw Error("invalid block index");
      const first = BigInt(b.first),
        last = BigInt(b.last);
      if (
        key(first) !== b.first ||
        key(last) !== b.last ||
        first > last ||
        (previous !== undefined && previous >= first)
      )
        throw Error("unordered block index");
      previous = last;
      ids.add(b.id);
    }
  }
  return m;
}
function manifestText(root: Manifest): string {
  const text = JSON.stringify(root);
  if (
    root.runs.length > 256 ||
    root.runs.reduce((n, r) => n + r.blocks.length, 0) > 65536 ||
    text.length > 16 * 1024 * 1024
  )
    throw Error("manifest resource limit");
  return text;
}
interface Entry {
  key: bigint;
  sequence: number;
  deleted: boolean;
  value: Uint8Array;
}
interface Cursor {
  block: Block;
  position: number;
  next(): Promise<boolean>;
}
function entry(c: Cursor): Entry {
  return {
    key: BigInt(core.lsm_key(c.block, c.position)),
    sequence: core.lsm_sequence(c.block, c.position),
    deleted: core.lsm_deleted(c.block, c.position),
    value: core.lsm_value(c.block, c.position),
  };
}

/** Separate experimental KV, not wired into the SQL executor. The MoonBit
 * package owns sorted blocks/merging/codec; this host owns async IO and run
 * scheduling. Old manifests/blocks are immutable and retained for snapshots. */
export class LsmDatabase implements OrderedKv {
  private mem = core.lsm_new();
  private cache = new Map<string, Block>();
  private cacheSize = 0;
  private walBytes = 0;
  private walCount = 0;
  private failed = false;
  private closed = false;
  private busy = false;
  private pins = 0;
  private counters = {
    flushes: 0,
    compactions: 0,
    readBlocks: 0,
    readBytes: 0,
    stagedBytes: 0,
  };
  readonly options: Required<LsmOptions>;
  private constructor(
    private storage: LsmStorage,
    private generation: number,
    private root: Manifest,
    options: LsmOptions,
  ) {
    this.options = {
      memtableBytes: options.memtableBytes ?? 64 * 1024,
      blockBytes: options.blockBytes ?? 16 * 1024,
      cacheBytes: options.cacheBytes ?? 256 * 1024,
      fanout: options.fanout ?? 4,
    };
    if (
      !integer(this.options.memtableBytes, 1024, MAX_BATCH) ||
      !integer(this.options.blockBytes, 256, 65536) ||
      !integer(this.options.cacheBytes, 0, 16 * MAX_BATCH) ||
      !integer(this.options.fanout, 2, 8)
    )
      throw Error("invalid LSM options");
  }
  static async open(
    storage: LsmStorage,
    options: LsmOptions = {},
  ): Promise<LsmDatabase> {
    const head = await storage.readHead();
    if (
      !integer(head.generation, 0, 2147483646) ||
      !Array.isArray(head.wal) ||
      head.wal.length > 128
    )
      throw Error("invalid LSM head");
    const db = new LsmDatabase(
      storage,
      head.generation,
      manifest(head.manifest),
      options,
    );
    let previous = 0;
    for (const bytes of head.wal) {
      if (!(bytes instanceof Uint8Array) || bytes.length > MAX_BATCH)
        throw Error("invalid WAL batch");
      db.walBytes += bytes.length;
      if (db.walBytes > 2 * MAX_BATCH) throw Error("WAL resource limit");
      const block = checked(core.lsm_decode(bytes));
      if (!core.lsm_count(block)) throw Error("empty WAL batch");
      const seq = core.lsm_sequence(block, 0);
      if (seq <= previous || seq > head.generation)
        throw Error("unordered WAL sequence");
      for (let i = 1; i < core.lsm_count(block); i++)
        if (core.lsm_sequence(block, i) !== seq)
          throw Error("mixed WAL sequence");
      previous = seq;
      db.mem = checked(core.lsm_merge(db.mem, block));
      db.walCount++;
    }
    return db;
  }
  private healthy() {
    if (this.closed) throw Error("LSM database closed");
    if (this.failed) throw Error("uncertain LSM state; reopen required");
  }
  private async mutation(action: () => Promise<void>) {
    this.healthy();
    if (this.busy) throw Error("concurrent LSM mutation");
    this.busy = true;
    try {
      await action();
    } catch (e) {
      this.failed = true;
      throw e;
    } finally {
      this.busy = false;
    }
  }
  private async publish(change: Parameters<LsmStorage["publish"]>[1]) {
    const generation = await this.storage.publish(this.generation, change);
    if (generation !== this.generation + 1 || generation > 2147483646)
      throw Error("invalid durable generation ACK");
    this.generation = generation;
  }
  async writeBatch(edits: readonly KvEdit[]): Promise<void> {
    this.healthy();
    if (this.busy) throw Error("concurrent LSM mutation");
    if (!edits.length) return;
    if (edits.length > 65536 || this.generation >= 2147483645)
      throw Error("batch/generation resource limit");
    // Capture caller-owned buffers before the first await. Duplicate keys use
    // the last after-image in this atomic batch.
    let batch = core.lsm_new();
    for (const edit of edits) {
      if (edit.value !== null && !(edit.value instanceof Uint8Array))
        throw Error("invalid KV value");
      result(
        core.lsm_put(
          batch,
          key(edit.key),
          this.generation + 1,
          edit.value ?? new Uint8Array(),
          edit.value === null,
        ),
      );
    }
    let bytes = core.lsm_encode(batch);
    if (bytes.length > MAX_BATCH) throw Error("batch exceeds 1 MiB");
    await this.mutation(async () => {
      // A previous writer may have durably filled the WAL and crashed before
      // flushing. Drain it before appending, without exceeding provider limits.
      if (
        this.walCount >= 128 ||
        this.walBytes >= this.options.memtableBytes ||
        core.lsm_size(this.mem) >= this.options.memtableBytes
      ) {
        await this.flushInternal();
        await this.compactTiers();
        const old = batch;
        batch = core.lsm_new();
        for (let i = 0; i < core.lsm_count(old); i++)
          result(
            core.lsm_put(
              batch,
              core.lsm_key(old, i),
              this.generation + 1,
              core.lsm_value(old, i),
              core.lsm_deleted(old, i),
            ),
          );
        bytes = core.lsm_encode(batch);
      }
      const next = checked(core.lsm_merge(this.mem, batch));
      await this.publish({ append: bytes });
      this.mem = next;
      this.walBytes += bytes.length;
      this.walCount++;
      if (
        core.lsm_size(this.mem) >= this.options.memtableBytes ||
        this.walBytes >= this.options.memtableBytes ||
        this.walCount >= 128
      )
        await this.flushInternal();
      await this.compactTiers();
    });
  }
  async flush(): Promise<void> {
    await this.mutation(async () => {
      await this.flushInternal();
      await this.compactTiers();
    });
  }
  /** Merge all current runs and drop tombstones. Pinned snapshots retain their
   * old immutable files; physical reclamation is not part of this experiment. */
  async compact(): Promise<void> {
    await this.mutation(async () => {
      await this.flushInternal();
      if (this.root.runs.length) await this.mergeRuns(this.root.runs, 0, true);
    });
  }
  private async stage(block: Block): Promise<BlockIndex> {
    const data = core.lsm_encode(block),
      count = core.lsm_count(block),
      id = crypto.randomUUID();
    await this.storage.stageBlock(id, data);
    this.counters.stagedBytes += data.length;
    return {
      id,
      bytes: data.length,
      count,
      first: core.lsm_key(block, 0),
      last: core.lsm_key(block, count - 1),
    };
  }
  private async flushInternal() {
    const count = core.lsm_count(this.mem);
    if (!count) return;
    const blocks: BlockIndex[] = [];
    let from = 0,
      bytes = 12;
    for (let i = 0; i < count; i++) {
      const size = 16 + core.lsm_value(this.mem, i).length;
      if (i > from && bytes + size > this.options.blockBytes) {
        blocks.push(await this.stage(core.lsm_slice(this.mem, from, i - from)));
        from = i;
        bytes = 12;
      }
      bytes += size;
    }
    blocks.push(await this.stage(core.lsm_slice(this.mem, from, count - from)));
    const root: Manifest = {
      format: "sqlike-lsm@1",
      runs: [...this.root.runs, { level: 0, blocks }],
    };
    await this.publish({ manifest: manifestText(root), resetWal: true });
    this.root = root;
    this.mem = core.lsm_new();
    this.walBytes = 0;
    this.walCount = 0;
    this.counters.flushes++;
  }
  private async compactTiers() {
    for (let level = 0; level < 31; level++) {
      let runs = this.root.runs.filter((run) => run.level === level);
      while (runs.length >= this.options.fanout) {
        await this.mergeRuns(
          runs.slice(0, this.options.fanout),
          level + 1,
          false,
        );
        runs = this.root.runs.filter((run) => run.level === level);
      }
    }
  }
  private async mergeRuns(runs: Run[], level: number, dropDeletes: boolean) {
    const blocks: BlockIndex[] = [];
    let block = core.lsm_new();
    for await (const e of this.merge(runs, undefined, {}, false)) {
      if (dropDeletes && e.deleted) continue;
      const size = 16 + e.value.length;
      if (
        core.lsm_count(block) &&
        core.lsm_size(block) + size > this.options.blockBytes
      ) {
        blocks.push(await this.stage(block));
        block = core.lsm_new();
      }
      result(
        core.lsm_put(block, String(e.key), e.sequence, e.value, e.deleted),
      );
    }
    if (core.lsm_count(block)) blocks.push(await this.stage(block));
    const root: Manifest = {
      format: "sqlike-lsm@1",
      runs: this.root.runs.filter((r) => !runs.includes(r)),
    };
    if (blocks.length) root.runs.push({ level, blocks });
    await this.publish({ manifest: manifestText(root) });
    this.root = root;
    this.counters.compactions++;
  }
  private async load(index: BlockIndex, cached: boolean): Promise<Block> {
    const hit = this.cache.get(index.id);
    if (hit) {
      this.cache.delete(index.id);
      this.cache.set(index.id, hit);
      return hit;
    }
    const data = await this.storage.readBlock(index.id);
    this.counters.readBlocks++;
    this.counters.readBytes += data.length;
    const block = checked(core.lsm_decode(data));
    const count = core.lsm_count(block);
    if (
      data.length !== index.bytes ||
      count !== index.count ||
      core.lsm_key(block, 0) !== index.first ||
      core.lsm_key(block, count - 1) !== index.last
    )
      throw Error("block index mismatch");
    for (let i = 0; i < count; i++)
      if (core.lsm_sequence(block, i) > this.generation)
        throw Error("future block sequence");
    if (cached && index.bytes <= this.options.cacheBytes) {
      // A second read may have filled this entry while the first awaited IO.
      const existing = this.cache.get(index.id);
      if (existing) {
        this.cacheSize -= core.lsm_size(existing);
        this.cache.delete(index.id);
      }
      while (this.cacheSize + index.bytes > this.options.cacheBytes) {
        const first = this.cache.keys().next().value!;
        this.cacheSize -= core.lsm_size(this.cache.get(first)!);
        this.cache.delete(first);
      }
      this.cache.set(index.id, block);
      this.cacheSize += index.bytes;
    }
    return block;
  }
  private async cursor(
    run: Run,
    range: KvRange,
    cached: boolean,
  ): Promise<Cursor | undefined> {
    let i = 0;
    // Sparse block index: binary search skips preceding blocks.
    if (range.gte !== undefined) {
      let hi = run.blocks.length;
      while (i < hi) {
        const mid = (i + hi) >>> 1;
        if (BigInt(run.blocks[mid]!.last) < range.gte) i = mid + 1;
        else hi = mid;
      }
    }
    if (
      i >= run.blocks.length ||
      (range.lt !== undefined && BigInt(run.blocks[i]!.first) >= range.lt)
    )
      return;
    const c: Cursor = {
      block: await this.load(run.blocks[i]!, cached),
      position: 0,
      next: async () => {
        c.position++;
        if (c.position < core.lsm_count(c.block)) return true;
        i++;
        if (
          i >= run.blocks.length ||
          (range.lt !== undefined && BigInt(run.blocks[i]!.first) >= range.lt)
        )
          return false;
        c.block = await this.load(run.blocks[i]!, cached);
        c.position = 0;
        return true;
      },
    };
    if (range.gte !== undefined)
      c.position = core.lsm_seek(c.block, String(range.gte));
    return c;
  }
  private async *merge(
    runs: Run[],
    mem: Block | undefined,
    range: KvRange,
    cached: boolean,
  ): AsyncGenerator<Entry> {
    const cursors: Cursor[] = [];
    if (mem && core.lsm_count(mem)) {
      const c: Cursor = {
        block: mem,
        position:
          range.gte === undefined ? 0 : core.lsm_seek(mem, String(range.gte)),
        next: async () => ++c.position < core.lsm_count(c.block),
      };
      if (c.position < core.lsm_count(mem)) cursors.push(c);
    }
    // Sequential IO avoids simultaneously materializing all requested raw blocks.
    for (const run of runs) {
      const c = await this.cursor(run, range, cached);
      if (c) cursors.push(c);
    }
    while (cursors.length) {
      let winner = entry(cursors[0]!);
      for (let i = 1; i < cursors.length; i++) {
        const e = entry(cursors[i]!);
        if (
          e.key < winner.key ||
          (e.key === winner.key && e.sequence > winner.sequence)
        )
          winner = e;
      }
      if (range.lt !== undefined && winner.key >= range.lt) return;
      for (let i = cursors.length - 1; i >= 0; i--) {
        const c = cursors[i]!,
          e = entry(c);
        if (e.key !== winner.key) continue;
        if (
          e.sequence === winner.sequence &&
          (e.deleted !== winner.deleted || !equal(e.value, winner.value))
        )
          throw Error("conflicting equal sequence");
        if (!(await c.next())) cursors.splice(i, 1);
      }
      yield winner;
    }
  }
  snapshot(): KvSnapshot {
    this.healthy();
    const root = this.root,
      mem = this.mem;
    this.pins++;
    let closed = false;
    const healthy = () => {
      this.healthy();
      if (closed) throw Error("snapshot closed");
    };
    const scan = async function* (
      db: LsmDatabase,
      range: KvRange = {},
    ): AsyncGenerator<[bigint, Uint8Array]> {
      healthy();
      if (range.gte !== undefined) key(range.gte);
      if (range.lt !== undefined) key(range.lt);
      // Unbounded verification/export scans bypass cache insertion; bounded
      // application scans share the same byte-budgeted LRU as point lookups.
      for await (const e of db.merge(
        root.runs,
        mem,
        range,
        range.gte !== undefined || range.lt !== undefined,
      )) {
        healthy();
        if (!e.deleted) yield [e.key, e.value.slice()];
      }
    };
    return {
      get: async (k) => {
        healthy();
        key(k);
        const inspect = (b: Block): Entry | undefined => {
          const i = core.lsm_seek(b, String(k));
          if (i < core.lsm_count(b) && core.lsm_key(b, i) === String(k)) {
            return entry({ block: b, position: i, next: async () => false });
          }
        };
        let best = inspect(mem);
        // WAL sequence numbers are newer than every run in this captured root.
        if (best) return best.deleted ? undefined : best.value.slice();
        for (const run of root.runs) {
          let lo = 0,
            hi = run.blocks.length;
          while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (BigInt(run.blocks[mid]!.last) < k) lo = mid + 1;
            else hi = mid;
          }
          const index = run.blocks[lo];
          if (index && BigInt(index.first) <= k) {
            const e = inspect(await this.load(index, true));
            if (e && (!best || e.sequence > best.sequence)) best = e;
            else if (
              e &&
              best &&
              e.sequence === best.sequence &&
              (e.deleted !== best.deleted || !equal(e.value, best.value))
            )
              throw Error("conflicting equal sequence");
          }
        }
        healthy();
        return best && !best.deleted ? best.value.slice() : undefined;
      },
      scan: (range) => scan(this, range),
      close: () => {
        if (!closed) {
          closed = true;
          this.pins--;
        }
      },
    };
  }
  async get(k: bigint): Promise<Uint8Array | undefined> {
    const s = this.snapshot();
    try {
      return await s.get(k);
    } finally {
      s.close();
    }
  }
  async *scan(range?: KvRange): AsyncGenerator<[bigint, Uint8Array]> {
    const s = this.snapshot();
    try {
      yield* s.scan(range);
    } finally {
      s.close();
    }
  }
  stats() {
    const blocks = this.root.runs.flatMap((r) => r.blocks);
    return {
      ...this.counters,
      generation: this.generation,
      memtableBytes: core.lsm_size(this.mem),
      walBytes: this.walBytes,
      walRecords: this.walCount,
      cacheBytes: this.cacheSize,
      cachedBlocks: this.cache.size,
      runs: this.root.runs.length,
      levels: [...new Set(this.root.runs.map((r) => r.level))].sort(),
      liveBlocks: blocks.length,
      liveRunBytes: blocks.reduce((n, b) => n + b.bytes, 0),
      manifestBytes: JSON.stringify(this.root).length,
    };
  }
  close(): void {
    if (this.pins) throw Error("close active snapshots first");
    if (this.busy) throw Error("concurrent LSM mutation");
    if (!this.closed) {
      this.closed = true;
      this.cache.clear();
      this.mem = core.lsm_new();
      this.storage.close();
    }
  }
}
function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
