import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import { AotDatabase, type AotImageStore } from "../adapters/aot-database.ts";
import type { ImageDelta } from "../adapters/moon-image-store.ts";
class Store implements AotImageStore {
  generation = 0;
  image?: string;
  fault: "before" | "after" | undefined;
  async read() {
    return { generation: this.generation, image: this.image };
  }
  async commit(expected: number, image: string) {
    if (expected !== this.generation) throw Error("stale image");
    if (this.fault === "before") {
      this.fault = undefined;
      throw Error("aborted");
    }
    this.image = image;
    this.generation++;
    if (this.fault === "after") {
      this.fault = undefined;
      throw Error("commit outcome uncertain");
    }
    return this.generation;
  }
  close() {}
}
const built = buildCatalog({
  schema: ["CREATE TABLE notes(id INTEGER PRIMARY KEY,title TEXT NOT NULL)"],
  queries: [
    { name: "add", sql: "INSERT INTO notes VALUES(?,?)" },
    { name: "list", sql: "SELECT id,title FROM notes ORDER BY id" },
    { name: "real", sql: "SELECT typeof(?),?" },
  ],
});
const open = (store: Store) =>
  AotDatabase.withStore(built.artifact, built.manifest.artifactSHA256, store);

test("trigger after-images replay once after durable ACK loss and checkpoint recovery", async () => {
  const built = buildCatalog({
    schema: [
      "CREATE TABLE notes(id INTEGER PRIMARY KEY,title TEXT)",
      "CREATE TABLE audit(id INTEGER PRIMARY KEY,note_id INTEGER,title TEXT)",
      "CREATE TRIGGER ai AFTER INSERT ON notes BEGIN INSERT INTO audit(note_id,title) VALUES(new.id,new.title); END",
    ],
    queries: [
      { name: "add", sql: "INSERT INTO notes VALUES(?,?)" },
      { name: "log", sql: "SELECT note_id,title FROM audit ORDER BY id" },
    ],
  });
  const store = new JournalStore();
  const open = () =>
    AotDatabase.withStore(built.artifact, built.manifest.artifactSHA256, store);
  let db = await open();
  await db.execute("add", [1n, "one"]);
  await db.close();
  db = await open();
  assert.deepEqual((await db.inspect("log")).rows, [[1n, "one"]]);
  store.fault = "after";
  await assert.rejects(db.execute("add", [2n, "two"]), /uncertain/);
  await db.close();
  db = await open();
  assert.deepEqual((await db.inspect("log")).rows, [
    [1n, "one"],
    [2n, "two"],
  ]);
  store.fault = "after";
  await assert.rejects(db.checkpoint(), /uncertain/);
  await db.close();
  db = await open();
  assert.deepEqual((await db.inspect("log")).rows, [
    [1n, "one"],
    [2n, "two"],
  ]);
  assert.equal((await db.pending()).length, 1);
  await db.close();
});

class JournalStore extends Store {
  deltas: ImageDelta[] = [];
  override async read() {
    return {
      ...(await super.read()),
      ...(this.deltas.length ? { deltas: structuredClone(this.deltas) } : {}),
    };
  }
  override async commit(expected: number, image: string) {
    const fault = this.fault;
    if (fault === "before") return super.commit(expected, image);
    this.fault = undefined;
    const generation = await super.commit(expected, image);
    this.deltas = [];
    if (fault === "after") throw Error("commit outcome uncertain");
    return generation;
  }
  async commitDelta(expected: number, delta: ImageDelta) {
    if (expected !== this.generation) throw Error("stale image");
    const fault = this.fault;
    this.fault = undefined;
    if (fault === "before") throw Error("aborted");
    this.deltas.push(structuredClone(delta));
    this.generation++;
    if (fault === "after") throw Error("commit outcome uncertain");
    return this.generation;
  }
  checkpointNeeded() {
    return this.deltas.length >= 128;
  }
}

test("journal compaction bounds replay and preserves serials after a checkpoint and lost ACK", async () => {
  const store = new JournalStore();
  let db = await open(store);
  for (let i = 1; i <= 140; i++)
    await db.execute("add", [BigInt(i), `row${i}`]);
  assert.ok(store.deltas.length < 128);
  db = await open(store);
  assert.equal((await db.inspect("list")).rows.length, 140);
  store.fault = "after";
  await assert.rejects(() => db.checkpoint(), /uncertain/);
  db = await open(store);
  const file = (await db.pending())[0]!;
  store.fault = "after";
  await assert.rejects(() => db.acknowledge("1", file.sha256), /uncertain/);
  db = await open(store);
  assert.equal((await db.pending()).length, 0);
  assert.equal((await db.inspect("list")).rows.length, 140);
});

