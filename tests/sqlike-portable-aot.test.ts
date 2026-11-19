import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as js from "../_build/js/release/build/mizchi/sqlike/aot/aot.js";
import { openPortableCompiled, aotWasm } from "../src/sqlike-portable-aot.ts";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "./compatibility/native-values.ts";
test("portable AOT JS/Wasm share prepared-handle, typed-value and rollback contracts without a SQL parser", async () => {
  const schema = [
    "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER CHECK(n>0),b BLOB)",
  ];
  const queries = [
    { name: "add", sql: "INSERT INTO t VALUES(?,?,?) RETURNING *" },
    { name: "q", sql: "SELECT n*2,b FROM t WHERE id=?" },
    { name: "set", sql: "UPDATE t SET n=? WHERE id=?" },
    { name: "constant", sql: "SELECT ?,?,?" },
    { name: "overflow", sql: "SELECT abs(?)" },
  ];
  const program = buildCatalog({ schema, queries }).artifact;
  const wasm = (
    await WebAssembly.instantiate(
      readFileSync("_build/wasm-gc/release/build/mizchi/sqlike/aot/aot.wasm"),
      {},
      { builtins: ["js-string"], importedStringConstants: "_" },
    )
  ).instance.exports;
  for (const runtime of [js, aotWasm(wasm)]) {
    const db = openPortableCompiled(runtime, program, "", { clock: () => 0 }),
      native = new NodeDatabase(":memory:");
    try {
      schema.forEach((sql) => native.raw.exec(sql));
      const blob = Uint8Array.of(0, 255);
      assert.deepEqual(
        db.execute("add", [1n, 3n, blob]).rows,
        nativeValues(native, queries[0]!.sql, [1n, 3n, blob]),
      );
      blob[0] = 99;
      const q = db.prepare("q");
      assert.deepEqual(q.get([1n]), [6n, Uint8Array.of(0, 255)]);
      assert.throws(() => q.values([]), /binding count/);
      assert.deepEqual(q.get([1n]), [6n, Uint8Array.of(0, 255)]);
      const image = db.dump();
      db.execute("set", [8n, 1n]);
      db.restore(image);
      assert.deepEqual(q.get([1n]), [6n, Uint8Array.of(0, 255)]);
      assert.throws(
        () =>
          db.transaction(() => {
            db.execute("set", [9n, 1n]);
            throw Error("rollback");
          }),
        /rollback/,
      );
      assert.deepEqual(q.get([1n]), [6n, Uint8Array.of(0, 255)]);
      assert.deepEqual(
        db.values("constant", [9223372036854775807n, -0, "a\0"]),
        [[9223372036854775807n, -0, "a\0"]],
      );
      assert.throws(
        () => db.values("overflow", [-9223372036854775808n]),
        /overflow/,
      );
      assert.deepEqual(db.values("overflow", [1n]), [[1n]]);
      assert.throws(() => db.execute("set", [-1n, 1n]), /constraint/);
      assert.deepEqual(q.get([1n]), [6n, Uint8Array.of(0, 255)]);
      q.finalize();
      assert.throws(() => q.get([1n]), /finalized/);
    } finally {
      db.close();
      native.close();
    }
  }
  const code = readFileSync(
    "_build/js/release/build/mizchi/sqlike/aot/aot.js",
    "utf8",
  );
  assert.doesNotMatch(
    code,
    /function [^\n]*(parse__statement|database__prepare|prepare__sql__metadata)\(/,
  );
});
