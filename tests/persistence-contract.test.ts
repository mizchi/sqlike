import { test } from "node:test";
import assert from "node:assert/strict";
import { AotDatabase } from "../adapters/aot-database.ts";
import { MoonDatabase } from "../adapters/moon-database.ts";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import type {
  ImageStore,
  PersistedImage,
} from "../src/persistence-contract.ts";

test("AOT storage factory can be replaced without IndexedDB or browser globals", async () => {
  const built = buildCatalog({
    schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY)"],
    queries: [
      { name: "add", sql: "INSERT INTO t VALUES(?)" },
      { name: "read", sql: "SELECT id FROM t" },
    ],
  });
  let saved: PersistedImage = { generation: 0 },
    closed = false,
    opened = "";
  const store: ImageStore = {
    async read() {
      return structuredClone(saved);
    },
    async commit(expected, image) {
      assert.equal(expected, saved.generation);
      saved = { generation: expected + 1, image };
      return saved.generation;
    },
    close() {
      closed = true;
    },
  };
  const provider = async (name: string) => {
    opened = name;
    return store;
  };
  let db = await AotDatabase.open(
    "injected",
    built.artifact,
    built.manifest.artifactSHA256,
    provider,
  );
  assert.equal(opened, "aot-injected");
  await db.execute("add", [7n]);
  await db.close();
  assert.equal(closed, true);
  db = await AotDatabase.open(
    "injected",
    built.artifact,
    built.manifest.artifactSHA256,
    provider,
  );
  assert.deepEqual((await db.execute("read")).rows, [[7n]]);
  await db.close();
});

test("SQLike synchronous persistence factory replays materialized edits without an IDB or Worker dependency", async () => {
  let saved: PersistedImage = { generation: 0 };
  let closed = 0;
  const provider = async () => ({
    initial: structuredClone(saved),
    checkpointNeeded: () => false,
    close() {
      closed++;
    },
    commit(image: string, delta = false) {
      saved = delta
        ? {
            ...saved,
            generation: saved.generation + 1,
            deltas: [...(saved.deltas ?? []), { text: image }],
          }
        : { generation: saved.generation + 1, image };
    },
  });
  const db = await MoonDatabase.open("injected", provider);
  db.run("CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)");
  db.run("INSERT INTO t VALUES(1,10),(2,20)");
  db.run("UPDATE t SET n=11 WHERE id=1");
  assert.equal(saved.deltas!.length, 2);
  const reopened = await MoonDatabase.open("injected", provider);
  assert.deepEqual(reopened.queryValues("SELECT id,n FROM t ORDER BY id"), [
    [1n, 11n],
    [2n, 20n],
  ]);
  db.close();
  reopened.close();
  assert.equal(closed, 2);
  assert.throws(() => db.queryValues("SELECT * FROM t"), /closed/);
});
