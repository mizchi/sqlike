import { test } from "node:test";
import { compareQueries, sqlikePaths } from "./compatibility/sqlike-paths.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildDefinedCatalog } from "../scripts/defined-compiler.ts";
import { createDefinedDatabase } from "../adapters/defined-database-core.ts";
import { definedWasm } from "../adapters/defined-wasm.ts";
import * as defined from "../_build/js/release/build/mizchi/sqlike/defined/defined.js";
import { NodeDatabase } from "../adapters/node-database.ts";

const literal = (s: string) => `'${s.replaceAll("'", "''")}'`;
const documents = ['{"a":1,"b":null,"c":[1,"x",true]}', '[1,2,3]', '"hello"', 'null', String.raw`{"\u0061":"\u0062","x":"\/","nested":["\ud83d\ude00"]}`];

test("JSON serialization retains escaped key/value spellings through lookup, edits and patch", async () => {
  await compareQueries(documents.flatMap((doc) => [
    `SELECT json(${literal(doc)})`,
    `SELECT json_set(${literal(doc)},'$.added',1)`,
    `SELECT json_patch(${literal(doc)},${literal(String.raw`{"\u0063":"\u0064"}`)})`,
    `SELECT json_array(json(${literal(doc)}))`,
  ]));
});

test("JSON arrows preserve JSON subtype and native SQL scalar types on four paths", async () => {
  const operands = ["'$'", "'$.a'", "'a'", "'a.b'", "0", "-1", "9223372036854775807", "'0'", "1.0", "NULL"];
  await compareQueries(documents.flatMap((doc) => operands.flatMap((path) => [
    `SELECT ${literal(doc)} -> ${path},typeof(${literal(doc)} -> ${path})`,
    `SELECT ${literal(doc)} ->> ${path},typeof(${literal(doc)} ->> ${path})`,
  ])));
  await compareQueries([
    `SELECT json_array(${literal('["x"]')} -> 0),json_array(${literal('["x"]')} ->> 0)`,
    `SELECT ${literal('{"a":[1,2]}')} -> 'a' -> -1`,
    `SELECT ${literal('{"a.b":1}')} -> 'a.b'`,
    `SELECT json(${literal(' { "x" : [ 1, 2 ] } ')} -> 'x')`,
    ...["a.b", "a[b]", "a\\b", "0"].map((key) => `SELECT ${literal(JSON.stringify({[key]:7}))} -> ${literal(key)}`),
    "SELECT NULL -> '$invalid',NULL ->> '$invalid'",
  ]);
});

test("JSON arrow aliases reject the same malformed paths as native SQLite", async () => {
  const statements = ["", "$invalid", 'a"b'].map(
    (path) => `SELECT '{"a":1}' -> ${literal(path)}`,
  );
  statements.push("SELECT 'malformed' -> NULL", "SELECT 'malformed' ->> NULL");
  const paths = await sqlikePaths(
    [], statements.map((sql, i) => ({ name: String(i), sql })),
  );
  const native = new NodeDatabase(":memory:");
  try {
    for (const [i, sql] of statements.entries()) {
      assert.throws(() => native.all(sql), /JSON/);
      for (const path of paths) assert.throws(() => path.exec(String(i)), /JSON/);
    }
  } finally {
    native.close();
  }
});

test("a malformed JSON path after an earlier row update rolls back the entire statement", async () => {
  const schema = ["CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT)"];
  const paths = await sqlikePaths(schema, [
    { name: "seed", sql: "INSERT INTO t VALUES(1,'one'),(2,'two')", write: true },
    {
      name: "bad",
      sql: `UPDATE t SET v=CASE WHEN id=1 THEN 'changed' ELSE '{"a":1}' ->> '$invalid' END`,
      write: true,
    },
    { name: "read", sql: "SELECT id,v FROM t ORDER BY id" },
  ]);
  for (const path of paths) {
    path.exec("seed");
    const before = path.dump();
    assert.throws(() => path.exec("bad"), /JSON path/);
    assert.equal(path.dump(), before);
    assert.deepEqual(path.exec("read"), [[1n, "one"], [2n, "two"]]);
  }
});

test("binary catalogs carry the sqlJson requirement and execute arrows on JS/Wasm", async () => {
  const catalog = buildDefinedCatalog({
    schema: [], queries: [{ name: "q", sql: "SELECT ? -> '$.n',? ->> '$.n'" }],
  });
  assert.equal(new DataView(catalog.statements.buffer).getUint32(8, true) & 16, 16);
  const wasm = (await WebAssembly.instantiate(
    readFileSync("_build/wasm-gc/release/build/mizchi/sqlike/defined/defined.wasm"),
    {}, { builtins: ["js-string"], importedStringConstants: "_" },
  )).instance.exports;
  for (const runtime of [defined, definedWasm(wasm)]) {
    const db = await createDefinedDatabase(runtime).memory(catalog);
    assert.deepEqual(await db.prepare("q").all(['{"n":1}', '{"n":1}']), [["1", 1n]]);
    await db.close();
  }
});
