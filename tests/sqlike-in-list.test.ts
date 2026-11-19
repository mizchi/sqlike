import { test } from "node:test";
import { compareSixQueries } from "./compatibility/six-paths.ts";
import assert from "node:assert/strict";
import { sixPaths } from "./compatibility/six-paths.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "./compatibility/native-values.ts";
import type { Value } from "../src/contract.ts";

test("scalar IN comparison affinity does not round integer RHS values to REAL", async () => {
  await compareSixQueries(
    [
      "SELECT CAST(9007199254740993 AS REAL) IN (9007199254740993),CAST(9223372036854775807 AS REAL) IN (9223372036854775807)",
      "SELECT CAST(1 AS REAL) IN ('1'),CAST(1 AS REAL) IN (1.0),CAST(1 AS REAL) NOT IN (2,NULL)",
      "SELECT r IN (9007199254740993),r IN (9007199254740992),r IN ('9007199254740993'),r NOT IN (NULL,0) FROM t ORDER BY id",
    ],
    ["CREATE TABLE t(id INTEGER PRIMARY KEY,r REAL)"],
    ["INSERT INTO t VALUES(1,9007199254740993),(2,1),(3,NULL)"],
  );
});

test("IN SELECT and row-list affinity follow the pinned SQLite versions including REAL conversion", async () => {
  await compareSixQueries(
    [
      "SELECT (CAST(9007199254740993 AS REAL),0) IN((9007199254740993,0)),CAST(9007199254740993 AS REAL) IN(SELECT 9007199254740993)",
      "SELECT 1 IN(SELECT '1' UNION ALL SELECT CAST('2' AS TEXT)),1 IN(SELECT CAST('1' AS TEXT) UNION ALL SELECT '2')",
      "SELECT CAST(9007199254740993 AS REAL) IN(SELECT 9007199254740993 UNION ALL SELECT CAST(9007199254740993 AS INTEGER)),CAST(9007199254740993 AS REAL) IN(SELECT CAST(9007199254740993 AS INTEGER) UNION ALL SELECT 9007199254740993)",
      "SELECT 'A' IN(SELECT 'a' COLLATE NOCASE UNION ALL SELECT 'a' COLLATE BINARY),'A' IN(SELECT 'a' COLLATE BINARY UNION ALL SELECT 'a' COLLATE NOCASE)",
      "SELECT s IN(SELECT 'A' COLLATE NOCASE),s COLLATE BINARY IN(SELECT 'A' COLLATE NOCASE) FROM t",
    ],
    ["CREATE TABLE t(s TEXT COLLATE BINARY)"],
    ["INSERT INTO t VALUES('a')"],
  );
});

