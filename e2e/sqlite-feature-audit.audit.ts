import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import assert from "node:assert/strict";
import {
  auditPlan,
  nativeDriver,
  serialize,
  categorySummary,
} from "../tests/compatibility/feature-runtime.ts";
import {
  auditFeature,
  summarizeAudit,
  outputDataState,
  type AuditDriver,
} from "../tests/compatibility/feature-audit.ts";
import { unpack } from "../src/protocol.ts";
import { aotBindings } from "../src/aot-values.ts";
import type { ResultCell } from "../src/contract.ts";

// Passing this test means the audit completed, not that candidate features match.
// The separate strict gate checks every result and exits nonzero for gaps.
test("records every catalog feature in real Chromium without SQLite fallback", async ({
  page,
  browser,
}, testInfo) => {
  const plan = auditPlan(),
    requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.route("**/feature-audit", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>SQLite feature audit</title>",
    }),
  );
  await page.route("**/moon-feature-audit.js", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: readFileSync(
        "_build/js/release/build/mizchi/sqlike/sqlike.js",
        "utf8",
      ),
    }),
  );
  await page.goto("/feature-audit");
  const executed = await page.evaluate(
    async (features) => {
      const path = "/moon-feature-audit.js";
      const runtime = (await import(
        /* @vite-ignore */ path
      )) as typeof import("../_build/js/release/build/mizchi/sqlike/sqlike.js");
      return features.map((feature) => {
        const db = runtime.database_open();
        const exports = Object.keys(runtime).filter(
          (name) =>
            typeof (runtime as unknown as Record<string, unknown>)[name] ===
            "function",
        );
        const events = (feature.steps ?? []).map((step) => {
          const bindings = step.bindings;
          const before = runtime.database_dump(db);
          try {
            const result = JSON.parse(
              step.kind === "query"
                ? runtime.database_query_values(db, step.sql, bindings)
                : runtime.database_exec(db, step.sql, bindings, false),
            ) as {
              error?: string;
              rows: ResultCell[][] | Record<string, ResultCell>[];
            };
            if (result.error)
              return {
                error: result.error,
                before,
                after: runtime.database_dump(db),
              };
            return {
              before,
              after: runtime.database_dump(db),
              rows:
                step.kind === "exec"
                  ? []
                  : step.kind === "returning"
                    ? (result.rows as Record<string, ResultCell>[]).map(
                        Object.values,
                      )
                    : (result.rows as ResultCell[][]),
            };
          } catch (error) {
            return {
              error: `${(error as Error).name}: ${(error as Error).message}`,
              before,
              after: runtime.database_dump(db),
            };
          }
        });
        return { id: feature.id, exports, events };
      });
    },
    plan.features.map((feature) => ({
      ...feature,
      steps: feature.steps?.map((step) => ({
        ...step,
        bindings: aotBindings(step.params ?? []),
      })),
    })),
  );
  const results = plan.features.map((feature, index) => {
    const capture = executed[index]!;
    assert.equal(capture.id, feature.id);
    let cursor = 0;
    const candidate: AuditDriver = {
      hasExport: (name) => capture.exports.includes(name),
      dataState: () => {
        const image =
          cursor === 0
            ? capture.events[0]?.before
            : capture.events[cursor - 1]?.after;
        if (!image) throw Error("Missing rejection state evidence");
        return outputDataState(image);
      },
      execute: () => {
        const event = capture.events[cursor++];
        if (!event) throw Error("Missing browser audit event");
        if (event.error) throw Error(event.error);
        return event.rows!.map((row) => row.map(unpack));
      },
    };
    const native = nativeDriver();
    try {
      return auditFeature(feature, native, candidate, plan.oracle.capabilities);
    } finally {
      native.close?.();
    }
  });
  expect(results.filter((r) => r.status === "oracle-error")).toEqual([]);
  expect(
    requests.filter((url) => /\.wasm(?:\?|$)|sqlite3|turso/i.test(url)),
  ).toEqual([]);
  const report = {
    format: 1,
    measuredAt: new Date().toISOString(),
    scope:
      "Audit execution completed; use each feature status and the separate strict gate for compatibility",
    catalogSHA256: plan.catalogSHA256,
    planSHA256: plan.planSHA256,
    sourceSHA256: plan.sourceSHA256,
    harnessSHA256: plan.harnessSHA256,
    oracleSHA256: plan.oracleSHA256,
    artifacts: plan.artifacts,
    target: "chromium-js",
    browserVersion: browser.version(),
    oracle: plan.oracle,
    summary: summarizeAudit(results),
    categories: categorySummary(plan.features, results),
    results,
  };
  mkdirSync("measurements", { recursive: true });
  writeFileSync(
    "measurements/sqlite-feature-audit-chromium.json",
    serialize(report),
  );
  await testInfo.attach("feature-audit", {
    body: serialize(report),
    contentType: "application/json",
  });
  console.log("Chromium audit:", JSON.stringify(report.summary));
});
