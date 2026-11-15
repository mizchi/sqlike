import { test } from "node:test";
import assert from "node:assert/strict";
import {
  auditFeature,
  assertOutputCompatibility,
  type AuditDriver,
  type AuditFeature,
} from "./compatibility/feature-audit.ts";
const feature: AuditFeature = {
  id: "probe",
  category: "test",
  title: "probe",
  source: "local",
  steps: [{ kind: "query", sql: "SELECT 1" }],
};
function driver(rows: any, error?: string, mutate = false): AuditDriver {
  let state = "before";
  return {
    execute() {
      if (mutate) state = "after";
      if (error) throw Error(error);
      return rows;
    },
    hasExport: () => false,
    dataState: () => state,
  };
}
const pass = () => auditFeature(feature, driver([[1n]]), driver([[1n]]));
test("output gate permits atomic rejection while retaining coverage information", () => {
  const r = auditFeature(
    { ...feature, id: "unsupported" },
    driver([[1n]]),
    driver([], "unsupported SQL"),
  );
  assert.equal(r.witness?.candidateRejected, true);
  assert.equal(r.witness?.rejectionAtomic, true);
  assert.doesNotThrow(() =>
    assertOutputCompatibility([pass(), r], ["probe", "unsupported"]),
  );
});
test("output gate rejects wrong values, successful invalid SQL and writes before rejection", () => {
  const badValue = auditFeature(feature, driver([[1n]]), driver([[1]]));
  const invalid = auditFeature(
    { ...feature, steps: [{ kind: "query", sql: "invalid", error: "syntax" }] },
    driver([], "syntax"),
    driver([]),
  );
  const mutation = auditFeature(
    feature,
    driver([[1n]]),
    driver([], "unsupported SQL", true),
  );
  for (const r of [badValue, invalid, mutation])
    assert.throws(
      () => assertOutputCompatibility([r], ["probe"]),
      /output compatibility/,
    );
});
test("output gate refuses missing rejection evidence, empty/incomplete/duplicate reports and invalid oracle probes", () => {
  const unsupported = auditFeature(feature, driver([[1n]]), {
    execute() {
      throw Error("unsupported SQL");
    },
    hasExport: () => false,
  });
  const oracleError = auditFeature(
    feature,
    driver([], "unexpected native fault"),
    driver([]),
  );
  for (const [r, ids] of [
    [[], []],
    [[pass()], ["probe", "missing"]],
    [[pass(), pass()], ["probe"]],
    [[unsupported], ["probe"]],
    [[oracleError], ["probe"]],
  ] as const)
    assert.throws(() => assertOutputCompatibility([...r], [...ids]));
});

test("a matching expected error still needs rejection-state evidence", () => {
  const f = {
    ...feature,
    steps: [{ kind: "query" as const, sql: "bad", error: "syntax" }],
  };
  const withoutState: AuditDriver = {
    execute() {
      throw Error("syntax");
    },
    hasExport: () => false,
  };
  const r = auditFeature(f, withoutState, withoutState);
  assert.throws(() => assertOutputCompatibility([r], ["probe"]));
});

test("an internal runtime exception cannot masquerade as unsupported functionality", () => {
  const broken = {
    ...driver([]),
    execute() {
      throw new TypeError("unsupported implementation crashed");
    },
  };
  const r = auditFeature(feature, driver([[1n]]), broken);
  assert.throws(
    () => assertOutputCompatibility([r], ["probe"]),
    /output compatibility/,
  );
});
