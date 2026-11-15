import { test } from "node:test";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { NodeDatabase } from "../adapters/node-database.ts";
import { MoonDatabase } from "../adapters/moon-database.ts";
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

test("JS matches native SQLite with original upstream results, typed expressions and atomic errors", () => {
  const moon = new MoonDatabase(),
    native = new NodeDatabase(":memory:");
  const fixture = readFileSync(
    "tests/fixtures/sqllogictest/select1.test",
    "utf8",
  );
  try {
    const oracle = {
      execute: (sql: string) => native.run(sql),
      query: (sql: string) => nativeValues(native, sql),
    };
    const candidate = {
      execute: (sql: string) => moon.run(sql),
      query: (sql: string) => moon.queryValues(sql),
    };
    const upstream = differentialLogicTest(
      parseLogicTest(fixture),
      oracle,
      candidate,
    );
    const expressions = expressionCorpus(),
      floats = floatTextCorpus();
    for (const sql of [...expressions, ...floats])
      assert.deepEqual(moon.queryValues(sql), nativeValues(native, sql), sql);
    const preparationErrors = verifyPreparationErrors(oracle, candidate);
    mkdirSync("measurements", { recursive: true });
    writeFileSync(
      "measurements/sqlite-conformance-js.json",
      JSON.stringify(
        {
          status: "passed",
          measuredAt: new Date().toISOString(),
          target: "js",
          oracle: {
            engine: "native node:sqlite",
            version: process.versions.sqlite,
            sourceId: String(
              native.all("SELECT sqlite_source_id() AS id")[0]!.id,
            ),
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
