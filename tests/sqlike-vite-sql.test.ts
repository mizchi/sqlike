import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  parseQueryFile,
  scanSqlikeCatalog,
} from "../scripts/sqlike-vite-sql.ts";

test("SQL file names and sqlc headers define names without splitting quoted SQL or trigger bodies", () => {
  assert.deepEqual(
    parseQueryFile("src/client/get.sql", "SELECT ';' AS value;"),
    [{ name: "get", sql: "SELECT ';' AS value;" }],
  );
  const text =
    "-- name: add :exec\nINSERT INTO t VALUES(?);\n-- name: list :many\nSELECT 'a;-- name: fake' FROM t;";
  assert.deepEqual(
    parseQueryFile("queries.sql", text).map((q) => q.name),
    ["add", "list"],
  );
  assert.deepEqual(
    parseQueryFile("get.sql", "SELECT 'first\n-- name: fake\nlast' AS v;"),
    [{ name: "get", sql: "SELECT 'first\n-- name: fake\nlast' AS v;" }],
  );
  const trigger =
    "-- name: trigger\nCREATE TRIGGER ai AFTER INSERT ON t BEGIN SELECT CASE WHEN 1 THEN ';' END; SELECT 2; END;";
  assert.equal(parseQueryFile("t.sql", trigger).length, 1);
});

test("SQL file parsing rejects ambiguous names, multiple unnamed statements and malformed SQL boundaries", () => {
  for (const sql of [
    "SELECT 1; SELECT 2;",
    "-- name:\nSELECT 1",
    "-- name: one\n-- name: two\nSELECT 1",
    "SELECT 'unterminated",
    "/* unterminated",
    "-- name: one\nSELECT 1; -- name: one\nSELECT 2;",
  ])
    assert.throws(() => parseQueryFile("queries.sql", sql), /queries\.sql/);
  assert.deepEqual(
    parseQueryFile("empty.sql", "-- comment only\n/* block */"),
    [],
  );
});

test("catalog scanning is deterministic, separates schema files and honors glob exclusions", async () => {
  const root = await mkdtemp(join(tmpdir(), "sqlike-vite-sql-"));
  try {
    await mkdir(join(root, "src/client/nested"), { recursive: true });
    await writeFile(
      join(root, "src/client/schema.sql"),
      "CREATE TABLE t(id INTEGER); CREATE INDEX ix ON t(id);",
    );
    await writeFile(join(root, "src/client/b.sql"), "SELECT id FROM t");
    await writeFile(
      join(root, "src/client/nested/a.sql"),
      "-- name: first :one\nSELECT 1;",
    );
    await writeFile(join(root, "src/client/skip.sql"), "invalid SQL");
    const options = {
      include: ["src/client/**/*.sql"],
      schemaFiles: ["src/client/schema.sql"],
      exclude: ["**/skip.sql"],
    };
    const result = await scanSqlikeCatalog(root, options);
    assert.deepEqual(result.source.schema, [
      "CREATE TABLE t(id INTEGER);",
      " CREATE INDEX ix ON t(id);",
    ]);
    assert.deepEqual(
      result.source.queries.map((q) => q.name),
      ["b", "first"],
    );
    assert.deepEqual(
      result.files.map((file) => file.slice(root.length + 1)),
      ["src/client/b.sql", "src/client/nested/a.sql", "src/client/schema.sql"],
    );
    assert.equal(
      (await scanSqlikeCatalog(root, options)).fingerprint,
      result.fingerprint,
    );
    await writeFile(join(root, "src/client/b.sql"), "SELECT id+1 FROM t");
    assert.notEqual(
      (await scanSqlikeCatalog(root, options)).fingerprint,
      result.fingerprint,
    );
    await writeFile(join(root, "src/client/nested/b.sql"), "SELECT 2");
    await assert.rejects(
      scanSqlikeCatalog(root, options),
      /duplicate query.*b/i,
    );
    await assert.rejects(
      scanSqlikeCatalog(root, { include: "missing/**/*.sql" }),
      /no SQL quer/i,
    );
    await assert.rejects(
      scanSqlikeCatalog(root, { include: "../*.sql" }),
      /relative.*root/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
