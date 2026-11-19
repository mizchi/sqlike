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

const schema = ["CREATE TABLE t(id INTEGER PRIMARY KEY,k TEXT COLLATE NOCASE,v TEXT,n INTEGER)"];
const seed = "INSERT INTO t VALUES(1,'a','1',3),(2,'A','{\"x\":2}',1),(3,'b','\"s\"',2),(4,NULL,NULL,NULL),(5,'a','false',2)";

async function compareSix(queries: string[]) {
  await compareQueries(queries, schema, [seed]);
  const catalog = buildDefinedCatalog({
    schema,
    queries: [{ name: "seed", sql: seed }, ...queries.map((sql, i) => ({ name: `q${i}`, sql }))],
  });
  const wasm = (await WebAssembly.instantiate(readFileSync(
    "_build/wasm-gc/release/build/mizchi/sqlike/defined/defined.wasm",
  ), {}, { builtins: ["js-string"], importedStringConstants: "_" })).instance.exports;
  const native = new NodeDatabase(":memory:");
  try {
    native.raw.exec(schema[0]!);
    native.raw.exec(seed);
    for (const r of [binary, definedWasm(wasm)]) {
      const db = await createDefinedDatabase(r).memory(catalog);
      try {
        await db.execute("seed");
        for (const [i, sql] of queries.entries())
          assert.deepEqual((await db.execute(`q${i}`)).rows, nativeValues(native, sql), sql);
      } finally { await db.close(); }
    }
  } finally { native.close(); }
}

test("aggregate ORDER BY preserves independent orders, ties, collations, NULL placement and separators", async () => {
  await compareSix([
    "SELECT group_concat(v ORDER BY n),group_concat(v ORDER BY n DESC,id DESC) FROM t",
    "SELECT string_agg(k,':' ORDER BY n NULLS LAST,id DESC),group_concat(v,'/' ORDER BY n DESC NULLS FIRST,id) FROM t",
    "SELECT group_concat(k ORDER BY k COLLATE NOCASE DESC,id),group_concat(k ORDER BY k COLLATE BINARY) FROM t",
    "SELECT group_concat(v,CAST(id AS TEXT) ORDER BY id DESC),group_concat(v,NULL ORDER BY id) FROM t",
    "SELECT group_concat(v ORDER BY 1),group_concat(v ORDER BY 1 DESC) FROM t",
    "SELECT k,group_concat(v ORDER BY n DESC,id),count(n ORDER BY id),sum(n ORDER BY n DESC) FROM t GROUP BY k ORDER BY k",
    "SELECT group_concat(v ORDER BY n) FILTER(WHERE id<4),count(n ORDER BY n) FILTER(WHERE n>1) FROM t",
    "SELECT group_concat(v ORDER BY n),count(n ORDER BY n),total(n ORDER BY n),json_group_array(v ORDER BY n) FROM t WHERE 0",
    "SELECT (SELECT group_concat(v ORDER BY id DESC) FROM t WHERE t.n=outer_t.n) FROM t AS outer_t ORDER BY id",
  ]);
});

test("ordered DISTINCT uses the input collation and SQLite's representative for identical ordering expressions", async () => {
  await compareSix([
    "SELECT group_concat(DISTINCT k ORDER BY id DESC),json_group_array(DISTINCT k ORDER BY id DESC) FROM t",
    "SELECT group_concat(DISTINCT k ORDER BY k),group_concat(DISTINCT k ORDER BY k DESC) FROM t",
    "SELECT json_group_array(DISTINCT k ORDER BY k),json_group_array(DISTINCT k ORDER BY k DESC NULLS LAST) FROM t",
    "SELECT group_concat(DISTINCT k ORDER BY k,id DESC),group_concat(DISTINCT k COLLATE BINARY ORDER BY k) FROM t",
    "SELECT count(DISTINCT n ORDER BY id DESC),sum(DISTINCT n ORDER BY n DESC),avg(DISTINCT n ORDER BY id) FROM t",
    "SELECT group_concat(DISTINCT k ORDER BY t.K),group_concat(DISTINCT lower(k) ORDER BY lower(t.k)) FROM t",
    "SELECT group_concat(DISTINCT CASE WHEN id>0 THEN k END COLLATE NOCASE ORDER BY CASE WHEN t.id>0 THEN t.K END COLLATE NOCASE) FROM t",
  ]);
});

test("ordered JSON aggregates retain JSON subtypes, duplicate keys and raw string values", async () => {
  await compareSix([
    "SELECT json_group_array(v ORDER BY n DESC,id),json_group_array(json(v) ORDER BY n DESC,id) FROM t",
    "SELECT json_group_object(coalesce(k,'null'),json(v) ORDER BY id DESC) FROM t",
    "SELECT json_group_array(json_object('id',id) ORDER BY n NULLS LAST,id DESC) FILTER(WHERE n>1) FROM t",
    "SELECT json_array(json_group_array(json(v) ORDER BY n,id)) FROM t",
  ]);
});

