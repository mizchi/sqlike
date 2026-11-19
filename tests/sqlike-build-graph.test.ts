import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildGraph,
  validateBuildGraph,
  dependencyClosure,
  assertBuildSelection,
  baselineRoots,
} from "../src/sqlike-build-graph.ts";
import { createBuildPlan } from "../src/sqlike-build-plan.ts";
import { baselineSqlike } from "../src/sqlike-features.ts";
test("generated MoonBit baseline and flat SQL baseline select the same parser and implementation closure", () => {
  assert.deepEqual(
    dependencyClosure(baselineRoots()),
    createBuildPlan(baselineSqlike()).selected,
  );
});
test("build closure is least, deterministic, idempotent and rejects broken contracts", () => {
  const roots = baselineRoots(),
    closed = dependencyClosure(roots);
  assertBuildSelection(closed);
  assert.deepEqual(dependencyClosure(closed), closed);
  assert.deepEqual(dependencyClosure([...roots].reverse()), closed);
  assert.throws(() => dependencyClosure(["missing"]), /unknown build root/);
  const cycle = structuredClone(buildGraph);
  (cycle.nodes[0]!.requires as string[]).push(cycle.nodes[0]!.id);
  assert.throws(() => validateBuildGraph(cycle), /cyclic/);
  const missing = structuredClone(buildGraph);
  (missing.nodes[0]!.requires as string[]).push("unit/unknown");
  assert.throws(() => validateBuildGraph(missing), /missing dependency/);
  assert.throws(
    () => assertBuildSelection(["feature/ltx", "unit/sqlitePages"]),
    /requires/,
  );
  assert.throws(
    () => createBuildPlan(baselineSqlike(), { optimizers: ["rowMetadata"] }),
    /requires.*rowValues/,
  );
});
