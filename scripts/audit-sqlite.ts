import { mkdirSync, writeFileSync } from "node:fs";
import * as runtime from "../_build/js/release/build/mizchi/sqlike/full/full.js";
import {
  auditPlan,
  auditRuntime,
  wasmRuntime,
  serialize,
  categorySummary,
} from "../tests/compatibility/feature-runtime.ts";
const plan = auditPlan();
const targets = {
  js: auditRuntime(plan, runtime),
  "wasm-gc": auditRuntime(plan, await wasmRuntime()),
};
const report = {
  ...plan,
  measuredAt: new Date().toISOString(),
  scope:
    "Official entry-point inventory plus explicit behavior/system requirements; matched-probe does not prove every input or combination",
  targets,
};
mkdirSync("measurements", { recursive: true });
writeFileSync("measurements/sqlite-feature-audit-node.json", serialize(report));
for (const [target, result] of Object.entries(targets))
  console.log(target, JSON.stringify(result.summary));
console.log(
  "catalog probes/js",
  Object.entries(categorySummary(plan.features, targets.js.results))
    .map(([name, s]) => `${name}=${s.counts["matched-probe"]}/${s.total}`)
    .join(" "),
);
const errors = targets.js.results.filter((r) => r.status === "oracle-error");
if (errors.length) {
  console.error("Invalid oracle probes:", serialize(errors));
  process.exitCode = 2;
}
