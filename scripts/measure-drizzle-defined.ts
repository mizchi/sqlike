import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { measureBrowserBundle } from "./bundle-size.ts";
import { sourceHashes } from "./measurement-manifest.ts";

const entry = "npm/sqlike/drizzle-prepared.ts";
const { files, ...adapter } = await measureBrowserBundle(entry);
assert.deepEqual(adapter.exports, ["openDrizzlePrepared"]);
assert.ok([...files.keys()].every((f) => f.endsWith(".js")));
const report = {
  format: 1,
  measuredAt: new Date().toISOString(),
  node: process.version,
  scope:
    "Standalone optional Drizzle prepared host adapter, public exports retained, Oxc browser ESM; excludes injected engine/factory, catalog and binding-plan data. Brotli quality 11 per asset. Not the full app or an additive compressed-size estimate. Minimal browser execution and ORM/parser exclusion are checked in tests/drizzle-defined.test.ts.",
  sourceHashes: sourceHashes([
    entry,
    "npm/sqlike/package.json",
    "scripts/measure-drizzle-defined.ts",
    "scripts/bundle-size.ts",
    "adapters/drizzle-defined.ts",
    "src/drizzle-defined-contract.ts",
    "src/drizzle-defined-values.ts",
    "src/aot-values.ts",
    "src/defined-database-contract.ts",
    "src/defined-contract.ts",
    "src/contract.ts",
    "src/persistence-contract.ts",
    "tests/drizzle-defined.test.ts",
  ]),
  adapter,
};
await writeFile(
  "measurements/drizzle-defined-size-current.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log("Optional Drizzle prepared adapter", adapter.totals);
