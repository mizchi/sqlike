import { test } from "node:test";
import assert from "node:assert/strict";
import {
  differentialCase,
  type CompatibilityDriver,
} from "./compatibility/contract.ts";
import { compatibilityCorpus } from "./compatibility/corpus.ts";
import { sqliteOracle } from "./compatibility/oracle.ts";
import {
  defaultBrowserEngine,
  parseBrowserEngine,
} from "../src/browser-engine.ts";

test("an unimplemented IndexedDB SQL engine cannot silently fall back to the SQLite oracle", () => {
  assert.equal(parseBrowserEngine(defaultBrowserEngine), defaultBrowserEngine);
  assert.throws(() => parseBrowserEngine("indexeddb"), /unsupported/);
});

test("compatibility gate detects a wrong result rather than accepting both drivers as interchangeable", async () => {
  const oracle = sqliteOracle();
  const wrong: CompatibilityDriver = {
    execute: oracle.execute,
    async query() {
      return { ok: true, rows: [{ n: { t: "integer", v: "2" } }] };
    },
  };
  try {
    await assert.rejects(
      differentialCase(
        {
          id: "gate-self-test",
          features: [],
          steps: [
            { kind: "query", statement: { sql: "SELECT 1 AS n", params: [] } },
          ],
        },
        oracle,
        wrong,
      ),
      /differential mismatch/,
    );
  } finally {
    oracle.close();
  }
});
test("compatibility corpus has explicit valid native SQLite expectations", async () => {
  let steps = 0;
  for (const test of compatibilityCorpus()) {
    const oracle = sqliteOracle();
    const second = sqliteOracle();
    try {
      steps += await differentialCase(test, oracle, second);
    } finally {
      oracle.close();
      second.close();
    }
  }
  assert.ok(steps >= 800);
});
