import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import { buildOxcBundle } from "./oxc-runtime.ts";
import * as legacy from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import * as defined from "../_build/js/release/build/mizchi/sqlike/defined/defined.js";
import { compile_program } from "../_build/js/release/build/mizchi/sqlike/compiler/compiler.js";
import { buildDefinedCatalog } from "./defined-compiler.ts";
import {
  sourceHashes,
  engineSourcePaths,
  fileHash,
} from "./measurement-manifest.ts";
import type { CatalogSource } from "../src/aot-contract.ts";
const source = JSON.parse(
  readFileSync("examples/notes/catalog.json", "utf8"),
) as CatalogSource;
const catalog = buildDefinedCatalog(source, { sqliteExport: true });
const sizes = (data: Uint8Array) => ({
  raw: data.length,
  gzip: gzipSync(data, { level: 9 }).length,
  brotli: brotliCompressSync(data, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }).length,
});
const entries = [
  [
    "legacy JSON AOT + SQLite + LTX",
    "_build/js/release/build/mizchi/litestream-example/runtime/runtime.js",
  ],
  [
    "binary definitions execution core",
    "_build/js/release/build/mizchi/sqlike/defined/defined.js",
  ],
  [
    "optional binary SQLite exporter",
    "_build/js/release/build/mizchi/sqlike/defined-sqlite/defined-sqlite.js",
  ],
  ["binary host + named API + persistence", "adapters/defined-database.ts"],
] as const;
const results = [];
for (const [name, entry] of entries) {
  const result = await buildOxcBundle(entry);
  const assets: { file: string; raw: number; gzip: number; brotli: number }[] =
    [];
  for (const b of Array.isArray(result) ? result : [result])
    if ("output" in b)
      for (const f of b.output) {
        const data = Buffer.from(f.type === "chunk" ? f.code : f.source);
        assets.push({ file: f.fileName, ...sizes(data) });
      }
  results.push({
    name,
    entry,
    assets,
    totals: Object.fromEntries(
      ["raw", "gzip", "brotli"].map((k) => [
        k,
        assets.reduce((n, a) => n + a[k as "raw" | "gzip" | "brotli"], 0),
      ]),
    ),
  });
}
const code = readFileSync(entries[1][1], "utf8");
const excluded = {
  ddlParser: !code.includes("parse__statement("),
  schemaMigration: !code.includes("migrate__schema("),
  schemaJSONReader: !code.includes("5StorePC14json8FromJson"),
  astJSONReader: !code.includes("4ExprPC14json8FromJson"),
  programJSONReader: !code.includes("15CompiledProgramPC14json8FromJson"),
  sqliteWriter: !code.includes("sqlite__export("),
};
assert.ok(Object.values(excluded).every(Boolean));
const artifact = compile_program(JSON.stringify(source));
const samples: { engine: string; run: number; microseconds: number }[] = [];
const iterations = 200;
for (const engine of ["legacy-json", "binary"]) {
  const open = () =>
    engine === "binary"
      ? JSON.parse(
          defined.defined_info(
            defined.defined_open(
              catalog.schema,
              catalog.statements,
              new Uint8Array(),
            ),
          ),
        )
      : JSON.parse(legacy.aot_info(legacy.aot_open(artifact, "")));
  for (let i = 0; i < 30; i++) assert.equal(open().error, undefined);
  for (let run = 0; run < 9; run++) {
    const start = performance.now();
    for (let i = 0; i < iterations; i++)
      assert.equal(open().queryCount, source.queries.length);
    samples.push({
      engine,
      run,
      microseconds: ((performance.now() - start) * 1000) / iterations,
    });
  }
}
const report = {
  measuredAt: new Date().toISOString(),
  sourceHashes: sourceHashes([
    ...engineSourcePaths(),
    ...entries.map((e) => e[1]),
    "adapters/defined-database-core.ts",
    "scripts/measure-defined.ts",
    "scripts/oxc-runtime.ts",
    "scripts/defined-compiler.ts",
    "src/binary-wire.json",
    "src/defined-contract.ts",
    "examples/notes/catalog.json",
    "examples/notes/defined.generated.ts",
  ]),
  method:
    "Oxc client minification, whitespace compacted, annotations and public entry exports retained; per-asset gzip9/Brotli11. Exporter is independently compiled and may duplicate executor dependencies; sizes are not additive savings. Init compares the same notes DDL/query source without a SQLite layout on both loaders; unminified Moon core definition decode/validation + info only, excludes IDB/host Crypto and statement execution.",
  node: process.version,
  results,
  excluded,
  artifacts: {
    schema: sizes(catalog.schema),
    statements: sizes(catalog.statements),
    optionalSQLite: sizes(catalog.storage!),
    legacyProgramWithoutStorage: sizes(Buffer.from(artifact)),
    schemaId: catalog.manifest.schemaId,
    programId: catalog.manifest.programId,
    legacyPublicRuntimeSHA256: fileHash(entries[0][1]),
    binaryRuntimeSHA256: fileHash(entries[1][1]),
  },
  initialization: { iterations, samples },
  verified: true,
};
writeFileSync(
  "measurements/defined-size-current.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log({
  results: results.map(({ name, totals }) => ({ name, ...totals })),
  artifacts: report.artifacts,
  excluded,
});
