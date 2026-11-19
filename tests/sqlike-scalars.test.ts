import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { NodeDatabase } from "../adapters/node-database.ts";
import {
  MoonDatabase,
  type MoonSqlRuntime,
} from "../adapters/moon-database.ts";
import * as compiler from "../_build/js/release/build/mizchi/sqlike/compiler/compiler.js";
import * as runtime from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import { scalarCorpus } from "./compatibility/scalar-corpus.ts";
import { nativeValues } from "./compatibility/native-values.ts";
import { aotValue } from "../src/aot-values.ts";
import type { Cell } from "../src/contract.ts";

test("string and conditional scalars match SQLite in JS, Wasm GC and parser-free AOT without exclusions", async () => {
  const { instance } = await WebAssembly.instantiate(
    readFileSync("_build/wasm-gc/release/build/mizchi/sqlike/full/full.wasm"),
    {},
    { builtins: ["js-string"], importedStringConstants: "_" },
  );
  const wasm = instance.exports as unknown as MoonSqlRuntime,
    js = new MoonDatabase(),
    portable = new MoonDatabase(undefined, undefined, wasm),
    native = new NodeDatabase(":memory:");
  const queries = scalarCorpus(),
    failures: string[] = [];
  let count = 0;
  try {
    for (let offset = 0; offset < queries.length; offset += 80) {
      const batch = queries.slice(offset, offset + 80),
        artifact = compiler.compile_program(
          JSON.stringify({
            schema: [],
            queries: batch.map((sql, i) => ({ name: String(i), sql })),
          }),
        );
      const compiled = JSON.parse(artifact),
        db = compiled.error ? undefined : runtime.aot_open(artifact, "");
      for (const [i, sql] of batch.entries()) {
        const expected = nativeValues(native, sql);
        for (const [name, run] of [
          ["js", () => js.queryValues(sql)],
          ["wasm-gc", () => portable.queryValues(sql)],
          [
            "aot",
            () => {
              if (compiled.error) throw Error(compiled.error);
              const result = JSON.parse(
                runtime.aot_execute(db!, String(i), "[]"),
              ) as { error?: string; rows: Cell[][] };
              if (result.error) throw Error(result.error);
              return result.rows.map((row) => row.map(aotValue));
            },
          ],
        ] as const) {
          try {
            const actual = run();
            if (!isDeepStrictEqual(actual, expected)) {
              if (failures.length < 30)
                failures.push(
                  `${name}: ${sql}\nexpected ${JSON.stringify(expected, (_, v) => (typeof v === "bigint" ? String(v) + "n" : v))} received ${JSON.stringify(actual, (_, v) => (typeof v === "bigint" ? String(v) + "n" : v))}`,
                );
              count++;
            }
          } catch (error) {
            if (failures.length < 30)
              failures.push(`${name}: ${sql}: ${(error as Error).message}`);
            count++;
          }
        }
      }
    }
    assert.equal(
      count,
      0,
      `${count} differential failures (${queries.length} queries x 3 paths):\n${failures.join("\n")}`,
    );
  } finally {
    native.close();
  }
});

test("scalar collation, column storage classes and UTF-16 byte counts match native SQLite", () => {
  for (const encoding of ["UTF-8", "UTF-16le", "UTF-16be"]) {
    const native = new NodeDatabase(":memory:"),
      moon = new MoonDatabase();
    try {
      for (const db of [native, moon]) {
        db.run(`PRAGMA encoding='${encoding}'`);
        db.run(
          "CREATE TABLE t(i INTEGER,s TEXT COLLATE NOCASE,b TEXT COLLATE BINARY)",
        );
        db.run("INSERT INTO t VALUES(1,'a','A')");
      }
      for (const sql of [
        "SELECT nullif(s,b),nullif(b,s),nullif(b,s COLLATE NOCASE),nullif(i,'1') FROM t",
        "SELECT octet_length('😀a界'),octet_length(42),octet_length(x'0001'),iif(i,s,b) FROM t",
      ]) {
        if (encoding !== "UTF-8" && sql.includes("x'0001'")) {
          assert.throws(() => moon.queryValues(sql), /unsupported SQL/);
          continue;
        }
        assert.deepEqual(
          moon.queryValues(sql),
          nativeValues(native, sql),
          `${encoding}: ${sql}`,
        );
      }
    } finally {
      native.close();
    }
  }
});
test("new functions validate all branches before writes and preserve SQLite lazy evaluation", () => {
  const native = new NodeDatabase(":memory:"),
    moon = new MoonDatabase();
  try {
    for (const db of [native, moon]) {
      db.run("CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)");
      db.run("INSERT INTO t VALUES(1,1),(2,2)");
    }
    for (const sql of [
      "SELECT substr('abc')",
      "SELECT concat()",
      "SELECT nullif(1)",
      "SELECT iif(1)",
      "SELECT iif(1,'ok',unknown(1)) FROM t WHERE 0",
      "UPDATE t SET n=iif(id=1,9,abs(-9223372036854775808))",
    ]) {
      assert.throws(
        () => native.raw.prepare(sql).all(),
        /arguments|function|overflow/,
      );
      assert.throws(() => moon.all(sql), /arity|function|overflow/);
      assert.deepEqual(
        moon.queryValues("SELECT * FROM t ORDER BY id"),
        nativeValues(native, "SELECT * FROM t ORDER BY id"),
        sql,
      );
    }
  } finally {
    native.close();
  }
});
