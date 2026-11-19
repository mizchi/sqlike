import { test } from "node:test";
import assert from "node:assert/strict";
import { sixPaths } from "./compatibility/six-paths.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "./compatibility/native-values.ts";
import type { Value } from "../src/contract.ts";

test("UPDATE and DELETE IN frames retain live row values, binds and trigger isolation", async () => {
  const list = Array.from({ length: 16 }, (_, i) => `?${i + 1}`).join(","),
    pairs = Array.from(
      { length: 16 },
      (_, i) => `(?${i * 2 + 1},?${i * 2 + 2})`,
    ).join(",");
  const schema = [
    "CREATE TABLE t(id INTEGER PRIMARY KEY,n NUMERIC,s TEXT COLLATE NOCASE,hit INTEGER)",
    "CREATE TABLE audit(id INTEGER,n NUMERIC)",
    "CREATE TRIGGER changed AFTER UPDATE ON t BEGIN INSERT INTO audit VALUES(new.id,new.n); END",
  ];
  const queries = [
    {
      name: "seed",
      sql: "INSERT INTO t VALUES(1,1,'A',0),(2,2,'b',0),(3,NULL,NULL,0),(4,3,'c',0)",
    },
    {
      name: "update",
      sql: `UPDATE t SET hit=n IN(${list}) WHERE id IN(${list}) RETURNING id,n,hit,n IN(${list})`,
    },
    {
      name: "row_update",
      sql: `UPDATE t SET hit=(n,s) IN(${pairs}) RETURNING id,hit`,
    },
    {
      name: "remove",
      sql: `DELETE FROM t WHERE n IN(${list}) RETURNING id,n IN(${list})`,
    },
    { name: "read", sql: "SELECT * FROM t ORDER BY id" },
    { name: "audit", sql: "SELECT * FROM audit ORDER BY rowid" },
  ];
  const paths = await sixPaths(
      schema,
      queries.map((q) => ({
        ...q,
        write: /^(INSERT|UPDATE|DELETE)/.test(q.sql),
      })),
    ),
    native = new NodeDatabase(":memory:");
  try {
    schema.forEach((q) => native.raw.exec(q));
    native.raw.exec(queries[0]!.sql);
    for (const db of paths) await db.execute("seed");
    for (const [name, params] of [
      ["update", Array(16).fill(1n)],
      ["update", Array(16).fill(2n)],
      ["row_update", Array.from({ length: 16 }, () => [null, "a"]).flat()],
      ["row_update", Array.from({ length: 16 }, () => ["2", "B"]).flat()],
      ["remove", Array(16).fill(1n)],
      ["remove", Array(16).fill(null)],
    ] as [string, Value[]][]) {
      const expected = nativeValues(
        native,
        queries.find((q) => q.name === name)!.sql,
        params,
      );
      for (const db of paths)
        assert.deepEqual(await db.execute(name, params), expected);
      for (const q of queries.filter((q) => ["read", "audit"].includes(q.name)))
        for (const db of paths)
          assert.deepEqual(
            await db.execute(q.name),
            nativeValues(native, q.sql),
          );
    }
  } finally {
    native.close();
    await Promise.all(paths.map((p) => p.close()));
  }
});

test("IN cache errors still roll back the whole UPDATE and its trigger effects", async () => {
  const list = Array(16).fill("1").join(",");
  const schema = [
    "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)",
    "CREATE TABLE audit(n INTEGER)",
    "CREATE TRIGGER tr AFTER UPDATE ON t BEGIN INSERT INTO audit VALUES(new.n); END",
  ];
  const queries = [
    { name: "seed", sql: "INSERT INTO t VALUES(1,1),(2,2)" },
    {
      name: "bad",
      sql: `UPDATE t SET n=CASE WHEN id IN(${list}) THEN 7 ELSE abs(-9223372036854775808) END RETURNING id`,
    },
    { name: "read", sql: "SELECT * FROM t ORDER BY id" },
    { name: "audit", sql: "SELECT * FROM audit" },
  ];
  const paths = await sixPaths(
    schema,
    queries.map((q) => ({ ...q, write: /^(INSERT|UPDATE)/.test(q.sql) })),
  );
  try {
    for (const db of paths) {
      await db.execute("seed");
      await assert.rejects(db.execute("bad"), /overflow/);
      assert.deepEqual(await db.execute("read"), [
        [1n, 1n],
        [2n, 2n],
      ]);
      assert.deepEqual(await db.execute("audit"), []);
    }
  } finally {
    await Promise.all(paths.map((p) => p.close()));
  }
});
