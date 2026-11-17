import { createHash } from "node:crypto";
import { differentialCorpus } from "../tests/compatibility/differential-corpus.ts";
import { readFileSync } from "node:fs";
import {
  differentialGate,
  type DifferentialReport,
} from "../tests/compatibility/differential-gate.ts";
const files = process.argv.slice(2);
if (!files.length)
  files.push(
    "measurements/sqlike-differential-node.json",
    "measurements/sqlike-differential-chromium.json",
  );
let failed = false;
let corpus: string | undefined;
for (const path of files) {
  const report = JSON.parse(
    readFileSync(path, "utf8"),
  ) as DifferentialReport & {
    seed: number;
    family?: string | null;
    artifacts?: Record<string, string>;
  };
  const expectedCases = differentialCorpus(report.seed).filter(
    (c) => !report.family || c.family === report.family,
  );
  if (JSON.stringify(expectedCases) !== JSON.stringify(report.cases)) {
    failed = true;
    console.error(`${path}: stale or incomplete corpus`);
  }
  for (const [file, expected] of Object.entries(report.artifacts ?? {}))
    if (
      createHash("sha256").update(readFileSync(file)).digest("hex") !== expected
    ) {
      failed = true;
      console.error(`${path}: stale artifact ${file}`);
    }
  const key = JSON.stringify({ seed: report.seed, cases: report.cases });
  if (corpus && corpus !== key) {
    failed = true;
    console.error("corpus/seed differs across reports");
  }
  corpus = key;
  const targets = path.includes("chromium")
    ? [
        "chromium-js/sql",
        "chromium-wasm/sql",
        "chromium-js/aot",
        "chromium-wasm/aot",
        "chromium-js/prepared-sql",
        "chromium-wasm/prepared-sql",
      ]
    : ["js/sql", "wasm/sql", "js/aot", "wasm/aot", "js/prepared-sql", "wasm/prepared-sql"];
  const problems = differentialGate(report, targets);
  failed ||= problems.length > 0;
  console.log(
    `${path}: ${report.cases.length} cases, ${report.results.length} results, ${problems.length} failing checks`,
  );
  for (const p of problems.slice(0, 8)) console.error(p);
}
if (failed) process.exitCode = 1;
