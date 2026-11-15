import { readFileSync } from "node:fs";
import {
  auditPlan,
  type AuditPlan,
} from "../tests/compatibility/feature-runtime.ts";
import {
  assertFullCompatibility,
  assertOutputCompatibility,
  type AuditResult,
} from "../tests/compatibility/feature-audit.ts";
const outputOnly = process.argv.includes("--output-only");
const current = auditPlan();
const node = JSON.parse(
  readFileSync("measurements/sqlite-feature-audit-node.json", "utf8"),
);
const browser = JSON.parse(
  readFileSync("measurements/sqlite-feature-audit-chromium.json", "utf8"),
);
const targets: { name: string; report: AuditPlan; results: AuditResult[] }[] = [
  { name: "js", report: node, results: node.targets.js.results },
  { name: "wasm-gc", report: node, results: node.targets["wasm-gc"].results },
  { name: "chromium-js", report: browser, results: browser.results },
];
let failures = 0;
for (const { name, report, results } of targets) {
  try {
    for (const key of [
      "catalogSHA256",
      "planSHA256",
      "sourceSHA256",
      "harnessSHA256",
      "oracleSHA256",
    ] as const)
      if (report[key] !== current[key]) throw Error(`Stale ${key}`);
    if (JSON.stringify(report.artifacts) !== JSON.stringify(current.artifacts))
      throw Error("Stale compiled engine artifacts");
    (outputOnly ? assertOutputCompatibility : assertFullCompatibility)(
      results,
      current.features.map((f) => f.id),
    );
    console.log(
      outputOnly
        ? `${name}: observed successful outputs match; atomic rejections=${results.filter((r) => r.status === "candidate-error").length}, matched probes=${results.filter((r) => r.status === "matched-probe").length}; unverified inventory remains`
        : `${name}: every catalog probe matched`,
    );
  } catch (error) {
    console.error(`${name}: ${(error as Error).message}`);
    failures++;
  }
}
if (failures) {
  console.error(
    outputOnly
      ? "SQLite output compatibility gate failed. See measurements/sqlite-feature-audit-*.json."
      : "SQLite full-feature compatibility has NOT been verified. See measurements/sqlite-feature-audit-*.json.",
  );
  process.exitCode = 1;
}
