import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { createSqlikeAotImportGuard } from "../scripts/sqlike-vite-imports.ts";

test("AOT import policy permits engine-free helpers and recognizes resolved engines across package copies", async () => {
  const root = resolve("npm/sqlike");
  const guard = await createSqlikeAotImportGuard(root);
  for (const id of [
    "@mizchi/sqlike/aot",
    "@mizchi/sqlike/aot/core",
    "@mizchi/sqlike/defined/core",
    "@mizchi/sqlike/defined/wasm",
    "@mizchi/sqlike/drizzle/prepared",
    "@mizchi/sqlike/features",
    "@mizchi/sqlike/pager",
    "@mizchi/sqlike/package.json",
    resolve(root, "aot-core.ts"),
    "/other/node_modules/@mizchi/sqlike/dist/pager.js",
    "/other/node_modules/@mizchi/sqlike/dist/chunks/runtime-host.js",
    "@mizchi/sqlike-tools",
    resolve(root + "-other", "full.ts"),
    "\0sqlike:aot/runtime/engine",
  ])
    assert.equal(guard(id), undefined, id);
  for (const id of [
    "@mizchi/sqlike/full?url",
    resolve(root, "full.ts"),
    resolve(root, "dist/aot.js"),
    "/other/node_modules/.pnpm/sqlike@0.1.2/node_modules/@mizchi/sqlike/dist/engine.js?v=123",
    "C:\\app\\node_modules\\@mizchi\\sqlike\\dist\\runtime.js",
  ]) {
    const diagnostic = guard(id, "src/legacy.ts");
    assert.ok(diagnostic, id);
    assert.equal(diagnostic.code, "SQLIKE_AOT_MIXED_MODE", id);
    assert.equal(diagnostic.id, "src/legacy.ts");
    assert.match(diagnostic.message, /src\/legacy\.ts/);
  }
});