test("large IN lists reuse current binds with exact numeric, blob, NULL and collation equality", async () => {
  const values = Array.from({ length: 32 }, (_, i) => `?${i + 1}`).join(",");
  const schema = [
    "CREATE TABLE t(id INTEGER PRIMARY KEY,n NUMERIC,s TEXT COLLATE NOCASE,r REAL,b BLOB)",
  ];
  const queries = [
    {
      name: "seed",
      sql: "INSERT INTO t VALUES(1,1,'A',1,x'00ff'),(2,9223372036854775807,'b',9007199254740993,NULL),(3,NULL,'a',NULL,x'')",
      write: true,
    },
    {
      name: "read",
      sql: `SELECT id,n IN(${values}),s IN(${values}),r IN(${values}),b IN(${values}),n NOT IN(${values}) FROM t ORDER BY id`,
    },
    { name: "nul", sql: "UPDATE t SET s=? WHERE id=1", write: true },
    {
      name: "nested",
      sql: `SELECT id,(SELECT n IN(${values})) FROM t ORDER BY id`,
    },
    {
      name: "stats",
      sql: `SELECT count(*),count(n),sum(id),avg(id),total(id) FROM t WHERE n IN(${values})`,
    },
    {
      name: "text_stats",
      sql: `SELECT count(*),sum(id) FROM t WHERE s IN(${values})`,
    },
    {
      name: "real_stats",
      sql: `SELECT count(*),sum(id) FROM t WHERE r IN(${values})`,
    },
  ];
  const paths = await sixPaths(schema, queries),
    native = new NodeDatabase(":memory:");
  try {
    schema.forEach((s) => native.raw.exec(s));
    native.raw.exec(queries[0]!.sql);
    for (const p of paths) await p.execute("seed");
    const sets: Value[][] = [
      Array<Value>(32).fill(null),
      Array.from({ length: 32 }, (_, i) => BigInt(i)),
      [
        1n,
        1.0,
        "1",
        "A",
        new Uint8Array([0, 255]),
        9223372036854775807n,
        9007199254740993n,
        9007199254740992,
        ...Array<Value>(24).fill("missing"),
      ],
      ["a\0B", ...Array<Value>(31).fill("a\0C")],
    ];
    for (const params of sets) {
      for (const name of [
        "read",
        "nested",
        "stats",
        "text_stats",
        "real_stats",
      ]) {
        const query = queries.find((q) => q.name === name)!;
        for (const p of paths)
          assert.deepEqual(
            await p.execute(name, params),
            nativeValues(native, query.sql, params),
          );
      }
    }
    native.run(queries[2]!.sql, ["a\0b"]);
    for (const p of paths) await p.execute("nul", ["a\0b"]);
    for (const p of paths)
      assert.deepEqual(
        await p.execute("read", sets[3]),
        nativeValues(native, queries[1]!.sql, sets[3]),
      );
  } finally {
    native.close();
    await Promise.all(paths.map((p) => p.close()));
  }
});

test("row IN lookup preserves NULL patterns, common affinity and live tuple bindings", async () => {
  const tuples = Array.from(
    { length: 16 },
    (_, i) => `(?${i * 2 + 1},?${i * 2 + 2})`,
  ).join(",");
  const schema = [
    "CREATE TABLE t(id INTEGER PRIMARY KEY,n NUMERIC,s TEXT COLLATE NOCASE)",
  ];
  const queries = [
    {
      name: "seed",
      sql: "INSERT INTO t VALUES(1,1,'A'),(2,NULL,'a'),(3,2,NULL),(4,NULL,NULL),(5,9007199254740993,'big')",
      write: true,
    },
    {
      name: "read",
      sql: `SELECT id,(n,s) IN(${tuples}),(n,s) NOT IN(${tuples}),(n,s COLLATE BINARY) IN(${tuples}),(CAST(n AS REAL),s) IN(${tuples}) FROM t ORDER BY id`,
    },
    {
      name: "stats",
      sql: `SELECT count(*),count(n),sum(id),avg(id),total(id) FROM t WHERE (n,s) IN(${tuples})`,
    },
  ];
  const paths = await sixPaths(schema, queries),
    native = new NodeDatabase(":memory:");
  try {
    schema.forEach((s) => native.raw.exec(s));
    native.raw.exec(queries[0]!.sql);
    for (const p of paths) await p.execute("seed");
    const pairs: Value[][][] = [
      [
        [1n, "a"],
        [2n, "b"],
        [9007199254740993n, "big"],
      ],
      [
        [null, "a"],
        [2n, null],
        [9007199254740992n, "big"],
      ],
      [[null, null]],
      [
        ["1", "A"],
        [1.0, "a"],
        ["9007199254740993", "big"],
        [null, "bad"],
      ],
    ];
    for (const seed of pairs) {
      const params = Array.from(
        { length: 16 },
        (_, i) => seed[i % seed.length]!,
      ).flat();
      for (const name of ["read", "stats"])
        for (const p of paths)
          assert.deepEqual(
            await p.execute(name, params),
            nativeValues(
              native,
              queries.find((q) => q.name === name)!.sql,
              params,
            ),
          );
    }
  } finally {
    native.close();
    await Promise.all(paths.map((p) => p.close()));
  }
});
