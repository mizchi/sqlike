import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import { buildOxcBundle } from "./oxc-runtime.ts";
import {
  defineSqlike,
  allSqlikeFeatures,
  primaryKeyIndex,
} from "../src/sqlike-features.ts";
import { buildSqlikeRuntime } from "./build-sqlike-runtime.ts";
import { sourceHashes, engineSourcePaths } from "./measurement-manifest.ts";

const sizes = (data: Uint8Array) => ({
  raw: data.length,
  gzip: gzipSync(data, { level: 9 }).length,
  brotli: brotliCompressSync(data, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }).length,
});
async function bundle(entry: string) {
  const result = await buildOxcBundle(entry);
  const assets = (Array.isArray(result) ? result : [result]).flatMap((r) =>
    "output" in r ? r.output : [],
  );
  const chunks = assets.filter((f) => f.type === "chunk");
  const allSizes = assets.map((f) =>
    sizes(Buffer.from(f.type === "chunk" ? f.code : f.source)),
  );
  assert.equal(
    chunks.filter((f) =>
      Object.keys(f.modules).some((p) => p.endsWith("/defined/defined.js")),
    ).length,
    0,
  );
  return {
    totals: {
      raw: allSizes.reduce((n, s) => n + s.raw, 0),
      gzip: allSizes.reduce((n, s) => n + s.gzip, 0),
      brotli: allSizes.reduce((n, s) => n + s.brotli, 0),
    },
    chunks: chunks.length,
  };
}
const execution = allSqlikeFeatures.filter(
  (f) => !["binarySync", "sqlitePages", "ltx"].includes(f.name),
);
const profiles = [
  { name: "all-execution", features: execution },
  ...["dateTime", "sqlJson", "windowFunctions"].map((name) => ({
    name: `without-${name}`,
    features: execution.filter((f) => f.name !== name),
  })),
  {
    name: "without-all-three",
    features: execution.filter(
      (f) => !["dateTime", "sqlJson", "windowFunctions"].includes(f.name),
    ),
  },
  { name: "notes-minimal", features: [primaryKeyIndex] },
];
const results = [];
for (const profile of profiles) {
  const directory = resolve("generated/optional-functions", profile.name);
  const built = await buildSqlikeRuntime(
    defineSqlike({ mode: "defined", features: profile.features }),
    { outDir: directory },
  );
  const audit = await buildSqlikeRuntime(
    defineSqlike({ mode: "defined", features: profile.features }),
    { outDir: join(directory, "audit"), targets: ["js"], minify: false },
  );
  const code = await readFile(join(audit.directory, "runtime.js"), "utf8");
  const absent = Object.fromEntries(
    [
      ["dateTime", "datetime__call"],
      ["sqlJson", "json__call"],
      ["windowFunctions", "compute__windows"],
    ].map(([feature, symbol]) => {
      const missing = !new RegExp(`function [^\\n]*${symbol}\\(`).test(code);
      assert.equal(
        missing,
        !profile.features.some((f) => f.name === feature),
        `${profile.name}/${feature}`,
      );
      return [feature!, missing];
    }),
  );
  assert.doesNotMatch(code, /function [^\n]*parse__statement\(/);
  const host = join(directory, "host.ts");
  await writeFile(
    host,
    'import * as runtime from "./runtime.js";\nimport {createDefinedDatabase} from "../../../adapters/defined-database-core.ts";\nexport const DefinedDatabase=createDefinedDatabase(runtime);\n',
  );
  const runtime = await readFile(join(directory, "runtime.js"));
  const core = { totals: sizes(runtime) };
  const withHost = await bundle(host);
  const wasm = await readFile(join(directory, "runtime.wasm"));
  results.push({
    name: profile.name,
    features: built.profile.features,
    js: core.totals,
    hostAndPersistence: withHost.totals,
    wasm: sizes(wasm),
    absent,
    runtimeSHA256: createHash("sha256").update(runtime).digest("hex"),
  });
  console.log(results.at(-1));
}
const baseline = results[0]!;
const report = {
  format: 1,
  measuredAt: new Date().toISOString(),
  node: process.version,
  method:
    "Working static feature builds, identical binary execution API. Oxc client minification retaining public exports and annotations, with compact whitespace; absence checks use unminified source; gzip9/Brotli11. Individual removals retain every other execution feature; without-all-three removes only those three. notes-minimal also removes the other optional features except primaryKeyIndex. Host totals include every emitted chunk including IndexedDB; do not include schema/statements, SQLite exporter, LTX or networking. Wasm GC is release without wasm-opt and excludes host/glue. No timing claim.",
  sourceHashes: sourceHashes([
    ...engineSourcePaths(),
    "scripts/measure-optional-functions.ts",
    "scripts/build-sqlike-runtime.ts",
    "scripts/oxc-runtime.ts",
    "scripts/sqlike-runtime-declarations.ts",
    "src/sqlike-features.ts",
    "examples/profiles/notes-defined.json",
    "adapters/defined-database-core.ts",
    "src/aot-values.ts",
    "adapters/moon-image-store.ts",
    "src/persistence-contract.ts",
  ]),
  results: results.map((r) => ({
    ...r,
    removedJS: Object.fromEntries(
      ["raw", "gzip", "brotli"].map((k) => [
        k,
        baseline.js[k as keyof typeof baseline.js] -
          r.js[k as keyof typeof r.js],
      ]),
    ),
  })),
  verified: true,
};
await writeFile(
  "measurements/optional-functions-current.json",
  JSON.stringify(report, null, 2) + "\n",
);
