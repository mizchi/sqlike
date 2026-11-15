import { test } from "node:test";
import assert from "node:assert/strict";
import { sqlikePaths } from "./compatibility/sqlike-paths.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "./compatibility/native-values.ts";
import type { Value } from "../src/contract.ts";

test("paged rows keep native results through bulk deletion, FK/triggers, savepoint rollback and append after compaction", async () => {
  const schema = [
    "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER UNIQUE)",
    "CREATE TABLE child(tid INTEGER REFERENCES t(id) ON DELETE CASCADE)",
    "CREATE TABLE audit(id INTEGER PRIMARY KEY,tid INTEGER,n INTEGER)",
    "CREATE TRIGGER ad AFTER DELETE ON t BEGIN INSERT INTO audit(tid,n) VALUES(old.id,old.n); END",
  ];
  const queries = [
    { name: "seed", sql: `INSERT INTO t VALUES${Array(100).fill("(?,?)").join(",")}`, write: true },
    { name: "child", sql: "INSERT INTO child VALUES(0),(63),(64),(127),(512),(999)", write: true },
    { name: "get", sql: "SELECT id,n FROM t WHERE id=?" },
    { name: "read", sql: "SELECT id,n FROM t ORDER BY id" },
    { name: "children", sql: "SELECT tid FROM child ORDER BY tid" },
    { name: "audit", sql: "SELECT tid,n FROM audit ORDER BY id" },
    { name: "erase", sql: "DELETE FROM t WHERE id<? RETURNING id,n", write: true },
    { name: "add", sql: "INSERT INTO t VALUES(?,?)", write: true },
    { name: "move", sql: "UPDATE t SET id=? WHERE id=? RETURNING id,n", write: true },
    ...[
      ["begin", "BEGIN"], ["savepoint", "SAVEPOINT s"],
      ["rollback", "ROLLBACK TO s"], ["release", "RELEASE s"],
      ["commit", "COMMIT"],
    ].map(([name, sql]) => ({ name: name!, sql: sql!, write: true })),
  ];
  const paths = await sqlikePaths(schema, queries), native = new NodeDatabase(":memory:");
  function step(name: string, values: Value[] = []) {
    const q = queries.find(q => q.name === name)!;
    const expected = nativeValues(native, q.sql, values);
    for (const [i, p] of paths.entries())
      assert.deepEqual(p.exec(name, values), expected, `${name}, path ${i}`);
  }
  function verify() {
    step("read"); step("children"); step("audit");
  }
  try {
    for (const sql of schema) native.raw.exec(sql);
    for (let offset = 0; offset < 1000; offset += 100)
      step("seed", Array.from({ length: 100 }, (_, i) => [BigInt(offset + i), BigInt(offset + i)]).flat());
    step("child");
    step("get", [999n]);
    step("begin"); step("savepoint");
    step("erase", [900n]);
    verify();
    step("rollback"); step("release"); step("commit");
    verify();
    step("erase", [700n]);
    step("get", [999n]);
    step("add", [1999n, 1999n]);
    step("get", [1999n]);
    assert.throws(() => nativeValues(native, queries.find(q => q.name === "move")!.sql, [800n, 1999n]));
    for (const p of paths) assert.throws(() => p.exec("move", [800n, 1999n]));
    step("move", [2000n, 1999n]);
    verify();
    const images = paths.map(p => p.dump());
    step("erase", [3000n]);
    step("add", [7n, 7n]);
    step("get", [7n]);
    for (const [i, p] of paths.entries()) {
      p.restore(images[i]!);
      assert.deepEqual(p.exec("get", [2000n]), [[2000n, 1999n]]);
      assert.equal(p.exec("read").length, 301);
    }
  } finally {
    native.close();
  }
});
