import { test } from "node:test";
import assert from "node:assert/strict";
import { LsmDatabase } from "../adapters/lsm-database.ts";
import type {
  LsmHead,
  LsmPublication,
  LsmStorage,
} from "../src/lsm-contract.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "./compatibility/native-values.ts";

export class MemoryLsmStorage implements LsmStorage {
  head: LsmHead = { generation: 0, wal: [] };
  blocks = new Map<string, Uint8Array>();
  failure?: "stage" | "publish" | "ack";
  reads = 0;
  async readHead() {
    return structuredClone(this.head);
  }
  async readBlock(id: string) {
    this.reads++;
    const value = this.blocks.get(id);
    if (!value) throw Error("missing block");
    return value.slice();
  }
  async stageBlock(id: string, value: Uint8Array) {
    if (this.failure === "stage") throw Error("stage failure");
    assert.ok(!this.blocks.has(id));
    this.blocks.set(id, value.slice());
  }
  async publish(expected: number, change: LsmPublication) {
    if (this.head.generation !== expected) throw Error("generation conflict");
    if (this.failure === "publish") throw Error("publication aborted");
    if (!change.resetWal && change.append && this.head.wal.length >= 128)
      throw Error("WAL resource limit");
    this.head = {
      generation: expected + 1,
      manifest: change.manifest ?? this.head.manifest,
      wal: change.resetWal ? [] : this.head.wal,
    };
    if (change.append)
      this.head.wal = [...this.head.wal, change.append.slice()];
    if (this.failure === "ack") throw Error("lost durable ACK");
    return this.head.generation;
  }
  close() {}
}
const text = (s: string) => new TextEncoder().encode(s);
const all = async (db: { scan(): AsyncIterable<[bigint, Uint8Array]> }) => {
  const rows: [bigint, Uint8Array][] = [];
  for await (const row of db.scan()) rows.push(row);
  return rows;
};
const options = {
  memtableBytes: 1024,
  blockBytes: 256,
  cacheBytes: 512,
  fanout: 2,
};

test("LSM matches native SQLite through tiered compactions, delete/reinsert and reopen", async () => {
  const storage = new MemoryLsmStorage();
  let db = await LsmDatabase.open(storage, options);
  const native = new NodeDatabase(":memory:");
  native.run("CREATE TABLE t(k INTEGER PRIMARY KEY,v BLOB)");
  let state = 7;
  const rand = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
  try {
    for (let step = 0; step < 360; step++) {
      const key =
        step === 0
          ? -9223372036854775808n
          : step === 1
            ? 9223372036854775807n
            : BigInt((rand() % 97) - 48);
      const value =
        rand() % 5 === 0 ? null : text(`${step}:${"🐕\0".repeat(rand() % 20)}`);
      if (value === null) native.run("DELETE FROM t WHERE k=?", [key]);
      else
        native.run(
          "INSERT INTO t VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
          [key, value],
        );
      await db.writeBatch([{ key, value }]);
      assert.deepEqual(
        await db.get(key),
        nativeValues(native, "SELECT v FROM t WHERE k=?", [key])[0]?.[0],
      );
      if (step % 31 === 0) {
        assert.deepEqual(
          await all(db),
          nativeValues(native, "SELECT k,v FROM t ORDER BY k"),
        );
        db.close();
        db = await LsmDatabase.open(storage, options);
      }
    }
    await db.compact();
    assert.deepEqual(
      await all(db),
      nativeValues(native, "SELECT k,v FROM t ORDER BY k"),
    );
    assert.ok(db.stats().compactions > 0);
    assert.ok(db.stats().cacheBytes <= options.cacheBytes);
    db.close();
    const reads = storage.reads;
    db = await LsmDatabase.open(storage, options);
    assert.equal(storage.reads, reads, "reopen must not load all SST blocks");
    assert.deepEqual(
      await all(db),
      nativeValues(native, "SELECT k,v FROM t ORDER BY k"),
    );
    const range = [];
    for await (const row of db.scan({ gte: -5n, lt: 6n })) range.push(row);
    assert.deepEqual(
      range,
      nativeValues(native, "SELECT k,v FROM t WHERE k>=-5 AND k<6 ORDER BY k"),
    );
  } finally {
    db.close();
    native.close();
  }
});

test("snapshots pin old runs; batch inputs/results are owned; tombstones survive partial merges", async () => {
  const store = new MemoryLsmStorage();
  const db = await LsmDatabase.open(store, options);
  const bytes = text("original");
  const writing = db.writeBatch([
    { key: 1n, value: bytes },
    { key: 2n, value: text("old") },
  ]);
  bytes.fill(0);
  await writing;
  await db.flush();
  const snapshot = db.snapshot();
  for (let i = 0; i < 30; i++) {
    await db.writeBatch([
      { key: 1n, value: null },
      { key: 2n, value: text(`new${i}`) },
      { key: BigInt(i + 10), value: new Uint8Array(120) },
    ]);
    await db.flush();
  }
  assert.equal(await db.get(1n), undefined);
  assert.deepEqual(await snapshot.get(1n), text("original"));
  await db.compact();
  assert.deepEqual(await snapshot.get(2n), text("old"));
  const result = (await db.get(2n))!;
  result.fill(0);
  assert.deepEqual(await db.get(2n), text("new29"));
  await db.writeBatch([
    { key: 1n, value: text("first") },
    { key: 1n, value: new Uint8Array() },
  ]);
  assert.deepEqual(await db.get(1n), new Uint8Array());
  assert.throws(() => db.close(), /snapshot/);
  snapshot.close();
  db.close();
});

