import { test } from "node:test";
import assert from "node:assert/strict";
import { DefinedDatabase } from "../adapters/defined-database.ts";
import { buildDefinedCatalog } from "../scripts/defined-compiler.ts";
import type { ImageStore, ImageDelta } from "../src/persistence-contract.ts";
class Store implements ImageStore {
  generation = 0;
  image?: string;
  deltas: ImageDelta[] = [];
  fault: "before" | "after" | undefined;
  read() {
    return Promise.resolve({
      generation: this.generation,
      image: this.image,
      deltas: structuredClone(this.deltas),
    });
  }
  private check(expected: number) {
    if (expected !== this.generation) throw Error("stale image");
    if (this.fault === "before") {
      this.fault = undefined;
      throw Error("aborted");
    }
  }
  private ack() {
    this.generation++;
    if (this.fault === "after") {
      this.fault = undefined;
      throw Error("uncertain outcome");
    }
    return this.generation;
  }
  async commit(expected: number, image: string) {
    this.check(expected);
    this.image = image;
    this.deltas = [];
    return this.ack();
  }
  async commitDelta(expected: number, delta: ImageDelta) {
    this.check(expected);
    this.deltas.push(structuredClone(delta));
    return this.ack();
  }
  close() {}
}
const source = {
  schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER,body TEXT)"],
  queries: [
    { name: "add", sql: "INSERT INTO t VALUES(?,?,?)" },
    { name: "edit", sql: "UPDATE t SET n=? WHERE id=?" },
    { name: "read", sql: "SELECT * FROM t ORDER BY id" },
    { name: "begin", sql: "BEGIN" },
    { name: "commit", sql: "COMMIT" },
    { name: "rollback", sql: "ROLLBACK" },
  ],
};
test("defined binary journal commits a whole explicit transaction and replays patches without schema", async () => {
  const catalog = buildDefinedCatalog(source),
    store = new Store();
  let db = await DefinedDatabase.withStore(catalog, store);
  await db.execute("begin");
  await db.execute("add", [1n, 1n, "x".repeat(4096)]);
  await db.execute("add", [2n, 2n, "kept"]);
  assert.equal(store.generation, 1);
  await db.execute("commit");
  assert.equal(store.generation, 2);
  await db.execute("edit", [9n, 1n]);
  const patch = store.deltas.at(-1)!;
  assert.ok(patch.blobs![0]!.length < 1024);
  assert.equal(
    Buffer.from(patch.blobs![0]!).includes(Buffer.from("CREATE TABLE")),
    false,
  );
  await db.close();
  db = await DefinedDatabase.withStore(catalog, store);
  assert.deepEqual(
    (await db.prepare("read").all()).map((r) => r.slice(0, 2)),
    [
      [1n, 9n],
      [2n, 2n],
    ],
  );
  await db.execute("begin");
  await db.execute("edit", [99n, 1n]);
  await db.execute("rollback");
  await db.close();
  db = await DefinedDatabase.withStore(catalog, store);
  assert.equal((await db.prepare("read").get())![1], 9n);
  await db.close();
});
test("defined persistence rejects stale writers, aborts, ACK loss and corrupted binary journal", async () => {
  const catalog = buildDefinedCatalog(source),
    store = new Store();
  let db = await DefinedDatabase.withStore(catalog, store);
  const stale = await DefinedDatabase.withStore(catalog, store);
  await db.execute("add", [1n, 1n, "one"]);
  await assert.rejects(stale.execute("add", [2n, 2n, "stale"]), /stale/);
  await assert.rejects(stale.prepare("read").all(), /reopen/);
  await stale.close();
  store.fault = "before";
  await assert.rejects(db.execute("edit", [2n, 1n]), /aborted/);
  await db.close();
  db = await DefinedDatabase.withStore(catalog, store);
  assert.equal((await db.prepare("read").get())![1], 1n);
  store.fault = "after";
  await assert.rejects(db.execute("edit", [3n, 1n]), /uncertain/);
  await db.close();
  db = await DefinedDatabase.withStore(catalog, store);
  assert.equal((await db.prepare("read").get())![1], 3n);
  await db.close();
  const bytes = store.deltas.at(-1)!.blobs![0]!;
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
  await assert.rejects(DefinedDatabase.withStore(catalog, store), /checksum/);
});
