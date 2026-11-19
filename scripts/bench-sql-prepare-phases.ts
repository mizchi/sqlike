import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { engineSourcePaths, sourceHashes } from "./measurement-manifest.ts";

const results = [];
for (const target of ["js", "wasm-gc"]) {
  const stdout = execFileSync("moon", ["bench", "packages/sqlike/src/full/sql_prepare_bench_wbtest.mbt",
    "--target", target, "--release"], { encoding: "utf8", timeout: 180000 });
  assert.match(stdout, /SQL phase parse/);
  assert.match(stdout, /SQL phase prepared JSON ABI/);
  results.push({ target, stdout });
  process.stdout.write(stdout);
}
writeFileSync("measurements/dynamic-prepare-phases.json", JSON.stringify({
  format: 1, measuredAt: new Date().toISOString(), node: process.version,
  cpu: cpus()[0]?.model, moon: execFileSync("moon", ["version"], { encoding: "utf8" }).trim(),
  method: "Independent MoonBit release microbenchmarks, 1000 rows, warm primary-key SELECT. Setup excluded. Parse, schema metadata preparation, binding decode, prepared evaluation and positional JSON encoding are measured independently; means are not additive phases of a browser median. Full uncached/prepared JSON ABI probes omit host decode, encoding, LRU and clock updates. Raw MoonBit benchmark tables retained with units and deviation.",
  sourceHashes: sourceHashes([...engineSourcePaths(), "scripts/bench-sql-prepare-phases.ts"]), results,
}, null, 2) + "\n");
