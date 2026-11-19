import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as binary from "../_build/js/release/build/mizchi/sqlike/defined/defined.js";
import { buildDefinedCatalog } from "../scripts/defined-compiler.ts";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import { createDefinedDatabase } from "../adapters/defined-database-core.ts";
import { definedWasm } from "../adapters/defined-wasm.ts";
import { MoonDatabase, type MoonSqlRuntime } from "../adapters/moon-database.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "./compatibility/native-values.ts";
import { compareQueries, sqlikePaths } from "./compatibility/sqlike-paths.ts";
import type { Value } from "../src/contract.ts";

async function compareSix(queries: string[], schema: string[] = [], seed: string[] = []) {
  await compareQueries(queries, schema, seed);
  const source = {
    schema,
    queries: [
      ...seed.map((sql, i) => ({ name: `seed${i}`, sql })),
      ...queries.map((sql, i) => ({ name: `q${i}`, sql })),
    ],
  };
  const catalog = buildDefinedCatalog(source);
  const wasm = (await WebAssembly.instantiate(readFileSync(
    "_build/wasm-gc/release/build/mizchi/sqlike/defined/defined.wasm",
  ), {}, { builtins: ["js-string"], importedStringConstants: "_" })).instance.exports;
  for (const raw of [binary, definedWasm(wasm)]) {
    const native = new NodeDatabase(":memory:");
    const db = await createDefinedDatabase(raw).memory(catalog);
    try {
    schema.forEach(sql => native.raw.exec(sql)); seed.forEach(sql => native.raw.exec(sql));
        for (const i of seed.keys()) await db.execute(`seed${i}`);
        for (const [i, sql] of queries.entries())
          assert.deepEqual((await db.execute(`q${i}`)).rows, nativeValues(native, sql), sql);
    } finally { await db.close(); native.close(); }
  }
}

test("row comparisons preserve lexicographic and three-valued logic across six paths", async () => {
  const tuples = ["(1,2,NULL)", "(1,NULL,3)", "(1,NULL,4)", "(1,2,3)", "(2,0,0)", "(NULL,2,3)", "(NULL,NULL,NULL)"];
  await compareSix(tuples.flatMap(a => tuples.map(b => `SELECT ${
    ["=", "==", "!=", "<>", "<", "<=", ">", ">=", "IS", "IS NOT", "IS DISTINCT FROM", "IS NOT DISTINCT FROM"]
      .map(op => `${a} ${op} ${b}`).join(",")
  }`)));
});

test("row comparisons short-circuit later fields and IS compares TRUE as a value", async () => {
  await compareSix([
    "SELECT (1,abs(-9223372036854775808))<(2,0),(1,abs(-9223372036854775808))=(2,0)",
    "SELECT (1,abs(-9223372036854775808)) IS (2,0),(NULL,abs(-9223372036854775808)) IS (1,0)",
    "SELECT (2,0) IS (TRUE,0),(0,0) IS (FALSE,0),(NULL,0) IS NOT (TRUE,0)",
    "SELECT (1.0,9223372036854775807)=(1,9223372036854775807),(1,0)=(1.0,0.0)",
    "SELECT (x'00',x'01')<(x'00',x'ff'),('a',1)<(x'61',1)",
  ]);
});

test("row affinity and explicit/implicit collation agree with SQLite", async () => {
  await compareSix([
    "SELECT (s,n)=('a','1'),('a','1')=(s,n),(b,0)=('1',0),(n,0)=('1',0) FROM t",
    "SELECT (s COLLATE BINARY,n)=('a',1),(s,n)=('a' COLLATE BINARY,1),('a',1)=(s,n) FROM t",
    "SELECT (r,0)=('a',0),('a',0)=(r,0),(+n,0)=('1',0),(CAST(b AS NUMERIC),0)=('1',0) FROM t",
    "SELECT ('A'||'' COLLATE NOCASE,1)=('a',1),(coalesce('A' COLLATE NOCASE,''),1)=('a',1)",
    "SELECT (CASE WHEN 1 THEN 'A' COLLATE NOCASE ELSE '' END,1)=('a',1)",
    "SELECT (s,n) IS ('a','1'),(s,n) IS DISTINCT FROM ('a','1') FROM t",
    "SELECT ('A'||char(0)||'x',0)=('a'||char(0)||'y' COLLATE NOCASE,0)",
  ], ["CREATE TABLE t(s TEXT COLLATE NOCASE,n NUMERIC,b BLOB,r TEXT COLLATE RTRIM)"],
  ["INSERT INTO t VALUES('A',1,1,'a ')"]);
});

