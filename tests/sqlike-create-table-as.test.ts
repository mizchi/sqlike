import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as sql from "../_build/js/release/build/mizchi/sqlike/full/full.js";
import { MoonDatabase } from "../adapters/moon-database.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "./compatibility/native-values.ts";
import { compareSixQueries } from "./compatibility/six-paths.ts";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import { analyzeCatalogRequirements } from "../scripts/analyze-catalog.ts";

test("CTAS copies SELECT order and affinities while removing PK, constraints, defaults and collation", async () => {
  const wasm = (
    await WebAssembly.instantiate(
      readFileSync("_build/wasm-gc/release/build/mizchi/sqlike/full/full.wasm"),
      {},
      { builtins: ["js-string"], importedStringConstants: "_" },
    )
  ).instance.exports as unknown as typeof sql;
  for (const raw of [sql, wasm]) {
    const moon = new MoonDatabase(undefined, undefined, raw),
      native = new NodeDatabase(":memory:");
    try {
      for (const statement of [
        "CREATE TABLE s(id INTEGER PRIMARY KEY,v TEXT NOT NULL COLLATE NOCASE DEFAULT 'x',n NUMERIC,r REAL,b BLOB)",
        "INSERT INTO s VALUES(10,'b','3',2,x'ff'),(20,'A',4,3,NULL)",
        "CREATE TABLE t AS SELECT id,v,n,r,b,id+1 AS calc,CAST(id AS TEXT) AS text_id FROM s ORDER BY id DESC",
      ]) {
        native.raw.exec(statement);
        moon.run(statement);
      }
      for (const query of [
        "PRAGMA table_info(t)",
        "SELECT rowid,*,typeof(id),typeof(r) FROM t ORDER BY rowid",
        "SELECT sql FROM sqlite_schema WHERE name='t'",
        "SELECT count(*) FROM t WHERE v='a'",
        "SELECT changes(),last_insert_rowid()",
      ])
        assert.deepEqual(
          moon.values(query),
          nativeValues(native, query),
          query,
        );
      native.raw.exec("INSERT INTO t DEFAULT VALUES");
      moon.run("INSERT INTO t DEFAULT VALUES");
      assert.deepEqual(
        moon.values("SELECT rowid,* FROM t ORDER BY rowid"),
        nativeValues(native, "SELECT rowid,* FROM t ORDER BY rowid"),
      );
      assert.deepEqual(
        new MoonDatabase(moon.dump(), undefined, raw).values(
          "SELECT * FROM t ORDER BY rowid",
        ),
        moon.values("SELECT * FROM t ORDER BY rowid"),
      );
    } finally {
      moon.close();
      native.close();
    }
  }
});

test("CTAS names, quoting, schema formatting and deterministic duplicate suffixes match SQLite", () => {
  const native = new NodeDatabase(":memory:"),
    moon = new MoonDatabase();
  try {
    for (const statement of [
      'CREATE TABLE t AS SELECT 1 AS a,2 AS a,3 AS A,4 AS "a:1"',
      'CREATE TABLE "weird table" AS SELECT 1 AS "select",2 AS "a b",3 AS "a""b",4 AS "é",5 AS "1z",6 AS ""',
      "CREATE TABLE empty AS SELECT CAST(1 AS REAL) AS r,CAST(2 AS NUMERIC) AS n WHERE 0",
      "CREATE TABLE truth AS SELECT TRUE,FALSE,TRUE AS t",
      "CREATE TABLE coll AS SELECT CAST('A' AS TEXT) COLLATE NOCASE AS v",
      "CREATE TABLE coll_copy AS SELECT v COLLATE NOCASE FROM coll",
      "CREATE TABLE cte_copy AS WITH c(x) AS(SELECT CAST(3 AS INT)) SELECT x FROM c",
      "CREATE TABLE derived_copy AS SELECT x FROM(SELECT CAST('v' AS TEXT) AS x)",
      "CREATE TABLE window_copy AS SELECT sum(x) OVER(ORDER BY x ROWS 1 PRECEDING) AS n FROM cte_copy",
    ]) {
      native.raw.exec(statement);
      moon.run(statement);
    }
    for (const table of [
      "t",
      "weird table",
      "empty",
      "truth",
      "coll",
      "coll_copy",
      "cte_copy",
      "derived_copy",
      "window_copy",
    ]) {
      for (const query of [
        `PRAGMA table_info("${table}")`,
        `SELECT sql FROM sqlite_schema WHERE name='${table}'`,
        `SELECT * FROM \"${table}\"`,
      ])
        assert.deepEqual(
          moon.values(query),
          nativeValues(native, query),
          query,
        );
    }
  } finally {
    native.close();
    moon.close();
  }
});