test("ordered aggregates distinguish merged USING columns from their physical inputs", async () => {
  await compareQueries([
    "SELECT group_concat(k ORDER BY a.k,1),group_concat(k ORDER BY b.k,1),group_concat(DISTINCT k ORDER BY k) FROM a FULL JOIN b USING(k)",
    "SELECT group_concat(k ORDER BY a.k,1),group_concat(b.k ORDER BY a.k,1),group_concat(b.k ORDER BY b.k) FROM a RIGHT JOIN b USING(k)",
  ], ["CREATE TABLE a(k TEXT COLLATE NOCASE)", "CREATE TABLE b(k TEXT COLLATE NOCASE)"],
  ["INSERT INTO a VALUES('a'),('A')", "INSERT INTO b VALUES('b'),('B')"]);
  for (const distinct of ["", "DISTINCT "]) assert.throws(() => buildCatalog({
    schema: ["CREATE TABLE a(k TEXT COLLATE NOCASE)", "CREATE TABLE b(k TEXT COLLATE NOCASE)"],
    queries: [{ name: "q", sql: `SELECT group_concat(${distinct}k ORDER BY a.k) FROM a LEFT JOIN b USING(k) WHERE 0` }],
  }), /unsupported aggregate ordering of merged join columns/);
  assert.throws(() => buildCatalog({
    schema: ["CREATE TABLE a(k TEXT)", "CREATE TABLE b(k TEXT)"],
    queries: [{ name: "q", sql: "SELECT group_concat(b.k ORDER BY a.k) FROM a RIGHT JOIN b USING(k)" }],
  }), /unsupported aggregate ordering of merged join columns/);
});

test("ordered numeric aggregates preserve storage classes, numeric equivalence and RTRIM representatives", async () => {
  await compareQueries([
    ...["count", "sum", "total", "avg", "min", "max", "group_concat"].flatMap(f => [
      `SELECT ${f}(v ORDER BY v DESC NULLS LAST,id) FROM t`,
      `SELECT ${f}(DISTINCT v ORDER BY v DESC) FROM t`,
      `SELECT ${f}(DISTINCT v ORDER BY id DESC) FROM t`,
    ]),
  ], ["CREATE TABLE t(id INTEGER PRIMARY KEY,v BLOB COLLATE RTRIM)"],
  ["INSERT INTO t VALUES(1,NULL),(2,0),(3,0.0),(4,'x'),(5,'x '),(6,x'31'),(7,3.5),(8,-2),(9,'12')"]);
});

test("aggregate ordering cannot bypass conservative JSON subtype validation", async () => {
  for (const sql of [
    "SELECT json_array(min(json(v) ORDER BY id)) FROM t WHERE 0",
    "SELECT json_array(max(DISTINCT json(v) ORDER BY id) FILTER(WHERE 0)) FROM t WHERE 0",
  ]) {
    assert.throws(() => buildCatalog({ schema, queries: [{ name: "q", sql }] }), /unsupported JSON subtype/);
    const db = new MoonDatabase();
    try {
      db.run(schema[0]!);
      assert.throws(() => db.queryValues(sql), /unsupported JSON subtype/);
    } finally { db.close(); }
  }
});

test("ordered aggregates filter before evaluating keys and min/max ignore their sort expressions", async () => {
  await compareQueries([
    "SELECT sum(n ORDER BY id),total(n ORDER BY id),avg(n ORDER BY id) FROM t",
    "SELECT sum(n ORDER BY abs(n)) FILTER(WHERE id<3) FROM t",
    "SELECT min(n ORDER BY abs(n)),max(n ORDER BY abs(n)) FROM t",
    "SELECT min(DISTINCT n ORDER BY abs(n)),max(DISTINCT n ORDER BY abs(n)) FROM t",
  ], ["CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)"],
  ["INSERT INTO t VALUES(1,9223372036854775807),(2,-9223372036854775807),(3,-9223372036854775808)"]);
});

test("ordered aggregates reuse live bindings in SQL and AOT", async () => {
  const sql = "SELECT group_concat(v,?2 ORDER BY CASE WHEN ?1 THEN -id ELSE id END) FILTER(WHERE n>=?3) FROM t";
  const paths = await sqlikePaths(schema, [{ name: "seed", sql: seed, write: true }, { name: "q", sql }]);
  const native = new NodeDatabase(":memory:");
  try {
    native.raw.exec(schema[0]!); native.raw.exec(seed);
    for (const p of paths) p.exec("seed");
    for (const params of [[0n, ":", 1n], [1n, "/", 2n], [0n, null, 3n], [1n, "", 0n]])
      for (const p of paths) assert.deepEqual(p.exec("q", params), nativeValues(native, sql, params));
  } finally { native.close(); }
});

test("invalid aggregate ordering rejects before empty reads or writes publish changes", async () => {
  const wasm = (await WebAssembly.instantiate(readFileSync(
    "_build/wasm-gc/release/build/mizchi/sqlike/full/full.wasm",
  ), {}, { builtins: ["js-string"], importedStringConstants: "_" })).instance.exports;
  const native = new NodeDatabase(":memory:");
  const dbs = [new MoonDatabase(), new MoonDatabase(undefined, undefined, wasm as unknown as MoonSqlRuntime)];
  try {
    for (const db of [native, ...dbs]) { db.run(schema[0]!); db.run(seed); }
    for (const sql of [
      "SELECT abs(n ORDER BY id) FROM t WHERE 0",
      "SELECT count(* ORDER BY id) FROM t WHERE 0",
      "SELECT group_concat(v ORDER BY id) OVER() FROM t WHERE 0",
      "SELECT group_concat(v ORDER BY missing) FROM t WHERE 0",
      "SELECT group_concat(v ORDER BY sum(n)) FROM t WHERE 0",
      "UPDATE t SET v=(SELECT group_concat(v ORDER BY missing) FROM t)",
      "UPDATE t SET v='x' RETURNING group_concat(v ORDER BY id)",
    ]) {
      assert.throws(() => native.run(sql), sql);
      for (const db of dbs) assert.throws(() => db.run(sql), sql);
      assert.throws(() => buildCatalog({ schema, queries: [{ name: "bad", sql }] }), sql);
    }
    for (const db of dbs) assert.deepEqual(db.queryValues("SELECT * FROM t ORDER BY id"), nativeValues(native, "SELECT * FROM t ORDER BY id"));
  } finally { native.close(); dbs.forEach(db => db.close()); }
});