test("row BETWEEN and CASE cache their base and preserve NULLs and lazy arms", async () => {
  await compareSix([
    "SELECT (2026,11,18) BETWEEN (2026,1,1) AND (2026,12,31),(2026,11,18) NOT BETWEEN (2026,1,1) AND (2026,11,17)",
    "SELECT (1,NULL) BETWEEN (0,0) AND (1,1),(1,NULL) NOT BETWEEN (0,0) AND (1,1)",
    "SELECT (1,2) BETWEEN (0,abs(-9223372036854775808)) AND (2,0)",
    "SELECT CASE (1,2) WHEN (2,abs(-9223372036854775808)) THEN 1 WHEN (1,2) THEN 2 ELSE 3 END",
    "SELECT CASE (1,NULL) WHEN (1,NULL) THEN 1 ELSE 2 END",
    "SELECT json_array(CASE (1,2) WHEN (1,2) THEN json_object('v',1) ELSE json_array(2) END)",
    "SELECT CASE (s,n) WHEN ('a','1') THEN 'same' ELSE 'other' END FROM t",
  ], ["CREATE TABLE t(s TEXT COLLATE NOCASE,n NUMERIC)"], ["INSERT INTO t VALUES('A',1)"]);
});

test("TRUE/FALSE column names and merged join affinity remain column metadata", async () => {
  await compareSix([
    "SELECT (true,0)=('a',0),(+true,0)=('a',0),(CAST(true AS TEXT),0)=('a',0),(false,0)=(true,0) FROM words",
    "SELECT a.k,b.k,(k,0)=('1',0),('2',0)=(k,0),(a.k,0)=(b.k,0) FROM a FULL JOIN b USING(k) ORDER BY a.k,b.k",
    "SELECT c.true,d.true,(true,0)=(1,0),('2',0)=(true,0) FROM c FULL JOIN d USING(true) ORDER BY c.true,d.true",
  ], ["CREATE TABLE words(true TEXT COLLATE NOCASE,false TEXT)", "CREATE TABLE a(k INTEGER)", "CREATE TABLE b(k TEXT)",
    "CREATE TABLE c(true INTEGER)", "CREATE TABLE d(true TEXT)"],
  ["INSERT INTO words VALUES('A','a')", "INSERT INTO a VALUES(1),(NULL)", "INSERT INTO b VALUES('01'),('2')",
    "INSERT INTO c VALUES(1)", "INSERT INTO d VALUES('01'),('2')"]);
});

test("row IN subqueries and lists preserve NULLs, collation, affinity and empty sets", async () => {
  await compareSix([
    "SELECT (1,2) IN (SELECT a,b FROM t),(1,3) IN (SELECT a,b FROM t),(9,9) NOT IN (SELECT a,b FROM t)",
    "SELECT (1,2) IN (SELECT * FROM (SELECT a,b FROM t))",
    "SELECT (1,NULL) IN (SELECT a,b FROM t),(1,3) NOT IN (SELECT a,b FROM t)",
    "SELECT (NULL,1) IN (SELECT a,b FROM t WHERE 0),(NULL,1) NOT IN (SELECT a,b FROM t WHERE 0)",
    "SELECT (s,0) IN (SELECT 'a' COLLATE BINARY,0),('a',0) IN (SELECT s,0 FROM text_t) FROM text_t",
    "SELECT ('1',0) IN (SELECT n,0 FROM text_t),('1',0) IN (SELECT b,0 FROM text_t)",
    "SELECT (1,2) IN ((1,2),(3,4)),(1,3) IN ((1,NULL),(2,3)),(NULL,1) NOT IN ()",
    "SELECT (abs(-9223372036854775808),1) IN ()",
    "SELECT ('A',0) IN (('x' COLLATE BINARY,0),('a' COLLATE NOCASE,0)),('A',0) IN (('x' COLLATE NOCASE,0),('a' COLLATE BINARY,0))",
    "SELECT ('1',0) IN ((b,0),(n,0)),('1',0) IN ((n,0),(b,0)) FROM text_t",
    "SELECT (1,0) IN (('1',0),(n,1)),('1',0) IN ((1,0),(s,1)) FROM text_t",
    "SELECT id FROM t WHERE (a,b) IN (SELECT a,b FROM t other WHERE other.id<t.id) ORDER BY id",
  ], ["CREATE TABLE t(id INTEGER PRIMARY KEY,a INTEGER,b INTEGER)", "CREATE TABLE text_t(s TEXT COLLATE NOCASE,n NUMERIC,b BLOB)"],
  ["INSERT INTO t VALUES(1,1,2),(2,1,NULL),(3,2,3),(4,1,2)", "INSERT INTO text_t VALUES('A',1,1)"]);
});

