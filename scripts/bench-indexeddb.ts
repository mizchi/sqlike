import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, cpus, platform, arch } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chromium } from "@playwright/test";
import { build } from "vite";
import * as defaultRuntime from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import { pathToFileURL } from "node:url";
import { buildCatalog } from "./aot-compiler.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "../tests/compatibility/native-values.ts";
import { aotBindings } from "../src/aot-values.ts";
import type {
  PersistenceFixture,
  Strategy,
} from "./indexeddb-bench-workload.ts";
import type { Value } from "../src/contract.ts";
import { sampleHeapDuring } from "./heap-sampling.ts";
import { sourceHashes } from "./measurement-manifest.ts";

const args = process.argv.slice(2);
for (const arg of args)
  if (!/^(--smoke|--blob|--output=.+|--runtime=.+|--dataset=\d+-\d+|--strategy=(snapshot|semantic|pages))$/.test(arg))
    throw Error(`unknown option ${arg}`);
const smoke = args.includes("--smoke");
const blob = args.includes("--blob");
const runtimePath = resolve(args.find(a => a.startsWith("--runtime="))?.slice(10) ??
  "_build/js/release/build/mizchi/litestream-example/runtime/runtime.js");
const runtime = runtimePath === resolve("_build/js/release/build/mizchi/litestream-example/runtime/runtime.js")
  ? defaultRuntime
  : await import(pathToFileURL(runtimePath).href) as typeof defaultRuntime;
const dataset = args.find(a => a.startsWith("--dataset="))?.slice(10);
const selectedStrategy = args.find(a => a.startsWith("--strategy="))?.slice(11);
const output =
  args.find((x) => x.startsWith("--output="))?.slice(9) ??
  (smoke
    ? "/tmp/browser-litestream-idb-smoke.json"
    : "measurements/indexeddb-speed-current.json");
const runs = smoke ? 1 : 7,
  iterations = smoke ? 2 : 32;
const schema = [
  `CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER,title TEXT,payload ${blob ? "BLOB" : "TEXT"})`,
  "CREATE INDEX ix ON t(n)",
];
const point = "UPDATE t SET n=? WHERE id=?",
  batch = "UPDATE t SET n=n+? WHERE id>=? AND id<?",
  scan = "SELECT id,n,title,payload FROM t ORDER BY id";
const bulk = `INSERT INTO t VALUES${Array(100).fill("(?,?,?,?)").join(",")}`;
const { artifact, manifest } = buildCatalog({
  schema,
  queries: [
    { name: "seed", sql: bulk },
    { name: "point", sql: point },
    { name: "batch", sql: batch },
    { name: "scan", sql: scan },
  ],
});
const hash = (x: string | Uint8Array) =>
  createHash("sha256").update(x).digest("hex");
const cells = (db: NodeDatabase) =>
  nativeValues(db, scan).map((row) => JSON.parse(aotBindings(row)));
function payload(id: number, size: number) {
  let state = id | 0,
    text = "";
  for (let i = 0; i < size; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) | 0;
    text += "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[
      (state >>> 16) & 63
    ];
  }
  return text;
}
const fixtures = new Map<
  string,
  { fixture: PersistenceFixture; expected: string }
