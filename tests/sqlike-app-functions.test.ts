import { test } from "node:test";
import assert from "node:assert/strict";
import { compareQueries } from "./compatibility/sqlike-paths.ts";
test("CAST matches SQLite conversion, type affinity, prefix parsing and int64 saturation on all four paths", async () => {
  const values = [
    "NULL",
    "'123tail'",
    "'123e+5'",
    "'  -42.8x'",
    "'0x10'",
    "'abc'",
    "'9223372036854775808'",
    "'-9223372036854775809'",
    "'9007199254740993'",
    "'1.0'",
    "1.8",
    "-1.8",
    "X'313233'",
  ];
  await compareQueries(
    values
      .flatMap((v) =>
        ["INTEGER", "REAL", "TEXT", "BLOB", "NUMERIC"].map(
          (t) =>
            `SELECT CAST(${v} AS ${t}) AS v,typeof(CAST(${v} AS ${t})) AS t`,
        ),
      )
      .concat([
        "SELECT CAST('2' AS INTEGER)='2',CAST('2' AS TEXT)=2,CAST(NULL AS INTEGER)",
        ...["INTEGER", "REAL", "BLOB", "NUMERIC"].map(
          (t) => `SELECT CAST(X'00ff' AS ${t}),typeof(CAST(X'00ff' AS ${t}))`,
        ),
      ]),
  );
});
test("JSON extraction and editing preserve paths, SQL types, missing vs null and nested JSON values", async () => {
  await compareQueries([
    `SELECT json_valid(NULL),json_valid('bad'),json_valid('{"a":1}'),json_valid('[1,]')`,
    `SELECT json_extract('{"a":[1,{"b":true},null,9223372036854775807]}','$.a[1].b','$.a[3]','$.missing')`,
    `SELECT json_extract('{"a":[1,2,3]}','$.a[#-1]'),json_type('{"a":null}','$.a'),json_type('{}','$.a')`,
    `SELECT json_set('{}','$.a.b',3,'$.c[0]',4),json_set('[1,2]','$[#]',3,'$[0]',9)`,
    `SELECT json_insert('{"a":1}','$.a',2,'$.b',3),json_replace('{"a":1}','$.a',2,'$.b',3)`,
    `SELECT json_remove('[1,2,3]','$[0]','$[0]'),json_array_length('{"a":[1,2]}','$.a')`,
    `SELECT json_object('a',json('[1,2]'),'b','[1,2]'),json_array(1,NULL,'x',json('{"b":true}'))`,
    `SELECT json_quote('x'),json_quote(NULL),json('{ "a" : 1 }')`,
    `SELECT json_patch('{"a":1,"b":{"c":2}}','{"a":null,"b":{"d":3}}')`,
  ]);
});
test("UTC date/time functions match SQLite at leap days, timezone offsets, epoch boundaries and modifiers", async () => {
  await compareQueries([
    "SELECT date('2024-02-29','+1 day'),datetime('2024-02-29 23:59:59','+1 second')",
    "SELECT datetime('2024-01-01T00:00:00+09:00'),unixepoch('1970-01-01 00:00:00'),unixepoch('1969-12-31 23:59:59')",
    "SELECT datetime(0,'unixepoch'),date(2460000.5),datetime(-1,'unixepoch')",
    "SELECT date('2024-02-29','+1 year'),date('2024-02-29','+1 year','floor'),date('2024-01-31','+1 month')",
    "SELECT date('2024-05-17','start of month','+1 month','-1 day'),date('2024-05-17','weekday 1')",
    "SELECT strftime('%Y-%m-%d %H:%M:%S %w %j %s','2024-02-29 12:34:56')",
    "SELECT strftime('%f','2000-01-01 00:00:00.125'),time('12:34:56.789','+1 hour'),julianday('2000-01-01 12:00:00')",
    "SELECT date(NULL),datetime('bad'),strftime('%Q','2024-01-01'),date('2024-02-30')",
  ]);
});
test("host clock is statement-local and CURRENT_TIMESTAMP defaults persist as concrete values", async () => {
  const sql = await import(
    "../_build/js/release/build/mizchi/sqlike/full/full.js"
  );
  const { result } = await import("./compatibility/sqlike-paths.ts");
  const { aotValue } = await import("../src/aot-values.ts");
  const db = sql.database_open();
  sql.database_set_clock(db, "1704067200125");
  result(
    sql.database_exec(
      db,
      "CREATE TABLE t(id INTEGER PRIMARY KEY,created TEXT DEFAULT CURRENT_TIMESTAMP)",
      "[]",
      false,
    ),
  );
  result(sql.database_exec(db, "INSERT INTO t(id) VALUES(1)", "[]", false));
  const rows = result(
    sql.database_query_values(
      db,
      "SELECT created,date('now'),unixepoch('now','subsec') FROM t",
      "[]",
    ),
  ).rows.map((row: any[]) => row.map(aotValue));
  assert.deepEqual(rows, [
    ["2024-01-01 00:00:00", "2024-01-01", 1704067200.125],
  ]);
});
test("JSON value subtypes keep numeric-looking strings distinct from nested arrays and objects", async () => {
  await compareQueries([
    `SELECT json_object('s',json_extract('{"s":"123"}','$.s'),'o',json_extract('{"o":{"a":1}}','$.o'))`,
    `SELECT json_array(json_extract('{"s":"[1,2]"}','$.s'),json_quote('hello'))`,
    `SELECT json_object('s',coalesce(json('[1,2]'),'fallback'))`,
    `SELECT json_valid('{"a":1,"a":2}')`,
  ]);
});
test("strftime handles ISO week years and weekdays before the Unix epoch", async () => {
  await compareQueries([
    "SELECT strftime('%w %u %W %U %V %G %g','1950-01-01')",
    "SELECT strftime('%V %G %g','2021-01-01'),strftime('%V %G','2019-12-30')",
  ]);
});

test("duplicate JSON labels preserve order and first-member edits like SQLite", async () => {
  await compareQueries(
    [
      "INSERT INTO t VALUES(json_object('a',1,'a',2))",
      `INSERT INTO t VALUES(json_set('{"a":1,"a":2}','$.b',3))`,
      "SELECT value FROM t ORDER BY rowid",
    ],
    ["CREATE TABLE t(value TEXT)"],
  );
});
