import assert from "node:assert/strict";
import { doConsumerCases } from "../tests/compatibility/do-consumer-cases.ts";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import {
  assertFileHashes,
  fileHash,
  sourceHashes,
  engineSourcePaths,
} from "./measurement-manifest.ts";
const paths = [
  "sqlite-speed-current",
  "aot-update-current",
  "row-store-current",
  "indexeddb-speed-current",
  "indexeddb-blob-current",
  "wasm-build-size-current",
  "aot-current",
  "runtime-current",
  "sqlike-feature-profiles-current",
  "do-speed-current",
  "do-consumer-current",
  "release-app-current",
  "release-scenarios-node",
  "release-scenarios-browser",
  "drizzle-browser-current",
  "drizzle-do-current",
  "drizzle-size-current",
  "drizzle-defined-size-current",
  "defined-size-current",
  "defined-browser-current",
  "optional-functions-current",
  "optional-functions-browser-current",
  "catalog-profiles-current",
];
const reports = Object.fromEntries(
  paths.map((name) => {
    const path = `measurements/${name}.json`,
      r = JSON.parse(readFileSync(path, "utf8"));
    assertFileHashes(r.sourceHashes ?? {});
    assert.ok(r.measuredAt, `${path}: measuredAt missing`);
    return [name, r];
  }),
);
const sql = reports["sqlite-speed-current"];
const updates = reports["aot-update-current"];
assert.deepEqual(
  updates.results.map((r: any) => r.rows),
  [100, 1000, 5000],
);
for (const artifact of updates.artifacts)
  if (artifact.name.startsWith("after/")) assertFileHashes({ [artifact.path]: artifact.sha256 });
for (const result of updates.results) {
  assert.equal(result.verified, true);
  const engines = updates.artifacts.filter((a: any) => a.name.startsWith("after/"));
  assert.equal(engines.length, 8);
  for (const engine of engines)
    for (const name of [
      "point",
      "pointMiss",
      "steady",
      "indexed",
      "plain",
      "returning",
      "miss",
      "reject",
    ]) {
      const samples = result.samples.filter(
        (s: any) => s.engine === engine.name && s.name === name,
      );
      assert.equal(samples.length, 7);
      assert.ok(samples.every((s: any) => s.iterations > 0 && s.milliseconds > 0));
    }
}
const catalogs = reports["catalog-profiles-current"];
assert.equal(catalogs.format, "sqlike-catalog-profiles@1");
assert.equal(catalogs.results.length, 12);
for (const r of catalogs.results) {
  assert.equal(r.verified, true);
  assert.ok(r.assets.selected.js.raw < r.assets.baseline.js.raw);
  for (const kind of ["baseline", "selected"])
    for (const target of ["js", "wasm"]) {
      const a = r.assets[kind][target];
      assertFileHashes({ [a.path]: a.sha256 });
    }
}
assert.equal(sql.smoke, false);
assert.deepEqual(
  sql.results.map((r: any) => [r.rows, r.coldRows]),
  [
    [100, 0],
    [1000, 0],
    [5000, 0],
    [100, 5000],
  ],
);
for (const a of Object.values(sql.artifacts) as any[])
  if (a.path) assertFileHashes({ [a.path]: a.sha256 });
const rows = reports["row-store-current"];
assert.equal(rows.results.length, 8);
for (const a of rows.artifacts) assertFileHashes({ [a.path]: a.sha256 });
for (const r of rows.results) {
  assert.equal(r.verified, true);
  assert.equal(r.samples.length, 21);
  assert.equal(r.memory.versions, 32);
  assert.ok(r.memory.observedPeak.samples.length > 0);
}
for (const name of ["indexeddb-speed-current", "indexeddb-blob-current"]) {
  const idb = reports[name];
  assert.equal(idb.smoke, false);
  assert.equal(idb.results.length, 12);
  assertFileHashes({
    "_build/js/release/build/mizchi/litestream-example/runtime/runtime.js":
      idb.artifacts.aotRuntimeSHA256,
  });
  for (const r of idb.results) {
    assert.ok(r.memory.observedPeak.samples.length > 0);
    assert.ok(r.memory.observedPeak.peak.combinedBytes > 0);
    assert.equal(r.memory.observedPeak.operations.length, 64);
    assert.equal(r.memory.observedPeak.operations[0].kind, "checkpoint");
    assert.equal(r.workloads.length, 2);
  }
}
assert.equal(reports["indexeddb-speed-current"].payloadStorageClass, "text");
assert.equal(reports["indexeddb-blob-current"].payloadStorageClass, "blob");
for (const r of reports["wasm-build-size-current"].results)
  assertFileHashes({ [r.js.path]: r.js.sha256, [r.wasm.path]: r.wasm.sha256 });