test("CTAS refuses compound affinity and random duplicate names before schema publication", () => {
  const moon = new MoonDatabase();
  try {
    for (const statement of [
      "CREATE TABLE bad AS SELECT CAST(1 AS INTEGER) AS x UNION ALL SELECT CAST(2 AS REAL)",
      "CREATE TABLE bad AS SELECT 1 AS a,2 AS a,3 AS a,4 AS a,5 AS a,6 AS a",
    ]) {
      assert.throws(
        () => moon.run(statement),
        /unsupported.*(compound|random)/,
      );
      assert.deepEqual(
        moon.values("SELECT name FROM sqlite_schema WHERE name='bad'"),
        [],
      );
    }
  } finally {
    moon.close();
  }
});

test("CTAS failures are atomic, IF NOT EXISTS skips semantic evaluation, and parameters are live", () => {
  const native = new NodeDatabase(":memory:"),
    moon = new MoonDatabase();
  try {
    for (const statement of [
      "CREATE TABLE s(n INT)",
      "INSERT INTO s VALUES(1),(-9223372036854775808)",
      "CREATE TABLE existing(v)",
      "CREATE TABLE IF NOT EXISTS existing AS SELECT no_column FROM missing",
    ]) {
      native.raw.exec(statement);
      moon.run(statement);
    }
    for (const statement of [
      "CREATE TABLE fail AS SELECT abs(n) AS n FROM s",
      "CREATE TABLE self AS SELECT * FROM self",
      "CREATE TABLE bad AS SELECT missing FROM s",
    ]) {
      assert.throws(() => native.raw.exec(statement));
      assert.throws(() => moon.run(statement));
      assert.deepEqual(
        moon.values("SELECT name FROM sqlite_schema ORDER BY name"),
        nativeValues(native, "SELECT name FROM sqlite_schema ORDER BY name"),
      );
    }
    native.raw.prepare("CREATE TABLE bound AS SELECT ? AS v").run("hello");
    moon.run("CREATE TABLE bound AS SELECT ? AS v", ["hello"]);
    assert.deepEqual(moon.values("SELECT * FROM bound"), [["hello"]]);
    moon.run("BEGIN");
    moon.run("CREATE TABLE rolled AS SELECT 1 AS n");
    moon.run("ROLLBACK");
    assert.deepEqual(
      moon.values("SELECT name FROM sqlite_schema WHERE name='rolled'"),
      [],
    );
  } finally {
    native.close();
    moon.close();
  }
});

test("catalog CTAS materializes initial data for six runtime paths and drops build-only function dependencies", async () => {
  const schema = [
    "CREATE TABLE t AS SELECT CAST(7 AS INTEGER) AS id,lower('HELLO')||json_extract('{\"n\":3}','$.n') AS v",
  ];
  await compareSixQueries(
    [
      "SELECT rowid,* FROM t",
      "PRAGMA table_info(t)",
      "INSERT INTO t VALUES(8,'next') RETURNING rowid,*",
      "SELECT * FROM t ORDER BY rowid",
    ],
    schema,
  );
  assert.deepEqual(
    analyzeCatalogRequirements({
      schema,
      queries: [{ name: "q", sql: "SELECT * FROM t" }],
    }).features,
    [],
  );
  assert.throws(
    () =>
      buildCatalog({
        schema: ["CREATE TABLE t AS SELECT CURRENT_TIMESTAMP AS v"],
        queries: [],
      }),
    /clock|volatile|nondeterministic/,
  );
});
