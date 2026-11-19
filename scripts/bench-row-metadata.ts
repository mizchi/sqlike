import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildSqlikeRuntime } from "./build-sqlike-runtime.ts";
import { fullSqlike } from "../src/sqlike-features.ts";
import { buildGraph, type SqlikeOptimizer } from "../src/sqlike-build-graph.ts";
const optimizers = buildGraph.nodes
  .filter((n) => n.kind === "optimizer")
  .map((n) => n.id.slice("optimizer/".length) as SqlikeOptimizer);
const directories = [];
for (const enabled of [false, true]) {
  const built = await buildSqlikeRuntime(fullSqlike(), {
    outDir: `generated/row-metadata-bench/${enabled ? "on" : "off"}`,
    optimizers: optimizers.filter((n) => enabled || n !== "rowMetadata"),
  });
  await copyFile(
    join(built.directory, "runtime.js"),
    join(built.directory, "sqlike.js"),
  );
  await copyFile(
    join(built.directory, "runtime.wasm"),
    join(built.directory, "sqlike.wasm"),
  );
  directories.push(built.directory);
}
execFileSync(
  process.execPath,
  [
    "--expose-gc",
    "--import",
    "tsx",
    "scripts/bench-row-values.ts",
    `--before-dir=${directories[0]}`,
    `--current-dir=${directories[1]}`,
    "--comparison=row-metadata",
    "--output=measurements/row-metadata-paired.json",
  ],
  { stdio: "inherit" },
);
