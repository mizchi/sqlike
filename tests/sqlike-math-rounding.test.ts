import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as binary from "../_build/js/release/build/mizchi/sqlike/defined/defined.js";
import { buildDefinedCatalog } from "../scripts/defined-compiler.ts";
import { createDefinedDatabase } from "../adapters/defined-database-core.ts";
import { definedWasm } from "../adapters/defined-wasm.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "./compatibility/native-values.ts";
import { compareQueries, sqlikePaths } from "./compatibility/sqlike-paths.ts";
import type { Value } from "../src/contract.ts";
import { MoonDatabase, type MoonSqlRuntime } from "../adapters/moon-database.ts";
import { buildCatalog } from "../scripts/aot-compiler.ts";

const functions = ["ceil", "ceiling", "floor", "trunc"];
const sql = `SELECT ${functions.flatMap((f) => [`${f}(?1) AS ${f}`, `typeof(${f}(?1)) AS ${f}_type`]).join(",")}`;

test("rounding functions preserve native storage classes and edge values on SQL/AOT JS/Wasm", async () => {
  await compareQueries([
    ...["NULL", "1", "-1", "1.25", "-1.25", "-0.0", "-1e-999", "1e999", "-1e999",
      "9223372036854775807", "-9223372036854775808", "'1'", "'1.0'", "'1e2'",
      "'1.5'", "'  -2.5  '", "'1x'", "''", "'0x10'", "x'31'", "x'ff'",
      "'1'||char(0)||'junk'", "'1.5'||char(0)||'junk'", "char(0)||'1'"].map((v) =>
      `SELECT ${functions.flatMap((f) => [`${f}(${v})`, `typeof(${f}(${v}))`]).join(",")}`),
  ]);
});

test("rounding reuses live bindings across six SQL/AOT/binary paths", async () => {
  const paths = await sqlikePaths([], [{ name: "q", sql }]);
  const packed = buildDefinedCatalog({ schema: [], queries: [{ name: "q", sql }] });
  const wasm = (await WebAssembly.instantiate(readFileSync(
    "_build/wasm-gc/release/build/mizchi/sqlike/defined/defined.wasm",
  ), {}, { builtins: ["js-string"], importedStringConstants: "_" })).instance.exports;
  const dbs = await Promise.all([binary, definedWasm(wasm)].map((runtime) =>
    createDefinedDatabase(runtime).memory(packed)));
  const native = new NodeDatabase(":memory:");
  try {
    const values: Value[] = [0n, 9007199254740993n, 9223372036854775807n, -9223372036854775808n,
      1.5, -1.5, -0, -Number.MIN_VALUE, Number.MAX_VALUE, "1", "1.0", " 1.5 ",
      "1\0tail", "1.5\0tail", "1x", "NaN", "Infinity", "0x10", null,
      Uint8Array.of(49), Uint8Array.of(255), "2"];
    for (const value of values) {
      const expected = nativeValues(native, sql, [value]);
      for (const [i, p] of paths.entries()) assert.deepEqual(p.exec("q", [value]), expected, String(i));
      for (const db of dbs) assert.deepEqual((await db.execute("q", [value])).rows, expected);
    }
  } finally {
    native.close();
    await Promise.all(dbs.map((db) => db.close()));
  }
});

test("rounding arity is validated before empty reads or writes publish changes", async () => {
  const wasm = (await WebAssembly.instantiate(readFileSync(
    "_build/wasm-gc/release/build/mizchi/sqlike/sqlike.wasm",
  ), {}, { builtins: ["js-string"], importedStringConstants: "_" })).instance.exports;
  const schema = ["CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)"];
  const native = new NodeDatabase(":memory:");
  const dbs = [new MoonDatabase(), new MoonDatabase(undefined, undefined, wasm as unknown as MoonSqlRuntime)];
  try {
    for (const db of [native, ...dbs]) {
      db.run(schema[0]!);
      db.run("INSERT INTO t VALUES(1,7)");
    }
    for (const f of functions) for (const args of ["", "1,2"]) {
      for (const sql of [`SELECT ${f}(${args}) FROM t WHERE 0`, `UPDATE t SET n=${f}(${args})`]) {
        assert.throws(() => native.run(sql));
        for (const db of dbs) assert.throws(() => db.run(sql));
        assert.throws(() => buildCatalog({ schema, queries: [{ name: "bad", sql }] }));
      }
    }
    for (const db of dbs) assert.deepEqual(db.queryValues("SELECT id,n FROM t"), [[1n, 7n]]);
  } finally {
    native.close();
    dbs.forEach((db) => db.close());
  }
});
