import { test } from "node:test";
import assert from "node:assert/strict";
import { compareSixQueries, sixPaths } from "./compatibility/six-paths.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "./compatibility/native-values.ts";
import type { Value } from "../src/contract.ts";

test("IN SELECT reuse preserves empty sets, NULL tuples, numeric precision and collation", async () => {
  await compareSixQueries(
    [
      "SELECT id,n IN(SELECT n FROM r),s IN(SELECT s FROM r),r IN(SELECT n FROM r),(n,s) IN(SELECT n,s FROM r) FROM t ORDER BY id",
      "SELECT id,n NOT IN(SELECT n FROM r WHERE 0),(n,s) IN(SELECT n,s FROM r WHERE 0) FROM t ORDER BY id",
      "SELECT id,n IN(SELECT CAST(s AS NUMERIC) FROM r),s COLLATE BINARY IN(SELECT s COLLATE NOCASE FROM r),s IN(SELECT s COLLATE BINARY FROM r) FROM t ORDER BY id",
      "SELECT id,(n,s) IN(SELECT n,s COLLATE BINARY FROM r),(r,s) IN(SELECT n,s FROM r) FROM t ORDER BY id",
      "SELECT id,n IN(SELECT n FROM r WHERE r.n=t.n),(n,s) IN(SELECT n,s FROM r WHERE r.n<t.n) FROM t ORDER BY id",
      "SELECT CASE WHEN 0 THEN 1 IN(SELECT abs(-9223372036854775808) FROM r) ELSE 7 END FROM t ORDER BY id",
      "SELECT id,n IN(SELECT 9007199254740993),r IN(SELECT 9007199254740993),(r,s) IN(SELECT 9007199254740993,'A') FROM t ORDER BY id",
    ],
    [
      "CREATE TABLE t(id INTEGER PRIMARY KEY,n NUMERIC,s TEXT COLLATE NOCASE,r REAL)",
      "CREATE TABLE r(n INTEGER,s TEXT COLLATE NOCASE)",
    ],
    [
      "INSERT INTO t VALUES(1,1,'A',1),(2,9007199254740993,'big',9007199254740993),(3,NULL,'a',NULL),(4,2,NULL,2),(5,3,'no',3)",
      "INSERT INTO r VALUES(1,'a'),(9007199254740993,'big'),(NULL,'a'),(2,NULL)",
    ],
  );
});

test("IN caches on general sources retain current bindings and changed RHS tables", async () => {
  const p = Array.from({ length: 16 }, (_, i) => `?${i + 1}`).join(",");
  const schema = [
    "CREATE TABLE t(id INTEGER PRIMARY KEY,n NUMERIC,s TEXT COLLATE NOCASE)",
    "CREATE TABLE r(n TEXT,s TEXT COLLATE NOCASE)",
    "CREATE VIEW v AS SELECT id,n,s FROM t",
  ];
  const queries = [
    {
      name: "seed",
      sql: "INSERT INTO t VALUES(1,1,'A'),(2,2,'b'),(3,NULL,NULL)",
    },
    {
      name: "seedr",
      sql: "INSERT INTO r VALUES('1','a'),('2','B'),(NULL,NULL)",
    },
    {
      name: "read",
      sql: "SELECT id,n IN(SELECT n FROM r WHERE s<>?1),(n,s) IN(SELECT n,s FROM r WHERE s<>?1) FROM t ORDER BY id",
    },
    {
      name: "join",
      sql: `SELECT t.id,t.n IN(${p}),t.s IN(${p}) FROM t JOIN r ON t.n=r.n ORDER BY t.id,r.n`,
    },
    { name: "view", sql: `SELECT id,n IN(${p}) FROM v ORDER BY id` },
    {
      name: "cte",
      sql: `WITH c AS(SELECT id,n FROM t) SELECT id,n IN(${p}) FROM c ORDER BY id`,
    },
    { name: "change", sql: "UPDATE r SET n='9',s='z' WHERE n='1'" },
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
    for (const name of ["seed", "seedr"]) {
      const q = queries.find((q) => q.name === name)!;
      native.raw.exec(q.sql);
      for (const db of paths) await db.execute(name);
    }
    for (let round = 0; round < 2; round++) {
      for (const params of [["none"], ["a"], [null]] as Value[][])
        for (const db of paths)
          assert.deepEqual(
            await db.execute("read", params),
            nativeValues(
              native,
              queries.find((q) => q.name === "read")!.sql,
              params,
            ),
          );
      for (const name of ["join", "view", "cte"])
        for (const params of [
          Array<Value>(16).fill(1n),
          Array<Value>(16).fill(2n),
          Array<Value>(16).fill(null),
        ])
          for (const db of paths)
            assert.deepEqual(
              await db.execute(name, params),
              nativeValues(
                native,
                queries.find((q) => q.name === name)!.sql,
                params,
              ),
            );
      if (round === 0) {
        native.raw.exec(queries.find((q) => q.name === "change")!.sql);
        for (const db of paths) await db.execute("change");
      }
    }
  } finally {
    native.close();
    await Promise.all(paths.map((p) => p.close()));
  }
});

test("large cache payloads fall back without altering scalar and row IN results", async () => {
  const p = Array.from({ length: 16 }, (_, i) => `?${i + 1}`).join(","),
    pairs = Array.from(
      { length: 16 },
      (_, i) => `(?${i * 2 + 1},?${i * 2 + 2})`,
    ).join(",");
  const schema = ["CREATE TABLE t(s TEXT COLLATE NOCASE,n INTEGER)"];
  const queries = [
    { name: "seed", sql: "INSERT INTO t VALUES(?1,1),(NULL,2),('missing',3)" },
    { name: "scalar", sql: `SELECT n,s IN(${p}) FROM t ORDER BY n` },
    { name: "row", sql: `SELECT n,(s,n) IN(${pairs}) FROM t ORDER BY n` },
    {
      name: "select",
      sql: "SELECT n,s IN(SELECT s FROM t),(s,n) IN(SELECT s,n FROM t) FROM t ORDER BY n",
    },
  ];
  const paths = await sixPaths(
      schema,
      queries.map((q) => ({
        ...q,
        write: /^(INSERT|UPDATE|DELETE)/.test(q.sql),
      })),
    ),
    native = new NodeDatabase(":memory:"),
    long = "A".repeat(25000);
  try {
    schema.forEach((q) => native.raw.exec(q));
    native.run(queries[0]!.sql, [long]);
    for (const db of paths) await db.execute("seed", [long]);
    for (const [name, params] of [
      ["scalar", Array(16).fill(long.toLowerCase())],
      [
        "row",
        Array.from({ length: 16 }, () => [long.toLowerCase(), 1n]).flat(),
      ],
      ["select", []],
    ] as [string, Value[]][])
      for (const db of paths)
        assert.deepEqual(
          await db.execute(name, params),
          nativeValues(
            native,
            queries.find((q) => q.name === name)!.sql,
            params,
          ),
        );
  } finally {
    native.close();
    await Promise.all(paths.map((p) => p.close()));
  }
});

test("merged FULL JOIN columns keep scalar IN coercion under reuse", async () => {
  const list = Array(16).fill("'2'").join(",");
  await compareSixQueries(
    [
      `SELECT a.k,b.k,k IN(${list}),k IN(SELECT k FROM a) FROM a FULL JOIN b USING(k) ORDER BY a.k,b.k`,
    ],
    ["CREATE TABLE a(k INTEGER)", "CREATE TABLE b(k TEXT)"],
    ["INSERT INTO a VALUES(1),(NULL)", "INSERT INTO b VALUES('01'),('2')"],
  );
});
