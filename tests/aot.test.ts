import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as compiler from "../_build/js/release/build/mizchi/sqlike/compiler/compiler.js";
import * as runtime from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "./compatibility/native-values.ts";
import { pack, unpack } from "../src/protocol.ts";
import type { Cell, Value } from "../src/contract.ts";

export const specification = {
  schema: [
    "CREATE TABLE notes(id INTEGER PRIMARY KEY,title TEXT NOT NULL,n INTEGER)",
    "CREATE VIEW active AS SELECT id,title FROM notes WHERE n>0",
  ],
  queries: [
    {
      name: "add",
      sql: "INSERT INTO notes(id,title,n) VALUES(?,?,?) RETURNING id,title,n",
    },
    { name: "read", sql: "SELECT id,title,n FROM notes ORDER BY id" },
    { name: "get", sql: "SELECT id,title,n FROM notes WHERE id=?" },
    { name: "active", sql: "SELECT * FROM active ORDER BY id" },
    { name: "edit", sql: "UPDATE notes SET title=? WHERE id=?" },
    { name: "erase", sql: "DELETE FROM notes WHERE id=?" },
    {
      name: "constants",
      sql: "SELECT 1 AS same,2 AS same,9223372036854775807 AS large,-0.0 AS zero",
    },
  ],
};
function build() {
  const result = JSON.parse(
    compiler.compile_program(JSON.stringify(specification)),
  );
  if (result.error) throw Error(result.error);
  return JSON.stringify(result);
}
function execute(
  db: ReturnType<typeof runtime.aot_open>,
  name: string,
  params: Value[] = [],
) {
  const r = JSON.parse(
    runtime.aot_execute(db, name, JSON.stringify(params.map(pack))),
  ) as { error?: string; rows: Cell[][]; names: string[] };
  if (r.error) throw Error(r.error);
  return { rows: r.rows.map((row) => row.map(unpack)), names: r.names };
}
test("precompiled queries match native SQLite values, views, binding checks and atomic failed writes", () => {
  const program = build(),
    db = runtime.aot_open(program, ""),
    native = new NodeDatabase(":memory:");
  assert.equal(JSON.parse(runtime.aot_info(db)).error, undefined);
  try {
    for (const sql of specification.schema) native.run(sql);
    for (const params of [
      [1n, "first", 1n],
      [2n, "second", null],
    ] as Value[][]) {
      assert.deepEqual(
        execute(db, "add", params).rows,
        nativeValues(native, specification.queries[0]!.sql, params),
      );
    }
    assert.deepEqual(
      execute(db, "read").rows,
      nativeValues(native, specification.queries[1]!.sql),
    );
    assert.deepEqual(
      execute(db, "active").rows,
      nativeValues(native, specification.queries[3]!.sql),
    );
    assert.throws(() => execute(db, "add", [3n, null, 2n]), /NOT NULL/);
    assert.throws(() => execute(db, "get"), /binding count/);
    assert.throws(() => execute(db, "SELECT * FROM notes"), /unknown|catalog/i);
    assert.deepEqual(
      execute(db, "read").rows,
      nativeValues(native, specification.queries[1]!.sql),
    );
    const constants = execute(db, "constants");
    assert.deepEqual(constants.rows, [[1n, 2n, 9223372036854775807n, -0]]);
    assert.equal(constants.names[0], constants.names[1]);
    const image = runtime.aot_dump(db),
      restored = runtime.aot_open(program, image);
    assert.deepEqual(execute(restored, "read").rows, execute(db, "read").rows);
    const corrupt = JSON.parse(image);
    corrupt.state.tables[0].columns[0].name = "changed";
    assert.notEqual(
      JSON.parse(runtime.aot_restore(restored, JSON.stringify(corrupt))).error,
      undefined,
    );
    assert.deepEqual(execute(restored, "read").rows, execute(db, "read").rows);
  } finally {
    native.close();
  }
});
test("runtime module has no SQL lexer/parser, SQL text execution or foreign database imports", () => {
  const source = readFileSync(
    "_build/js/release/build/mizchi/litestream-example/runtime/runtime.js",
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /function .*\b(lex|parse__statement|sqlite__import)\b/,
  );
  assert.doesNotMatch(
    source,
    /SQL syntax: expected|unterminated SQL quote|unterminated SQL comment/,
  );
  // The negative control ensures the same gate rejects the development engine.
  assert.match(
    readFileSync("_build/js/release/build/mizchi/sqlike/sqlike.js", "utf8"),
    /SQL syntax: expected|unterminated SQL quote|unterminated SQL comment/,
  );
  assert.equal("database_exec" in runtime, false);
  assert.equal("compile_program" in runtime, false);
  assert.doesNotMatch(source, /^import\s/m);
  assert.ok(createHash("sha256").update(source).digest("hex"));
});