test("cursor pagination reuses live binds on all six paths", async () => {
  const schema = ["CREATE TABLE t(id INTEGER PRIMARY KEY,created TEXT,v TEXT)", "CREATE INDEX by_created ON t(created,id)"];
  const seed = "INSERT INTO t VALUES(1,'2026-11-17','a'),(2,'2026-11-17','b'),(3,'2026-11-18','c'),(9007199254740993,'2026-11-18','d')";
  const query = "SELECT id,v FROM t WHERE (created,id)>(?1,?2) ORDER BY created,id LIMIT ?3";
  const paths = await sqlikePaths(schema, [{ name: "seed", sql: seed, write: true }, { name: "q", sql: query }]);
  const packed = buildDefinedCatalog({ schema, queries: [{ name: "seed", sql: seed }, { name: "q", sql: query }] });
  const wasm = (await WebAssembly.instantiate(readFileSync("_build/wasm-gc/release/build/mizchi/sqlike/defined/defined.wasm"), {},
    { builtins: ["js-string"], importedStringConstants: "_" })).instance.exports;
  const dbs = await Promise.all([binary, definedWasm(wasm)].map(r => createDefinedDatabase(r).memory(packed)));
  const native = new NodeDatabase(":memory:");
  try {
    schema.forEach(sql => native.raw.exec(sql)); native.raw.exec(seed);
    paths.forEach(p => p.exec("seed")); for (const db of dbs) await db.execute("seed");
    const params: Value[][] = [["2026-11-17", 0n, 2n], ["2026-11-17", 2n, 2n], ["2026-11-18", 3n, 2n],
      ["2026-11-18", 9007199254740993n, 2n], [null, 0n, 2n], ["2026-11-17", "1", 3n]];
    for (const values of params) {
      const expected = nativeValues(native, query, values);
      for (const p of paths) assert.deepEqual(p.exec("q", values), expected);
      for (const db of dbs) assert.deepEqual((await db.execute("q", values)).rows, expected);
    }
  } finally { native.close(); await Promise.all(dbs.map(db => db.close())); }
});

test("invalid row widths and scalar positions reject even on empty reads and writes", async () => {
  const schema = ["CREATE TABLE t(a INTEGER,b INTEGER)"];
  const native = new NodeDatabase(":memory:"); const moon = new MoonDatabase();
  try {
    for (const db of [native, moon]) { db.run(schema[0]!); db.run("INSERT INTO t VALUES(1,2)"); }
    for (const sql of [
      "SELECT (a,b)=(1,2,3) FROM t WHERE 0", "SELECT (a,b)=1 FROM t WHERE 0", "SELECT (a,b) FROM t WHERE 0",
      "SELECT abs((a,b)) FROM t WHERE 0", "SELECT ((a,b),1)=(1,2) FROM t WHERE 0",
      "SELECT (a,b) COLLATE NOCASE=(1,2) FROM t WHERE 0", "SELECT (a,b) IN (SELECT a FROM t) FROM t WHERE 0",
      "SELECT CASE (a,b) WHEN 1 THEN 1 END FROM t WHERE 0", "SELECT (a,b) IN (1,2) FROM t WHERE 0",
      "UPDATE t SET a=0 WHERE (a,b)=(1,2,3)", "UPDATE t SET a=0 RETURNING (a,b)",
    ]) {
      assert.throws(() => native.run(sql), sql); assert.throws(() => moon.run(sql), sql);
      assert.throws(() => buildCatalog({ schema, queries: [{ name: "bad", sql }] }), sql);
    }
    assert.deepEqual(moon.queryValues("SELECT * FROM t"), [[1n,2n]]);
  } finally { native.close(); moon.close(); }
});

