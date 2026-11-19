import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";
import { execFileSync } from "node:child_process";
import { buildSqlikeRuntime } from "./build-sqlike-runtime.ts";
import {
  baselineSqlike,
  fullSqlike,
  defineSqlike,
  primaryKeyIndex,
} from "../src/sqlike-features.ts";
import {
  engineSourcePaths,
  sourceHashes,
  fileHash,
} from "./measurement-manifest.ts";

const catalog = {
  schema: ["CREATE TABLE item(id INTEGER PRIMARY KEY,n INTEGER)"],
  queries: [
    { name: "add", sql: "INSERT INTO item VALUES(?,?)" },
    { name: "get", sql: "SELECT n*2 AS doubled FROM item WHERE id=?" },
  ],
};
const aot = defineSqlike({
  mode: "aot",
  features: fullSqlike("aot")
    .features.filter((n) => n !== "sqlitePages")
    .map((name) => ({ name })),
});
const selected = defineSqlike({ mode: "aot", features: [primaryKeyIndex] });
const profiles = [
  { name: "baseline", profile: baselineSqlike(), options: {} },
  { name: "full", profile: fullSqlike(), options: {} },
  {
    name: "full-no-optimizers",
    profile: fullSqlike(),
    options: { optimizers: [] },
  },
  { name: "aot", profile: aot, options: {} },
  { name: "aot-selected", profile: selected, options: { catalog } },
  {
    name: "aot-selected-no-optimizers",
    profile: selected,
    options: { catalog, optimizers: [] },
  },
] as const;
const rows = [];
for (const { name, profile, options } of profiles) {
  const directory = join("generated/entrypoint-sizes", name);
  const built = await buildSqlikeRuntime(profile, {
    outDir: directory,
    ...options,
  });
  const files = [];
  for (const target of ["js", "wasm"]) {
    const path = join(directory, `runtime.${target}`),
      bytes = await readFile(path);
    const brotli = brotliCompressSync(bytes, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    });
    files.push({
      target,
      bytes: bytes.length,
      brotli: brotli.length,
      sha256: fileHash(path),
    });
  }
  rows.push({
    name,
    exports: built.exports,
    optimizers: built.plan.optimizers,
    selected: built.plan.selected,
    files,
  });
}
await mkdir("measurements", { recursive: true });
await writeFile(
  "measurements/sqlike-entrypoints-current.json",
  JSON.stringify(
    {
      format: "sqlike-entrypoint-sizes@1",
      measuredAt: new Date().toISOString(),
      node: process.version,
      moon: execFileSync("moon", ["version"], { encoding: "utf8" }).trim(),
      js: "MoonBit release, one engine per link, OXC minified, uncompressed bytes and Brotli quality 11",
      wasm: "MoonBit release Wasm GC, raw bytes and Brotli quality 11; requires GC and JS string builtins",
      scope:
        "Engine only; excludes host wrappers and catalog data. Full is all implemented SQL features, not full SQLite compatibility. Optimizer pairs have identical semantic profiles/exports. Baseline and AOT differ in API and capability scope.",
      catalog,
      rows,
      sources: sourceHashes([
        ...engineSourcePaths(),
        "scripts/measure-entrypoints.ts",
        "scripts/build-sqlike-runtime.ts",
        "scripts/sqlike-runtime-declarations.ts",
        "scripts/oxc-runtime.ts",
        "src/sqlike-build-graph.json",
        "src/sqlike-build-plan.ts",
        "src/sqlike-features.ts",
      ]),
    },
    null,
    2,
  ) + "\n",
);
console.table(
  rows.flatMap((r) =>
    r.files.map((f) => ({
      profile: r.name,
      target: f.target,
      KiB: (f.bytes / 1024).toFixed(2),
      BrotliKiB: (f.brotli / 1024).toFixed(2),
    })),
  ),
);
