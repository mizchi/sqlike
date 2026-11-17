import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { brotliCompressSync, constants } from "node:zlib";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { minifyRuntime } from "./oxc-runtime.ts";
import { assertFileHashes, engineSourcePaths, sourceHashes, fileHash } from "./measurement-manifest.ts";

const inputs = [
  "measurements/optimization-trials-before/dynamic-prepare-large-current.json",
  "measurements/optimization-trials-before/wasm-build-size-current.json",
  "measurements/optimization-index-large.json", "measurements/optimization-update-large.json",
  "measurements/dynamic-prepare-large-current.json", "measurements/wasm-build-size-current.json",
  "measurements/optimization-typed-results.json", "measurements/optimization-bulk-write.json",
  "measurements/delete-current.json",
];
const reports = inputs.map(path => JSON.parse(readFileSync(path, "utf8")));
for (const report of reports.slice(4)) {
  assertFileHashes(report.sourceHashes);
  if (report.artifacts && !Array.isArray(report.artifacts)) {
    const entries = Object.entries(report.artifacts);
    if (entries.every(([, v]) => typeof v === "string")) assertFileHashes(report.artifacts);
    else for (const [, v] of entries as [string, any][]) if (v.path) assertFileHashes({ [v.path]: v.sha256 });
  }
}
const [before, beforeSize, index, update, current, size, typed, bulk, deletes] = reports;
const median = (values: number[]) => { assert.ok(values.length); return values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!; };
const data = (r: any) => r.results.find((x: any) => x.rows === 100000 && x.coldRows === 0);
const query = (r: any, name: string, engine: string) => data(r).medians.find((s: any) => s.name === name && s.engine === engine).microseconds;
const movement = (r: any, engine: string) => median(data(r).indexMovement.find((s: any) => s.engine === engine).samples.map((s: any) => s.milliseconds * 1000 / s.iterations));
const typedTime = (r: any, name: string, engine: string) => median(r.samples.filter((s: any) => s.query === name && s.engine === engine).map((s: any) => s.milliseconds * 1000 / s.iterations));
const metrics = {
  pointDelete: deletes.medians,
  indexMovement: ["js", "wasm"].map(target => ({ target,
    beforeUs: movement(before, `sqlike-${target}/prepared`),
    indexOnlyUs: movement(index, `sqlike-${target}/prepared`),
    currentUs: movement(current, `sqlike-${target}/prepared`),
    sqliteUs: movement(current, "sqlite/prepared"),
  })),
  sameValueUpdate: ["js", "wasm"].map(target => ({ target,
    beforeUs: query(before, "update", `sqlike-${target}/prepared`),
    updateTrialUs: query(update, "update", `sqlike-${target}/prepared`),
    currentUs: query(current, "update", `sqlike-${target}/prepared`),
    sqliteUs: query(current, "update", "sqlite/prepared"),
  })),
  nativeResults: typed.results.flatMap((r: any) => ["point", "scan"].map(name => ({ rows: r.rows, name,
    jsonToNativeUs: typedTime(r, name, "json-to-native-values"), nativeUs: typedTime(r, name, "native-values"),
  }))),
  nativeAotResults: typed.results.flatMap((r: any) => ["point", "scan"].map(name => ({ rows: r.rows, name,
    jsonToNativeUs: typedTime(r, name, "aot-json-to-native-values"), nativeUs: typedTime(r, name, "aot-native-values"),
  }))),
  bulkWrites: [1000, 10000, 100000].flatMap(rows => ["explicit", "automatic"].flatMap(mode =>
    ["before/js", "after/js", "before/wasm", "after/wasm", "sqlite/prepared"].map(engine => {
      const samples = bulk.results.filter((s: any) => s.rows === rows && s.mode === mode && s.engine === engine);
      assert.equal(samples.length, 3); assert.ok(samples.every((s: any) => s.verified));
      const completed = samples.filter((s: any) => s.insertStatus === "complete");
      return { rows, mode, engine, completeRuns: completed.length,
        insertMilliseconds: completed.length === 3 ? median(completed.map((s: any) => s.insertMilliseconds)) : null,
        insertedPrefixes: samples.map((s: any) => s.inserted),
        deleteUs: completed.length === 3 ? median(completed.map((s: any) => s.deleteMilliseconds * 1000 / s.deleted)) : null,
      };
    }))),
  size: size.results.map((r: any) => {
    const previous = beforeSize.results.find((b: any) => b.name === r.name);
    assert.deepEqual(previous.exports, r.exports);
    return { name: r.name, before: previous.js.minified, after: r.js.minified,
      brotliDeltaBytes: r.js.minified.brotli - previous.js.minified.brotli };
  }),
};
async function standaloneSize(path: string) {
  const module = await import(pathToFileURL(resolve(path)).href);
  const code = await minifyRuntime(path, Object.keys(module));
  return { path, sha256: fileHash(path), exports: Object.keys(module), minifiedBytes: Buffer.byteLength(code),
    brotliBytes: brotliCompressSync(code, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length };
}
const standalone = await standaloneSize("_build/js/release/build/mizchi/sqlike/experimental-typed/experimental-typed.js");
const aotStandalone = await standaloneSize("_build/js/release/build/mizchi/sqlike/experimental-aot-typed/experimental-aot-typed.js");
const aotCatalog = await standaloneSize("generated/notes-native/runtime.js");
writeFileSync("measurements/optimization-trials-current.json", JSON.stringify({
  format: "sqlike-optimization-trials@1", measuredAt: new Date().toISOString(), baselineCommit: "2f1d702",
  decisions: { indexPages: "adopted", updateStorage: "adopted", nativeJsResults: "experimental-separate-entry",
    rowidAllocation: "adopted", pointDelete: "adopted: bounded rowid-order leaves and sequential block scans; see delete-current.json" },
  sourceHashes: sourceHashes([...engineSourcePaths(), "scripts/report-optimization-trials.ts", "scripts/oxc-runtime.ts",
    "scripts/build-sqlike-runtime.ts", "scripts/sqlike-runtime-declarations.ts", "scripts/analyze-catalog.ts",
    "src/catalog-capabilities.ts", "src/runtime-capabilities.json", "src/sqlike-features.ts",
    "examples/profiles/notes-native-aot.json", "examples/notes/catalog.json"]),
  inputs: Object.fromEntries(inputs.map(path => [path, fileHash(path)])), metrics, experimentalStandalone: standalone,
  experimentalAotStandalone: aotStandalone,
  experimentalAotCatalog: { ...aotCatalog, profile: JSON.parse(readFileSync("generated/notes-native/profile.json", "utf8")) },
}, null, 2) + "\n");
console.log(JSON.stringify({ metrics, experimentalStandalone: standalone }, null, 2));
