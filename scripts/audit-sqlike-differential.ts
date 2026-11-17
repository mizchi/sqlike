import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import * as sql from "../_build/js/release/build/mizchi/sqlike/sqlike.js";
import * as aot from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import { compile_program } from "../_build/js/release/build/mizchi/sqlike/compiler/compiler.js";
import { differentialCorpus } from "../tests/compatibility/differential-corpus.ts";
import { oracleTraces } from "../tests/compatibility/differential-node.ts";
import { auditTarget } from "../tests/compatibility/differential-runtime.ts";
import { differentialGate } from "../tests/compatibility/differential-gate.ts";
import { auditExportIntegrity } from "./audit-sqlike-exports.ts";
const args = process.argv.slice(2);
for (const arg of args)
  if (
    !/^(--seed=(?:0x[0-9a-f]+|\d+)|--family=[\w-]+|--output=.+|--report-only)$/.test(
      arg,
    )
  )
    throw Error(`unknown option ${arg}`);
const seed = Number(
  args.find((a) => a.startsWith("--seed="))?.slice(7) ?? 0x51a17e,
);
const family = args.find((a) => a.startsWith("--family="))?.slice(9);
const output =
  args.find((a) => a.startsWith("--output="))?.slice(9) ??
  "measurements/sqlike-differential-node.json";
const cases = differentialCorpus(seed).filter(
  (c) => !family || c.family === family,
);
if (!cases.length) throw Error("no matching cases");
const oracle = oracleTraces(cases);
const wasm = async (path: string) =>
  (
    await WebAssembly.instantiate(
      readFileSync(path),
      {},
      { builtins: ["js-string"], importedStringConstants: "_" },
    )
  ).instance.exports;
const runtime = { sql, aot, compile: compile_program };
const wr = {
  sql: (await wasm(
    "_build/wasm-gc/release/build/mizchi/sqlike/sqlike.wasm",
  )) as unknown as typeof sql,
  aot: (await wasm(
    "_build/wasm-gc/release/build/mizchi/litestream-example/runtime/runtime.wasm",
  )) as unknown as typeof aot,
  compile: compile_program,
};
const results = [
  ...auditTarget(cases, oracle.traces, runtime, "js/prepared-sql", false, oracle.compileErrors, true),
  ...auditTarget(cases, oracle.traces, wr, "wasm/prepared-sql", false, oracle.compileErrors, true),
  ...auditTarget(
    cases,
    oracle.traces,
    runtime,
    "js/sql",
    false,
    oracle.compileErrors,
  ),
  ...auditTarget(
    cases,
    oracle.traces,
    wr,
    "wasm/sql",
    false,
    oracle.compileErrors,
  ),
  ...auditTarget(
    cases,
    oracle.traces,
    runtime,
    "js/aot",
    true,
    oracle.compileErrors,
  ),
  ...auditTarget(
    cases,
    oracle.traces,
    wr,
    "wasm/aot",
    true,
    oracle.compileErrors,
  ),
];
const counts = Object.fromEntries(
  [...new Set(results.map((r) => r.status))].map((status) => [
    status,
    results.filter((r) => r.status === status).length,
  ]),
);
const artifacts = Object.fromEntries(
  [
    "tests/compatibility/differential-runtime.ts",
    "src/sql-statement-cache.ts",
    "_build/js/release/build/mizchi/sqlike/sqlike.js",
    "_build/js/release/build/mizchi/sqlike/compiler/compiler.js",
    "_build/js/release/build/mizchi/litestream-example/runtime/runtime.js",
    "_build/wasm-gc/release/build/mizchi/sqlike/sqlike.wasm",
    "_build/wasm-gc/release/build/mizchi/litestream-example/runtime/runtime.wasm",
  ].map((path) => [
    path,
    createHash("sha256").update(readFileSync(path)).digest("hex"),
  ]),
);
const exportIntegrity = auditExportIntegrity(cases);
const report = {
  corpusSHA256: createHash("sha256")
    .update(JSON.stringify(cases))
    .digest("hex"),
  exportIntegrity,
  oracleSetupErrors: cases
    .filter((c) => oracle.traces[c.id]!.setupFailed)
    .map((c) => c.id),
  format: 1,
  measuredAt: new Date().toISOString(),
  seed,
  family: family ?? null,
  node: process.version,
  scope:
    "Typed positional outputs, error categories and state after every step; AOT compile rejection is separate from executed matches. Deterministic generated corpus; not a proof of full SQLite compatibility.",
  cases,
  counts,
  results,
  artifacts,
  oracleVersion: process.versions.sqlite,
};
mkdirSync("measurements", { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ cases: cases.length, counts, output }));
console.table(
  [...new Set(cases.map((c) => c.family))].map((family) => ({
    family,
    cases: cases.filter((c) => c.family === family).length,
    mismatch: results.filter(
      (r) => r.family === family && r.status === "mismatch",
    ).length,
    unsupported: results.filter(
      (r) => r.family === family && r.status === "unsupported",
    ).length,
  })),
);
if (
  !args.includes("--report-only") &&
  differentialGate(report, ["js/sql", "wasm/sql", "js/aot", "wasm/aot", "js/prepared-sql", "wasm/prepared-sql"]).length
)
  process.exitCode = 1;

if (report.oracleSetupErrors.length) process.exitCode = 2;
