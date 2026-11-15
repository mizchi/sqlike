import { scalarCorpus } from "../tests/compatibility/scalar-corpus.ts";
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { NodeDatabase } from "../adapters/node-database.ts";
import type { Cell } from "../src/contract.ts";
import { unpack } from "../src/protocol.ts";
import {
  parseLogicTest,
  verifyLogicResult,
} from "../tests/compatibility/sqllogictest.ts";
import {
  expressionCorpus,
  floatTextCorpus,
} from "../tests/compatibility/expression-corpus.ts";
import { nativeValues } from "../tests/compatibility/native-values.ts";
import {
  preparationSetup,
  preparationCases,
  preparationState,
} from "../tests/compatibility/preparation-cases.ts";

test.use({ serviceWorkers: "block" });
test("pure MoonBit in Chromium matches original SQLite sqllogictest and typed native results", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(120000);
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.route("**/conformance-probe", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>MoonBit conformance</title>",
    }),
  );
  await page.route("**/moon-conformance.js", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: readFileSync(
        "_build/js/release/build/mizchi/sqlike/sqlike.js",
        "utf8",
      ),
    }),
  );
  await page.goto("/conformance-probe");
  const fixture = readFileSync(
    "tests/fixtures/sqllogictest/select1.test",
    "utf8",
  );
  const records = parseLogicTest(fixture),
    expressions = expressionCorpus(),
    floats = floatTextCorpus();
  const actual = await page.evaluate(
    async ({ records, queries, setup, errors, state }) => {
      const path = "/moon-conformance.js";
      const runtime = (await import(
        /* @vite-ignore */ path
      )) as typeof import("../_build/js/release/build/mizchi/sqlike/sqlike.js");
      const db = runtime.database_open();
      function execute(sql: string): void {
        const result = JSON.parse(
          runtime.database_exec(db, sql, "[]", false),
        ) as { error?: string };
        if (result.error) throw new Error(result.error);
      }
      function query(sql: string): Cell[][] {
        const result = JSON.parse(
          runtime.database_query_values(db, sql, "[]"),
        ) as { error?: string; rows: Cell[][] };
        if (result.error) throw new Error(result.error);
        return result.rows;
      }
      let statements = 0;
      const upstream = records.flatMap((record) => {
        if (record.kind === "query") return [query(record.sql)];
        let error: unknown;
        try {
          execute(record.sql);
        } catch (e) {
          error = e;
        }
        if (record.error ? !error : error)
          throw error ?? new Error(`expected error: ${record.sql}`);
        statements++;
        return [];
      });
      const generated = queries.map(query);
      for (const sql of setup) execute(sql);
      const failed = errors.map(({ sql }) => {
        let error = "";
        try {
          execute(sql);
        } catch (e) {
          error = (e as Error).message;
        }
        return { error, state: query(state) };
      });
      return { statements, upstream, generated, failed };
    },
    {
      records,
      queries: [...expressions, ...floats, ...scalarCorpus()],
      setup: preparationSetup,
      errors: preparationCases,
      state: preparationState,
    },
  );
  const native = new NodeDatabase(":memory:");
  try {
    let i = 0;
    for (const record of records) {
      if (record.kind === "statement") {
        if (record.error) assert.throws(() => native.run(record.sql));
        else native.run(record.sql);
      } else {
        const expected = nativeValues(native, record.sql),
          rows = actual.upstream[i++]!.map((row) => row.map(unpack));
        verifyLogicResult(record, expected);
        verifyLogicResult(record, rows);
        assert.deepEqual(
          rows,
          expected,
          `upstream line ${record.line}: ${record.sql}`,
        );
      }
    }
    assert.equal(actual.statements, 31);
    assert.equal(i, 1000);
    for (const [j, sql] of [
      ...expressions,
      ...floats,
      ...scalarCorpus(),
    ].entries())
      assert.deepEqual(
        actual.generated[j]!.map((row) => row.map(unpack)),
        nativeValues(native, sql),
        sql,
      );
    for (const sql of preparationSetup) native.run(sql);
    const before = nativeValues(native, preparationState);
    for (const [j, { sql, error }] of preparationCases.entries()) {
      assert.throws(() => native.run(sql), new RegExp(error), sql);
      assert.match(actual.failed[j]!.error, new RegExp(error), sql);
      assert.deepEqual(
        nativeValues(native, preparationState),
        before,
        `oracle state after ${sql}`,
      );
      assert.deepEqual(
        actual.failed[j]!.state.map((row) => row.map(unpack)),
        before,
        `browser state after ${sql}`,
      );
    }
    expect(
      requests.filter((url) => /\.wasm(?:\?|$)|sqlite3|turso/i.test(url)),
    ).toEqual([]);
    const report = {
      status: "passed",
      measuredAt: new Date().toISOString(),
      target: "chromium-js",
      browserVersion: browser.version(),
      oracle: {
        engine: "native node:sqlite",
        version: process.versions.sqlite,
        sourceId: String(native.all("SELECT sqlite_source_id() AS id")[0]!.id),
      },
      upstream: {
        file: "select1.test",
        sha256: createHash("sha256").update(fixture).digest("hex"),
        statements: 31,
        queries: i,
      },
      expressionQueries: expressions.length,
      floatTextQueries: floats.length,
      scalarQueries: scalarCorpus().length,
      preparationErrors: preparationCases.length,
      excludedQueries: 0,
    };
    await mkdir("measurements", { recursive: true });
    await writeFile(
      "measurements/sqlite-conformance-chromium.json",
      JSON.stringify(report, null, 2) + "\n",
    );
    await testInfo.attach("sqlite-conformance", {
      body: JSON.stringify(report, null, 2),
      contentType: "application/json",
    });
  } finally {
    native.close();
  }
});