for (const a of reports["aot-current"].artifacts) assertFileHashes({ [a.path]: a.sha256 });
assert.equal(reports["aot-current"].samples.length, 9);
const runtime = reports["runtime-current"];
for (const a of runtime.engineArtifacts) assertFileHashes({ [a.path]: a.sha256 });
for (const a of runtime.assets) assertFileHashes({ ["dist" + a.path]: a.sha256 });
assert.ok(
  runtime.memory && runtime.memory.length === 3,
  "runtime retained memory for all engines required",
);
assert.ok(reports["sqlike-feature-profiles-current"].results.length >= 10);
const doReport = reports["do-speed-current"];
const consumer = reports["do-consumer-current"];
assert.equal(consumer.cases.length, 6);
assert.deepEqual(
  consumer.cases.map((c: any) => c.id),
  doConsumerCases.map((c) => c.id),
);
for (const [i, scenario] of consumer.cases.entries()) {
  assert.equal(scenario.steps, doConsumerCases[i]!.steps.length);
  assert.equal(scenario.verified, true);
  assert.equal(
    scenario.matches + scenario.explicitRejections + scenario.nativeErrors,
    scenario.steps,
  );
  if (scenario.sqlite === "unavailable")
    assert.match(scenario.sqliteVersionError, /not authorized/);
  else assert.match(scenario.sqlite, /^\d+\.\d+\.\d+/);
}
assertFileHashes(doReport.artifacts);
assert.equal(doReport.samples.length, 70);
for (const query of ["cte", "returning"])
  assert.equal(
    doReport.summary.find((s: any) => s.engine === "typed" && s.query === query).callsPerOperation,
    2,
  );
assert.equal(
  doReport.summary.find((s: any) => s.engine === "typed" && s.query === "point").callsPerOperation,
  2,
);
assert.equal(
  doReport.summary.find((s: any) => s.engine === "typed" && s.query === "real").callsPerOperation,
  4,
);
const app = reports["release-app-current"];
assertFileHashes(app.sources);
assert.equal(app.samples.length, 6);
assert.deepEqual([...new Set(app.samples.map((s: any) => s.profile))].sort(), [
  "indexed-trigger",
  "plain",
]);
for (const s of app.samples.filter((s: any) => s.run === 0)) {
  assert.equal(s.timing.read.length, 7);
  assert.equal(s.timing.write.length, 7);
  assert.ok(s.memory.observedPeak.samples.length > 0);
}
const release = reports["release-scenarios-node"];
assert.equal(release.cases.length, 9);
assert.equal(release.results.filter((r: any) => r.status === "matched").length, 34);
assert.equal(
  release.results.filter((r: any) => r.status === "not-applicable" && r.id === "U07").length,
  2,
);
assert.equal(reports["release-scenarios-browser"].checks.length, 7);
const summaryPath = "measurements/p0-completion.json";
const definedSize = reports["defined-size-current"];
assert.equal(definedSize.verified, true);
assert.ok(Object.values(definedSize.excluded).every((v) => v === true));
assert.equal(definedSize.results.length, 4);
assert.equal(definedSize.initialization.samples.length, 18);
assert.equal(reports["defined-browser-current"].verified, true);
assert.equal(reports["defined-browser-current"].offlineReopen, true);
assert.equal(reports["defined-browser-current"].namedStatementsOnly, true);
const optionalFunctions = reports["optional-functions-current"];
assert.equal(optionalFunctions.verified, true);
assert.equal(optionalFunctions.results.length, 6);
const stripped = optionalFunctions.results.find((r: any) => r.name === "without-all-three");
assert.ok(Object.values(stripped.absent).every((v) => v === true));
assert.ok(stripped.removedJS.brotli > 0);
assert.equal(reports["optional-functions-browser-current"].verified, true);
assert.equal(reports["optional-functions-browser-current"].offlineReopen, true);
for (const name of ["drizzle-browser-current", "drizzle-do-current"]) {
  const r = reports[name];
  assert.equal(r.migrations, 8);
  assert.equal(r.kitGenerated, 6);
  assert.equal(r.custom, 2);
  assert.equal(r.foreignKeyChildrenPreserved, true);
  assert.equal(r.verified, true);
}
assert.equal(reports["drizzle-browser-current"].offlineReopen, true);
assert.equal(reports["drizzle-do-current"].foreignKeysRestored, true);
const ormSize = reports["drizzle-size-current"];
assert.equal(ormSize.results[0].drizzleModules, 0);
assert.ok(ormSize.results[1].drizzleModules > 0);
if (process.argv.includes("--record")) {
  const ts = ["src", "adapters", "scripts", "tests", "e2e"].flatMap((dir) =>
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && (e.name.endsWith(".ts") || e.name.endsWith(".jsonc")))
      .map((e) => `${e.parentPath}/${e.name}`),
  );
  writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        completed: ["V01", "C01", "R01"],
        scope:
          "P0 acceptance for the documented SQLite subset and supported backend profiles; no universal compatibility or publication claim. Run through just p0-check after native/Chromium regression gates.",
        sourceHashes: sourceHashes([
          ...engineSourcePaths(),
          ...ts,
          "justfile",
          "moon.work",
          "tsconfig.workers.json",
          "wrangler.jsonc",
          "vite.config.ts",
          "scripts/service-worker.mjs",
          "tests/fixtures/persistence/v1.json",
          "src/binary-wire.json",
          "examples/profiles/notes-defined.json",
          "examples/notes/defined.generated.schema.bin",
          "examples/notes/defined.generated.statements.bin",
          "examples/notes/defined.generated.sqlite.bin",
          "examples/notes/defined.generated.manifest.json",
        ]),
        reports: Object.fromEntries(
          [
            ...paths.map((n) => `measurements/${n}.json`),
            "measurements/sqlite-feature-audit-node.json",
            "measurements/sqlite-feature-audit-chromium.json",
            "measurements/sqlike-differential-node.json",
            "measurements/sqlike-differential-chromium.json",
          ].map((p) => [p, fileHash(p)]),
        ),
      },
      null,
      2,
    ) + "\n",
  );
} else {
  const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  assertFileHashes(summary.sourceHashes);
  assertFileHashes(summary.reports);
}
console.log("V01 / C01 / R01: measurement artifacts and release evidence are current");
