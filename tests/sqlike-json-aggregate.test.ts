import { test } from "node:test";
import assert from "node:assert/strict";
import { compareQueries, sqlikePaths } from "./compatibility/sqlike-paths.ts";

test("JSON aggregates preserve scalar types, duplicate labels, subtypes, DISTINCT and empty groups", async () => {
  await compareQueries(
    [
      "SELECT json_group_array(v),json_group_object(k,v) FROM t",
      "SELECT json_group_array(json(v)),json_group_object(k,json(v)) FROM t",
      "SELECT json_group_array(DISTINCT k) FROM t",
      "SELECT k,json_group_array(v) FROM t GROUP BY k ORDER BY k",
      "SELECT json_array(json_group_array(v)),json_array(json_group_object(k,v)) FROM t",
      "SELECT json_group_array(v),json_group_object(k,v) FROM t WHERE 0",
      "SELECT json_group_array(json(v)) FILTER(WHERE id<3),json_group_object(k,v) FILTER(WHERE id<3) FROM t",
      "SELECT json_group_array(1.0),json_group_array(9223372036854775807),json_group_object(0.5,1)",
    ],
    ["CREATE TABLE t(id INTEGER PRIMARY KEY,k TEXT COLLATE NOCASE,v TEXT)"],
    [`INSERT INTO t VALUES(1,'a','1'),(2,'a','{"x":2}'),(3,'A','"s"'),(4,'b',NULL)`],
  );
});

test("JSON aggregate nonfinite numbers retain SQLite's JSON spelling", async () => {
  await compareQueries([
    "SELECT json_group_array(1e999),json_group_array(-1e999)",
    "SELECT json_group_array(-0.0),json_group_array(1e-8),json_group_array(1.2345678901234567)",
    "SELECT json_quote(1e999),json_array(1e999,-1e999)",
  ]);
});

test("unverified JSON aggregate BLOB/null-label and window forms reject", async () => {
  for (const sql of ["SELECT json_group_array(x'00')", "SELECT json_group_object(NULL,1)"]) {
    const paths = await sqlikePaths([], [{ name: "q", sql }]);
    for (const path of paths) assert.throws(() => path.exec("q"), /BLOB|NULL/);
  }
  await assert.rejects(
    sqlikePaths([], [{ name: "q", sql: "SELECT json_group_array(1) OVER()" }]),
    /window/,
  );
});
