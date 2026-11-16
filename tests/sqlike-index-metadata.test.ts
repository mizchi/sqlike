import { test } from "node:test";
import assert from "node:assert/strict";
import { compareQueries, sqlikePaths } from "./compatibility/sqlike-paths.ts";

test("index metadata matches SQLite explicit, partial, expression and implicit rowid indexes", async () => {
  const schema = [
    "CREATE TABLE t(id INTEGER PRIMARY KEY,a TEXT COLLATE NOCASE,b BLOB UNIQUE,UNIQUE(a,id))",
    "CREATE INDEX ix ON t(a COLLATE BINARY DESC,id)",
    "CREATE UNIQUE INDEX partial ON t(lower(a)) WHERE id>0",
    "CREATE INDEX collated_expression ON t(substr(a COLLATE NOCASE,1))",
  ];
  await compareQueries(
    [
      "PRAGMA index_list(t)",
      ...[
        "ix",
        "partial",
        "collated_expression",
        "sqlite_autoindex_t_1",
        "sqlite_autoindex_t_2",
        "missing",
      ].flatMap((n) => [`PRAGMA index_info(${n})`, `PRAGMA index_xinfo(${n})`]),
      "PRAGMA index_list(missing)",
    ],
    schema,
  );
});

test("WITHOUT ROWID metadata distinguishes key columns from auxiliary payload", async () => {
  await compareQueries(
    [
      "PRAGMA index_list(t)",
      ...["t", "ix", "sqlite_autoindex_t_1"].flatMap((n) => [
        `PRAGMA index_info(${n})`,
        `PRAGMA index_xinfo(${n})`,
      ]),
    ],
    [
      "CREATE TABLE t(a TEXT COLLATE NOCASE,b INTEGER,c BLOB,PRIMARY KEY(a,b)) WITHOUT ROWID",
      "CREATE INDEX ix ON t(b DESC,c)",
    ],
  );
});

test("metadata refuses ambiguous legacy implicit-index numbering", async () => {
  const paths = await sqlikePaths(
    ["CREATE TABLE t(a TEXT PRIMARY KEY,b TEXT UNIQUE)"],
    [{ name: "q", sql: "SELECT 1" }],
  );
  assert.equal(paths.length, 4);
  // Separate compilation must reject metadata whose numbering is not retained.
  await assert.rejects(
    sqlikePaths(
      ["CREATE TABLE t(a TEXT PRIMARY KEY,b TEXT UNIQUE)"],
      [{ name: "q", sql: "PRAGMA index_list(t)" }],
    ),
    /unsupported.*index.*metadata/,
  );
});