test("indexed row predicates retain suffix tests, reverse scans and changing keys", async () => {
  await compareSix([
    ...["=", "<", "<=", ">", ">="].flatMap(op => [
      `SELECT id FROM t WHERE (a,b)${op}('a',2) ORDER BY a,b,id`,
      `SELECT id FROM t WHERE ('a',2)${op}(a,b) ORDER BY a DESC,b DESC,id DESC`,
    ]),
    "UPDATE t SET a='c',b=5 WHERE (a,b)=('a',2) RETURNING id",
    "SELECT id FROM t WHERE (a,b)>('a',2) ORDER BY a,b,id",
    "DELETE FROM t WHERE (a,b)<('b',0) RETURNING id",
    "SELECT id FROM t WHERE (a,b)>('a',2) ORDER BY a,b,id",
  ], ["CREATE TABLE t(id INTEGER PRIMARY KEY,a TEXT COLLATE NOCASE,b INTEGER)", "CREATE INDEX ix ON t(a,b)"],
  ["INSERT INTO t VALUES(1,'a',1),(2,'A',2),(3,'a',3),(4,'b',0),(5,'a',NULL),(6,NULL,9)"]);
});

test("unverified row subquery operands, compound IN and mixed-star metadata reject explicitly", () => {
  for (const sql of [
    "SELECT (1,2)=(SELECT 1,2)", "SELECT ((SELECT 1),2)=(1,2)",
    "SELECT (1,2) IN (SELECT 1,2 UNION ALL SELECT 3,4)",
    "SELECT (1,2,3) IN (SELECT t.*,1 FROM t)",
    "SELECT (1,2) IN (SELECT a.a,b.a FROM t a FULL JOIN t b USING(a))",
  ]) assert.throws(() => buildCatalog({ schema: ["CREATE TABLE t(a INTEGER,b INTEGER)"], queries: [{ name: "q", sql }] }), /unsupported|row value/);
});

test("row comparison errors after an earlier write roll back the entire statement", async () => {
  const schema = ["CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)"];
  const update = "UPDATE t SET n=n+1 WHERE (id,abs(n)) >= (1,0)";
  const paths = await sqlikePaths(schema, [
    { name: "seed", sql: "INSERT INTO t VALUES(1,1),(2,-9223372036854775808)", write: true },
    { name: "bad", sql: update, write: true }, { name: "get", sql: "SELECT id,n FROM t ORDER BY id" },
  ]);
  // First key differs on row 2, so its abs() is skipped. Change the first key
  // to force the error only after the first row has been processed.
  const bad = "UPDATE t SET n=n+1 WHERE (0,abs(n)) >= (0,0)";
  const failing = await sqlikePaths(schema, [
    { name: "seed", sql: "INSERT INTO t VALUES(1,1),(2,-9223372036854775808)", write: true },
    { name: "bad", sql: bad, write: true }, { name: "get", sql: "SELECT id,n FROM t ORDER BY id" },
  ]);
  for (const p of paths) { p.exec("seed"); p.exec("bad"); assert.deepEqual(p.exec("get"), [[1n,2n],[2n,-9223372036854775807n]]); }
  for (const p of failing) {
    p.exec("seed"); const before = p.dump(); assert.throws(() => p.exec("bad"), /overflow/);
    assert.equal(p.dump(), before); assert.deepEqual(p.exec("get"), [[1n,1n],[2n,-9223372036854775808n]]);
  }
});
