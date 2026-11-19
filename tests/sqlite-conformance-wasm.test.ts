import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { NodeDatabase } from "../adapters/node-database.ts";
import {
  MoonDatabase,
  type MoonSqlRuntime,
} from "../adapters/moon-database.ts";
import {
  parseLogicTest,
  differentialLogicTest,
} from "./compatibility/sqllogictest.ts";
import {
  expressionCorpus,
  floatTextCorpus,
} from "./compatibility/expression-corpus.ts";
import { nativeValues } from "./compatibility/native-values.ts";
import { verifyPreparationErrors } from "./compatibility/preparation.ts";

test("Wasm GC matches native SQLite and all upstream select1 expectations, generated expressions and float conversions", async () => {
  const bytes = readFileSync("_build/wasm-gc/release/build/mizchi/sqlike/full/full.wasm");
  const { instance, module } = await WebAssembly.instantiate(
    bytes,
    {},
    { builtins: ["js-string"], importedStringConstants: "_" },
  );
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  const exports = instance.exports as unknown as MoonSqlRuntime;
  const runtime: MoonSqlRuntime = {
    ...exports,
    database_is_readonly: (sql) => Boolean(exports.database_is_readonly(sql)),
  };
  const moon = new MoonDatabase(undefined, undefined, runtime),
    native = new NodeDatabase(":memory:");
  const fixture = readFileSync(
    "tests/fixtures/sqllogictest/select1.test",
    "utf8",
  );
  try {
    const upstream = differentialLogicTest(
      parseLogicTest(fixture),
      {
        execute: (sql) => native.run(sql),
        query: (sql) => nativeValues(native, sql),
      },
      {
        execute: (sql) => moon.run(sql),
        query: (sql) => moon.queryValues(sql),
      },
    );
    const expressions = expressionCorpus(),
      floats = floatTextCorpus();
    for (const sql of [...expressions, ...floats])
      assert.deepEqual(moon.queryValues(sql), nativeValues(native, sql), sql);
    const preparationErrors = verifyPreparationErrors(
      {
        execute: (sql) => native.run(sql),
        query: (sql) => nativeValues(native, sql),
      },
      {
        execute: (sql) => moon.run(sql),
        query: (sql) => moon.queryValues(sql),
      },
    );
    const source = String(native.all("SELECT sqlite_source_id() AS id")[0]!.id);
    mkdirSync("measurements", { recursive: true });
    writeFileSync(
      "measurements/sqlite-conformance-wasm-gc.json",
      JSON.stringify(
        {
          status: "passed",
          measuredAt: new Date().toISOString(),
          target: "wasm-gc",
          oracle: {
            engine: "native node:sqlite",
            version: process.versions.sqlite,
            sourceId: source,
          },
          upstream: {
            file: "select1.test",
            sha256: createHash("sha256").update(fixture).digest("hex"),
            ...upstream,
          },
          expressionQueries: expressions.length,
          floatTextQueries: floats.length,
          preparationErrors,
          excludedQueries: 0,
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    native.close();
  }
});
