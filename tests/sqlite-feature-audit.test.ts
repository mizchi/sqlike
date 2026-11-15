import { test } from "node:test";
import assert from "node:assert/strict";
import {
  auditFeature,
  summarizeAudit,
  assertFullCompatibility,
  type AuditDriver,
  type AuditFeature,
} from "./compatibility/feature-audit.ts";

const feature: AuditFeature = {
  id: "sql/cast",
  category: "language",
  title: "CAST",
  source: "https://www.sqlite.org/lang_expr.html",
  steps: [{ sql: "SELECT CAST(1 AS TEXT)", kind: "query" }],
};
const driver = (result: unknown, error?: string): AuditDriver => ({
  execute: () => {
    if (error) throw Error(error);
    return result as never;
  },
  hasExport: () => false,
});
test("audit distinguishes exact typed matches, mismatches and candidate errors", () => {
  assert.equal(
    auditFeature(feature, driver([["1"]]), driver([["1"]])).status,
    "matched-probe",
  );
  assert.equal(
    auditFeature(feature, driver([[1n]]), driver([[1]])).status,
    "value-mismatch",
  );
  assert.equal(
    auditFeature(feature, driver([["1"]]), driver(null, "unsupported CAST"))
      .status,
    "candidate-error",
  );
});
test("two failures, unavailable oracle and untested requirements never count as compatibility", () => {
  assert.equal(
    auditFeature(
      feature,
      driver(null, "no such function"),
      driver(null, "no such function"),
    ).status,
    "oracle-error",
  );
  const optional = {
    ...feature,
    oracleRequirement: { kind: "function" as const, name: "new_function" },
  };
  assert.equal(
    auditFeature(optional, driver(null), driver(null), {
      functions: [],
      pragmas: [],
      modules: [],
    }).status,
    "oracle-unavailable",
  );
  assert.equal(
    auditFeature(
      { ...feature, steps: undefined, reason: "crash injection has not run" },
      driver(null),
      driver(null),
    ).status,
    "not-tested",
  );
  assert.equal(
    auditFeature(
      { ...feature, steps: undefined, exportName: "sqlite3_open" },
      driver(null),
      driver(null),
    ).status,
    "missing-api",
  );
});
test("strict gate fails for any unverified feature and prevents stale/incomplete reports", () => {
  const pass = auditFeature(feature, driver([["1"]]), driver([["1"]]));
  const missing = auditFeature(
    { ...feature, id: "sql/crash", steps: undefined, reason: "not run" },
    driver(null),
    driver(null),
  );
  assert.equal(summarizeAudit([pass, missing]).allCatalogProbesMatched, false);
  assert.equal(summarizeAudit([pass, missing]).verdict, "incomplete-evidence");
  assert.equal(
    summarizeAudit([
      auditFeature(feature, driver([["1"]]), driver(null, "unsupported")),
    ]).verdict,
    "incompatible",
  );
  assert.throws(
    () => assertFullCompatibility([pass, missing], ["sql/cast", "sql/crash"]),
    /not verified/,
  );
  assert.throws(
    () => assertFullCompatibility([pass], ["sql/cast", "sql/crash"]),
    /missing/,
  );
  assert.doesNotThrow(() => assertFullCompatibility([pass], ["sql/cast"]));
});

test("catalog contains every indexed entry and all executable oracle probes are valid", async () => {
  const { auditPlan, nativeDriver } = await import(
    "./compatibility/feature-runtime.ts"
  );
  const { readFileSync } = await import("node:fs");
  const catalog = JSON.parse(
    readFileSync("tests/fixtures/sqlite-catalog/catalog.json", "utf8"),
  );
  const plan = auditPlan(),
    ids = new Set(plan.features.map((f) => f.id));
  for (const entry of catalog.entries)
    assert.ok(ids.has(`${entry.category}/${entry.name}`));
  assert.equal(catalog.counts.language, 42);
  assert.equal(catalog.counts.pragma, 74);
  assert.equal(catalog.counts["api-function"], 306);
  const errors = [];
  for (const feature of plan.features) {
    const a = nativeDriver(),
      b = nativeDriver();
    try {
      const result = auditFeature(feature, a, b, plan.oracle.capabilities);
      if (
        result.status === "oracle-error" ||
        result.status === "candidate-error" ||
        result.status === "value-mismatch"
      )
        errors.push(result);
    } finally {
      a.close?.();
      b.close?.();
    }
  }
  assert.deepEqual(errors, []);
});
import { serialize } from "./compatibility/feature-runtime.ts";
test("audit report input serialization preserves signed zero, non-finite REAL and int64 distinctions", () => {
  assert.deepEqual(JSON.parse(serialize([0, -0, Infinity, 1n, "1"])), [
    0,
    { $real: "-0" },
    { $real: "Infinity" },
    { $integer: "1" },
    "1",
  ]);
  assert.notEqual(serialize([0]), serialize([-0]));
});