>();
for (const [rows, width] of smoke
  ? [[100, 64]]
  : [
      [100, 64],
      [1000, 64],
      [5000, 64],
      [1000, 4096],
    ]) {
  if (dataset && `${rows}-${width}` !== dataset) continue;
  const db = new NodeDatabase(":memory:"),
    core = runtime.aot_open(artifact, "");
  try {
    for (const sql of schema) db.run(sql);
    for (let start = 0; start < rows!; start += 100) {
      const values: Value[] = [];
      for (let i = start; i < start + 100; i++)
        values.push(
          BigInt(i + 1),
          BigInt(1000000 + (i + 1) * 4),
          `note${i + 1}`,
          blob
            ? new TextEncoder().encode(payload(i + 1, width!))
            : payload(i + 1, width!),
        );
      db.run(bulk, values);
      assert.equal(
        JSON.parse(runtime.aot_execute(core, "seed", aotBindings(values)))
          .error,
        undefined,
      );
    }
    const sql = runtime.aot_export_sqlite(core);
    assert.equal(JSON.parse(runtime.sqlite_info(sql)).error, undefined);
    const id = Math.floor(rows! / 2);
    db.run(point, [BigInt(1000000 + id * 4 + 1), BigInt(id)]);
    const fixture: PersistenceFixture = {
      artifact,
      artifactHash: manifest.artifactSHA256,
      image: runtime.aot_dump(core),
      sqlite: Buffer.from(runtime.sqlite_data(sql)).toString("base64"),
      programId: JSON.parse(runtime.aot_info(core)).programId,
      emptyHash: hash(new Uint8Array()),
      rows: rows!,
      payload: width!,
      id,
    };
    fixtures.set(`${rows}-${width}`, {
      fixture,
      expected: hash(JSON.stringify(cells(db))),
    });
  } finally {
    db.close();
  }
}
const built = await build({
  plugins: [{
    name: "selected-aot-runtime",
    enforce: "pre",
    resolveId(source) {
      if (source.endsWith("/mizchi/litestream-example/runtime/runtime.js")) return runtimePath;
    },
  }],
  configFile: false,
  publicDir: false,
  logLevel: "error",
  build: {
    write: false,
      rolldownOptions: { output: { codeSplitting: false } },
    minify: false,
    target: "esnext",
    lib: {
      entry: resolve("scripts/indexeddb-bench-workload.ts"),
      formats: ["es"],
    },
  },
});
const bundle = Array.isArray(built) ? built[0] : built;
assert.ok(bundle && "output" in bundle);
const chunks = bundle.output.filter((x) => x.type === "chunk");
assert.equal(chunks.length, 1);
const runner = chunks[0]!.code;
const server = createServer((req, res) => {
  const path = new URL(req.url!, "http://localhost").pathname;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  if (path === "/runner.js") {
    res.setHeader("Content-Type", "text/javascript");
    res.end(runner);
  } else if (path.startsWith("/fixture/")) {
    const f = fixtures.get(path.slice(9));
    res.writeHead(f ? 200 : 404, { "Content-Type": "application/json" });
    res.end(f ? JSON.stringify(f.fixture) : "missing");
  } else {
    res.setHeader("Content-Type", "text/html");
    res.end("<!doctype html><title>IndexedDB flush benchmark</title>");
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const tmp = mkdtempSync(join(tmpdir(), "browser-litestream-idb-"));
const results = [];
let chromiumVersion = "";
try {
  const browser = await chromium.launch();
  chromiumVersion = browser.version();
  try {
    for (const [key, { fixture, expected }] of fixtures)
      for (const strategy of ["snapshot", "semantic", "pages"] as Strategy[]) {
        if (selectedStrategy && strategy !== selectedStrategy) continue;
        console.log(`${key}/${strategy}`);
        const context = await browser.newContext({ serviceWorkers: "block" }),
          page = await context.newPage();
        try {
          await page.goto(origin);
          await page.evaluate(async () => {
            await import(/* @vite-ignore */ `${location.origin}/runner.js`);
          });
          const cdp = await context.newCDPSession(page);
          const heap = async () => {
            await cdp.send("HeapProfiler.collectGarbage");
            return cdp.send("Runtime.getHeapUsage");
          };
          const baseline = await heap();
          const name = `bench-${key}-${strategy}-${Date.now().toString(36)}`;
          const started = performance.now();
          await page.evaluate(
            async ({ strategy, key, name }) =>
              (
                await import(/* @vite-ignore */ `${location.origin}/runner.js`)
              ).setup(strategy, `/fixture/${key}`, name),
            { strategy, key, name },
          );
          const setupMs = performance.now() - started;
          const workloads = [];
          for (const name of ["point", "batch"] as const) {
            const samples = await page.evaluate(
              ({ name, runs, iterations }) =>
                window.persistenceBench.measure(name, runs, iterations),
              { name, runs, iterations },
            );
            const verified = await page.evaluate(() =>
              window.persistenceBench.verify(),
            );
            assert.equal(
              verified.digest,
              expected,
              `${key}/${strategy}/${name}/native typed rows`,
            );
            if (verified.sqlite) {
              const file = join(tmp, `${key}-${name}.sqlite`);
              writeFileSync(file, Buffer.from(verified.sqlite, "base64"));
              const native = new NodeDatabase(file);
              try {
                assert.equal(
                  hash(JSON.stringify(cells(native))),
                  expected,
                  "persisted page file/native SQLite",
                );
              } finally {
                native.close();
              }
            }
            const all = samples.flat(),
              median = (values: number[]) =>
                values.toSorted((a, b) => a - b)[
                  Math.floor(values.length / 2)
                ]!;
            const summary = {
              medianRunUs:
                median(
                  samples.map(
                    (run) =>
                      run.reduce((n, s) => n + s.totalMs, 0) / run.length,
                  ),
                ) * 1000,
              meanUs:
                (all.reduce((n, s) => n + s.totalMs, 0) / all.length) * 1000,
              prepareUs:
                (all.reduce((n, s) => n + s.prepareMs, 0) / all.length) * 1000,
              idbUs: (all.reduce((n, s) => n + s.idbMs, 0) / all.length) * 1000,
              meanPayloadBytes:
                all.reduce((n, s) => n + s.bytes, 0) / all.length,
              medianDeltaBytes: median(
                all.filter((s) => s.kind === "delta").map((s) => s.bytes),
              ),
              checkpoints: all.filter((s) => s.kind === "checkpoint").length,
            };
            console.log(name, JSON.stringify(summary));
            workloads.push({
              name,
              samples,
              summary,
              expectedSHA256: expected,
            });
          }
          const retained = await heap();
          await page.evaluate(() => window.persistenceBench.preparePeak());
          const { value: probe, ...observedPeak } = await sampleHeapDuring(
            () =>
              page.evaluate(() =>
                window.persistenceBench.measure("point", 1, 64, 0),
              ),
            () => cdp.send("Runtime.getHeapUsage"),
          );
          await page.evaluate(() => window.persistenceBench.startProbe());
          await page.waitForFunction(() => window.persistenceBench.held);
          const prepared = await heap();
          await page.evaluate(() => window.persistenceBench.releaseProbe());
          const after = await heap();
          await page.evaluate(() => window.persistenceBench.close());
          results.push({
            rows: fixture.rows,
            payloadBytesPerRow: fixture.payload,
            strategy,
            setupMs,
            workloads,
            memory: { baseline, retained, prepared, after, observedPeak: {
              ...observedPeak,
              operations: probe.flat().map(({ kind, bytes, totalMs }) => ({ kind, bytes, totalMs })),
            } },
            fixtureSHA256: hash(JSON.stringify(fixture)),
          });
        } finally {
          await context.close();
        }
      }
  } finally {
    await browser.close();
  }
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(tmp, { recursive: true });
}
const report = {
  sourceHashes: sourceHashes([
    "scripts/bench-indexeddb.ts",
    "scripts/indexeddb-bench-workload.ts",
    "scripts/heap-sampling.ts",
    "adapters/aot-database.ts",
    "adapters/moon-image-store.ts",
    "src/aot-values.ts",
  ]),
  format: 1,
  measuredAt: new Date().toISOString(),
  smoke,
  payloadStorageClass: blob ? "blob" : "text",
  selection: { dataset, strategy: selectedStrategy, runtime: runtimePath },
  environment: {
    node: process.version,
    chromium: chromiumVersion,
    cpu: cpus()[0]?.model,
    platform: platform(),
    arch: arch(),
    moon: execFileSync("moon", ["version"], { encoding: "utf8" }).split(
      "\n",
    )[0],
    nativeOracle: process.versions.sqlite,
  },
  method: {
    runs,
    iterations,
    warmup: 2,
    description:
      "Same MoonBit release JS AOT artifact, bound SQL and data. Snapshot = existing full SavedState JSON per strict IDB commit. Semantic = materialized column patches (v2, with v1 replay) plus binary side attachments. Pages = full SQLite export, full-buffer 4096-byte comparison and binary dirty pages in the same IDB journal contract; not a lazy pager and not OS-aligned I/O. Both incremental paths compact at 128 records or 4 MiB. Point updates alternate equal-width INTEGER values; batch alternates +/-1 on 16 adjacent rows. Per-call total, preparation and IDB submission+strict-complete recorded; all 7x32 operations retained including compactions. ASCII payload lengths count submitted image/delta bytes, excluding constant generation metadata; --blob stores the same pseudorandom ASCII bytes as BLOB instead of TEXT. Both layouts use two puts per commit. Native typed-result hashes checked after each workload and after replay; page files reopened by native SQLite. CPU run sequentially on one machine, no throttling. Separate fresh Chromium context/page per layout/dataset.",
    memory:
      "Baseline/retained/prepared/after use CDP Runtime.getHeapUsage after forced GC. Used JS heap and backingStorageSize are separate. observedPeak samples without forced GC during a separate untimed 64-update workload at a requested 2ms interval. Its first write forces a full checkpoint to match compaction phase across journal versions; timed workloads keep their natural checkpoint schedule. Timestamps, simultaneous combined bytes, and each probe operation kind/bytes/duration are retained. CDP latency and synchronous work can hide transient peaks. This is a sampled high-water observation, not an exact allocation peak, RSS or IndexedDB service memory. Prepared is paused just before IDB submission. Current engine keeps all rows; pages add a full SQLite buffer.",
  },
  artifacts: {
    runnerSHA256: hash(runner),
    aotRuntimeSHA256: hash(readFileSync(runtimePath)),
    programSHA256: manifest.artifactSHA256,
  },
  results,
};
writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(`Saved ${output}`);
