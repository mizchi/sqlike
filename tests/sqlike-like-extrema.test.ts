import { test } from "node:test";
import assert from "node:assert/strict";
import { compareQueries, sqlikePaths } from "./compatibility/sqlike-paths.ts";

const literal = (s: string) =>
  s.includes("\0")
    ? `CAST(x'${Buffer.from(s).toString("hex")}' AS TEXT)`
    : `'${s.replaceAll("'", "''")}'`;

test("LIKE ESCAPE and like() preserve ASCII case, Unicode, NUL, escaping and precedence on four paths", async () => {
  const inputs = ["", "a", "A", "a_b", "a%b", "a!b", "é😀", "abc!", "abc\0tail"];
  const patterns = ["", "%", "_", "a!_b", "a!%b", "a!!b", "!a", "a%", "abc!", "abc\0!"];
  await compareQueries(
    inputs.flatMap((s) =>
      patterns.flatMap((p) => [
        `SELECT ${literal(s)} LIKE ${literal(p)} ESCAPE '!',${literal(s)} NOT LIKE ${literal(p)} ESCAPE '!'`,
        `SELECT like(${literal(p)},${literal(s)}),like(${literal(p)},${literal(s)},'!')`,
      ]),
    ),
  );
  await compareQueries([
    "SELECT 'a_b' LIKE 'a!_b' ESCAPE upper('!') = 1",
    "SELECT 'a' LIKE 'a' ESCAPE 'A','A' LIKE 'A' ESCAPE 'A'",
    "SELECT 'é😀' LIKE 'é!_' ESCAPE '!', 'é_' LIKE 'é😀_' ESCAPE '😀'",
    "SELECT NULL LIKE '%' ESCAPE '!', 'x' LIKE NULL ESCAPE '!', 'x' LIKE '%' ESCAPE NULL",
    `SELECT 'a_b' LIKE 'a!_b' ESCAPE ${literal("!\0ignored")}`,
  ]);
});

test("scalar extrema preserve NULL propagation, types, ties, collation and aggregate scopes", async () => {
  const values = [
    "NULL",
    "0",
    "1",
    "1.0",
    "-1",
    "9223372036854775807",
    "'1'",
    "'Z'",
    "'a'",
    "x'31'",
  ];
  await compareQueries(
    values.flatMap((a) =>
      values.map(
        (b) => `SELECT min(${a},${b}),typeof(min(${a},${b})),max(${a},${b}),typeof(max(${a},${b}))`,
      ),
    ),
  );
  await compareQueries(
    [
      "SELECT id,min(s,'a'),max(s,'a') FROM t ORDER BY id",
      "SELECT min('Z',s COLLATE BINARY,'a'),max('Z',s COLLATE BINARY,'a') FROM t ORDER BY id",
      "SELECT min(+s,'a'),max(CAST(s AS TEXT),'a') FROM t ORDER BY id",
      "SELECT min('Z'||('' COLLATE NOCASE),'a'),min(CASE WHEN 1 THEN 'Z' COLLATE NOCASE END,'a')",
      "SELECT min(lower('Z' COLLATE NOCASE),'a'),max(substr('A' COLLATE NOCASE,1),'a')",
      "SELECT min((SELECT s FROM t LIMIT 1),'a'),min((SELECT 'Z'),'a' COLLATE NOCASE)",
      "SELECT id,min(id,2) FROM t GROUP BY id ORDER BY id",
      "SELECT min(min(id,2)),max(max(id,2)),min(max(id),5) FROM t",
      "SELECT min(1,2) FROM t WHERE 0",
    ],
    ["CREATE TABLE t(id INTEGER PRIMARY KEY,s TEXT COLLATE NOCASE)"],
    ["INSERT INTO t VALUES(1,'Z'),(2,'A')"],
  );
});

test("LIKE validates pattern limits before NULLs and ESCAPE length before NULL text", async () => {
  const long = literal("a".repeat(50001));
  const statements = [
    `SELECT NULL LIKE ${long}`,
    `SELECT like(${long},NULL,'!')`,
    `SELECT like(${long},'a',NULL)`,
    "SELECT NULL LIKE '%' ESCAPE ''",
    "SELECT like(NULL,'a','xx')",
    `SELECT 'a' LIKE 'a' ESCAPE ${literal("\0")}`,
  ];
  const paths = await sqlikePaths(
    [],
    statements.map((sql, i) => ({ name: String(i), sql })),
  );
  for (const [i] of statements.entries()) {
    for (const path of paths)
      assert.throws(() => path.exec(String(i)), /pattern too complex|ESCAPE/);
  }
});

test("invalid escapes reject after earlier row updates without publishing changes", async () => {
  const paths = await sqlikePaths(
    ["CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT)"],
    [
      { name: "seed", sql: "INSERT INTO t VALUES(1,'a'),(2,'b')", write: true },
      {
        name: "bad",
        sql: "UPDATE t SET v=CASE WHEN id=1 THEN 'changed' ELSE v LIKE '%' ESCAPE 'xx' END",
        write: true,
      },
    ],
  );
  for (const path of paths) {
    path.exec("seed");
    const before = path.dump();
    assert.throws(() => path.exec("bad"), /ESCAPE/);
    assert.equal(path.dump(), before);
  }
});
