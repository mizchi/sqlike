import { test } from "node:test";
import { compareQueries } from "./compatibility/sqlike-paths.ts";
import { MoonDatabase, type MoonSqlRuntime } from "../adapters/moon-database.ts";
import { compile_program } from "../_build/js/release/build/mizchi/sqlike/compiler/compiler.js";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";

test("reserved IR calls cannot be injected through SQL function names", async () => {
  const native = new DatabaseSync(":memory:");
  const schema = ["CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT)"];
  native.exec(schema[0]!);
  const wasm = (
    await WebAssembly.instantiate(
      readFileSync("_build/wasm-gc/release/build/mizchi/sqlike/sqlike.wasm"),
      {},
      { builtins: ["js-string"], importedStringConstants: "_" },
    )
  ).instance.exports as unknown as MoonSqlRuntime;
  const candidates = [new MoonDatabase(), new MoonDatabase(undefined, undefined, wasm)];
  for (const db of candidates) db.run(schema[0]!);
  try {
    for (const sql of [
      'SELECT id FROM t ORDER BY "$nulls-first"(v)',
      'SELECT sum("$filter"(id,id>1)) FROM t',
      'SELECT count("$distinct"(v)) FROM t',
    ]) {
      assert.throws(() => native.prepare(sql), /no such function/);
      for (const db of candidates) assert.throws(() => db.values(sql), /reserved|unsupported/);
      const compiled = JSON.parse(
        compile_program(JSON.stringify({ schema, queries: [{ name: "q", sql }] })),
      );
      assert.match(compiled.error ?? "", /reserved|unsupported/);
    }
  } finally {
    native.close();
    for (const db of candidates) db.close();
  }
});

test("explicit NULL ordering preserves ordinals, aliases, collations, compound SELECT and LIMIT", async () => {
  const schema = [
    "CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT COLLATE NOCASE)",
    "CREATE INDEX ix ON t(v)",
  ];
  const seed = ["INSERT INTO t VALUES(1,NULL),(2,'Z'),(3,'a'),(4,NULL),(5,'A')"];
  await compareQueries(
    [
      "SELECT id FROM t ORDER BY id LIMIT 1.0 OFFSET '1.0'",
      "SELECT id FROM t UNION ALL SELECT 99 ORDER BY 1 LIMIT '2' OFFSET 1.0",
    ],
    schema,
    seed,
  );
  await compareQueries(
    ["ASC", "DESC"].flatMap((direction) =>
      ["FIRST", "LAST"].flatMap((where) => [
        `SELECT id,v FROM t ORDER BY v ${direction} NULLS ${where},id`,
        `SELECT v AS x,id FROM t ORDER BY 1 ${direction} NULLS ${where},id LIMIT 3 OFFSET 1`,
        `SELECT v AS x,id FROM t ORDER BY x ${direction} NULLS ${where},id`,
        // Explicit tie-breaking avoids depending on native index scan direction.
        `SELECT v FROM t UNION ALL SELECT NULL ORDER BY 1 ${direction} NULLS ${where},1 COLLATE BINARY`,
        `SELECT id,row_number() OVER(ORDER BY v ${direction} NULLS ${where},id) FROM t ORDER BY id`,
        `SELECT id,rank() OVER(ORDER BY v ${direction} NULLS ${where}) FROM t ORDER BY id`,
        `SELECT id,sum(id) OVER(ORDER BY v ${direction} NULLS ${where} RANGE BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) FROM t ORDER BY id`,
      ]),
    ),
    schema,
    seed,
  );
  await compareQueries(
    ["ASC", "DESC"].flatMap((direction) =>
      ["FIRST", "LAST"].map(
        (where) =>
          `SELECT id,sum(id) OVER(ORDER BY n ${direction} NULLS ${where} RANGE BETWEEN 1 PRECEDING AND 1 FOLLOWING) FROM n ORDER BY id`,
      ),
    ),
    ["CREATE TABLE n(id INTEGER PRIMARY KEY,n INTEGER)"],
    ["INSERT INTO n VALUES(1,NULL),(2,1),(3,2),(4,NULL),(5,4)"],
  );
});