test("materialized row journal and binary checkpoint survive reload without rewriting the full saved image", async () => {
  const store = new JournalStore();
  let db = await open(store);
  const initial = store.image;
  await db.execute("add", [1n, "first"]);
  assert.equal(store.image, initial);
  assert.equal(store.deltas.length, 1);
  await db.checkpoint();
  assert.ok(store.deltas[1]!.blobs!.length >= 2);
  const afterCheckpoint = store.image;
  await db.execute("add", [2n, "second"]);
  assert.equal(store.image, afterCheckpoint);
  assert.equal(store.deltas[2]!.blobs, undefined);
  db = await open(store);
  assert.deepEqual((await db.inspect("list")).rows, [
    [1n, "first"],
    [2n, "second"],
  ]);
  const pending = (await db.pending())[0]!;
  await db.acknowledge("1", pending.sha256);
  db = await open(store);
  assert.equal((await db.inspect("list")).pending.length, 0);
  store.fault = "before";
  await assert.rejects(() => db.execute("add", [3n, "aborted"]), /aborted/);
  db = await open(store);
  assert.equal((await db.inspect("list")).rows.length, 2);
  store.fault = "after";
  await assert.rejects(() => db.execute("add", [4n, "durable"]), /uncertain/);
  db = await open(store);
  assert.deepEqual((await db.inspect("list")).rows, [
    [1n, "first"],
    [2n, "second"],
    [4n, "durable"],
  ]);
});
test("compiled data, checkpoint cursor and pending LTX survive reload; ACKs must match the file", async () => {
  const store = new Store(),
    db = await open(store);
  await db.execute("add", [1n, "offline"]);
  const first = await db.checkpoint();
  assert.equal(first.created, true);
  const before = await db.inspect("list");
  assert.equal(before.head, "1");
  assert.equal(before.pending.length, 1);
  const reopened = await open(store);
  assert.deepEqual((await reopened.inspect("list")).rows, [[1n, "offline"]]);
  assert.equal((await reopened.checkpoint()).created, false);
  await assert.rejects(
    () => reopened.acknowledge("1", "0".repeat(64)),
    /checksum|hash/,
  );
  const pending = (await reopened.pending())[0]!;
  await reopened.acknowledge("1", pending.sha256);
  assert.equal((await reopened.inspect("list")).pending.length, 0);
  await reopened.execute("add", [2n, "next"]);
  await reopened.checkpoint();
  assert.equal((await reopened.inspect("list")).head, "2");
  assert.deepEqual((await reopened.execute("real", [1, -0])).rows, [
    ["real", -0],
  ]);
});
test("aborted storage does not publish data; an ACK lost after commit is recovered by reopening", async () => {
  const store = new Store(),
    db = await open(store);
  await db.execute("add", [1n, "committed"]);
  await db.checkpoint();
  store.fault = "before";
  await assert.rejects(() => db.execute("add", [2n, "aborted"]), /aborted/);
  await assert.rejects(() => db.execute("list"), /reload/);
  let current = await open(store);
  assert.deepEqual((await current.inspect("list")).rows, [[1n, "committed"]]);
  assert.equal((await current.inspect("list")).pending.length, 1);
  store.fault = "after";
  await assert.rejects(
    () => current.execute("add", [3n, "accepted"]),
    /uncertain/,
  );
  current = await open(store);
  assert.deepEqual((await current.inspect("list")).rows, [
    [1n, "committed"],
    [3n, "accepted"],
  ]);
  store.fault = "after";
  await assert.rejects(() => current.checkpoint(), /uncertain/);
  current = await open(store);
  const state = await current.inspect("list");
  assert.equal(state.head, "2");
  assert.equal(state.pending.length, 2);
});
test("artifact hashes and stale writers cannot replace the committed state", async () => {
  const store = new Store();
  await assert.rejects(
    () => AotDatabase.withStore(built.artifact, "0".repeat(64), store),
    /artifact/,
  );
  assert.equal(store.generation, 0);
  const a = await open(store),
    b = await open(store);
  await a.execute("add", [1n, "winner"]);
  await assert.rejects(() => b.execute("add", [2n, "stale"]), /stale/);
  assert.deepEqual((await (await open(store)).inspect("list")).rows, [
    [1n, "winner"],
  ]);
});

test("explicit AOT SQL transactions do not publish until COMMIT and a lost commit ACK recovers all rows", async () => {
  const built = buildCatalog({
    schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,n TEXT)"],
    queries: [
      { name: "begin", sql: "BEGIN" },
      { name: "add", sql: "INSERT INTO t VALUES(?,?)" },
      { name: "commit", sql: "COMMIT" },
      { name: "rollback", sql: "ROLLBACK" },
      { name: "all", sql: "SELECT id,n FROM t ORDER BY id" },
    ],
  });
  const store = new JournalStore();
  const open = () =>
    AotDatabase.withStore(built.artifact, built.manifest.artifactSHA256, store);
  let db = await open();
  const initial = store.generation;
  await db.execute("begin");
  await db.execute("add", [1n, "a"]);
  assert.equal(store.generation, initial);
  await assert.rejects(db.checkpoint(), /transaction/);
  await db.close();
  db = await open();
  assert.deepEqual((await db.execute("all")).rows, []);
  await db.execute("begin");
  await db.execute("add", [1n, "a"]);
  await db.execute("add", [2n, "b"]);
  store.fault = "after";
  await assert.rejects(db.execute("commit"), /uncertain/);
  await db.close();
  db = await open();
  assert.deepEqual((await db.execute("all")).rows, [
    [1n, "a"],
    [2n, "b"],
  ]);
  await db.execute("begin");
  await db.execute("add", [3n, "c"]);
  await db.execute("rollback");
  assert.deepEqual((await db.execute("all")).rows, [
    [1n, "a"],
    [2n, "b"],
  ]);
  await db.close();
});