test("stage/publication failures, lost ACKs, stale writers and corrupt blocks never partially publish", async () => {
  for (const failure of ["stage", "publish", "ack"] as const) {
    const store = new MemoryLsmStorage();
    const db = await LsmDatabase.open(store, options);
    await db.writeBatch([{ key: 1n, value: text("base") }]);
    await db.flush();
    await db.writeBatch([{ key: 1n, value: text("next") }]);
    store.failure = failure;
    await assert.rejects(db.flush());
    await assert.rejects(db.get(1n), /reopen/);
    db.close();
    store.failure = undefined;
    const reopened = await LsmDatabase.open(store, options);
    assert.deepEqual(await reopened.get(1n), text("next"));
    reopened.close();
  }
  const store = new MemoryLsmStorage();
  const a = await LsmDatabase.open(store, options),
    b = await LsmDatabase.open(store, options);
  await a.writeBatch([{ key: 7n, value: text("a") }]);
  await assert.rejects(
    b.writeBatch([{ key: 7n, value: text("b") }]),
    /conflict/,
  );
  a.close();
  b.close();
  const reopened = await LsmDatabase.open(store, options);
  assert.deepEqual(await reopened.get(7n), text("a"));
  await reopened.flush();
  reopened.close();
  const id = [...store.blocks.keys()].at(-1)!;
  store.blocks.get(id)![12] = store.blocks.get(id)![12]! ^ 1;
  const corrupt = await LsmDatabase.open(store, options);
  await assert.rejects(corrupt.get(7n), /checksum/);
  corrupt.close();
});

test("interrupted streaming compaction keeps the old manifest and atomic WAL batch recovery", async () => {
  const store = new MemoryLsmStorage();
  const db = await LsmDatabase.open(store, options);
  for (let i = 0; i < 30; i++)
    await db.writeBatch([
      { key: BigInt(i), value: new Uint8Array(100).fill(i) },
    ]);
  await db.flush();
  const expected = await all(db),
    old = store.head.manifest,
    blocks = store.blocks.size;
  store.failure = "publish";
  await assert.rejects(db.compact(), /aborted/);
  assert.equal(store.head.manifest, old);
  assert.ok(store.blocks.size > blocks, "new output is staged but invisible");
  db.close();
  store.failure = undefined;
  const restored = await LsmDatabase.open(store, options);
  assert.deepEqual(await all(restored), expected);
  store.failure = "ack";
  await assert.rejects(
    restored.writeBatch([
      { key: 1n, value: null },
      { key: 2n, value: text("atomic") },
    ]),
    /ACK/,
  );
  restored.close();
  store.failure = undefined;
  const recovered = await LsmDatabase.open(store, options);
  assert.equal(await recovered.get(1n), undefined);
  assert.deepEqual(await recovered.get(2n), text("atomic"));
  await assert.rejects(
    recovered.writeBatch([
      { key: 9223372036854775808n, value: text("invalid") },
    ]),
    /int64/,
  );
  await recovered.writeBatch([
    { key: 3n, value: text("valid after input error") },
  ]);
  const first = recovered.writeBatch([{ key: 4n, value: text("first") }]);
  await assert.rejects(
    recovered.writeBatch([{ key: 5n, value: text("concurrent") }]),
    /concurrent/,
  );
  await first;
  recovered.close();
});

test("a newer memtable hit, including a tombstone, avoids older SST reads", async () => {
  const store = new MemoryLsmStorage(),
    db = await LsmDatabase.open(store, options);
  await db.writeBatch([
    { key: 1n, value: text("old") },
    { key: 2n, value: text("old") },
  ]);
  await db.flush();
  await db.writeBatch([
    { key: 1n, value: text("new") },
    { key: 2n, value: null },
  ]);
  const reads = store.reads;
  assert.deepEqual(await db.get(1n), text("new"));
  assert.equal(await db.get(2n), undefined);
  assert.equal(store.reads, reads);
  db.close();
});

test("bounded range reads reuse the byte-budgeted block cache", async () => {
  const store = new MemoryLsmStorage(),
    db = await LsmDatabase.open(store, options);
  await db.writeBatch(
    Array.from({ length: 30 }, (_, i) => ({
      key: BigInt(i),
      value: new Uint8Array(20),
    })),
  );
  await db.flush();
  const range = async () => {
    for await (const _ of db.scan({ gte: 2n, lt: 5n })) {
    }
  };
  await range();
  const reads = store.reads;
  await range();
  assert.equal(store.reads, reads);
  assert.ok(db.stats().cacheBytes <= options.cacheBytes);
  db.close();
});

test("reopen can accept the next write after a crash at the WAL record limit", async () => {
  const store = new MemoryLsmStorage(),
    large = { ...options, memtableBytes: 1024 * 1024 };
  const db = await LsmDatabase.open(store, large);
  for (let i = 0; i < 127; i++)
    await db.writeBatch([{ key: 1n, value: text(String(i)) }]);
  store.failure = "stage";
  await assert.rejects(
    db.writeBatch([{ key: 1n, value: text("durable128") }]),
    /stage/,
  );
  assert.equal(store.head.wal.length, 128);
  db.close();
  store.failure = undefined;
  const restored = await LsmDatabase.open(store, large);
  await restored.writeBatch([{ key: 2n, value: text("next") }]);
  assert.deepEqual(await restored.get(1n), text("durable128"));
  assert.deepEqual(await restored.get(2n), text("next"));
  restored.close();
});
