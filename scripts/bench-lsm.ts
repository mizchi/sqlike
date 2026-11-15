import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { cpus, arch, platform } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import { chromium } from "@playwright/test";
import { build } from "vite";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "../tests/compatibility/native-values.ts";
import {
  makeValue,
  type Strategy,
  type LsmSample,
} from "./lsm-bench-workload.ts";

const args = process.argv.slice(2);
for (const a of args)
  if (!/^(--smoke|--output=.+)$/.test(a)) throw Error(`unknown option ${a}`);
const smoke = args.includes("--smoke"),
  runs = smoke ? 1 : 7,
  iterations = smoke ? 2 : 64;
const output =
  args.find((a) => a.startsWith("--output="))?.slice(9) ??
  (smoke
    ? "/tmp/browser-litestream-lsm-smoke.json"
    : "measurements/lsm-current.json");
const fixtures = smoke
  ? [[100, 64]]
  : [
      [100, 64],
      [1000, 64],
      [5000, 64],
      [1000, 4096],
    ];
const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const expected = new Map<
  string,
  { seeded: string; updated: string; valuesSHA256: string }
>();
for (const [rows, width] of fixtures) {
  const db = new NodeDatabase(":memory:"),
    input = createHash("sha256");
  try {
    db.run("CREATE TABLE t(k INTEGER PRIMARY KEY,n INTEGER,p BLOB)");
    for (let i = 1; i <= rows!; i++) {
      const value = makeValue(i, width!);
      input.update(value);
      db.run("INSERT INTO t VALUES(?,?,?)", [
        BigInt(i),
        BigInt(1000000 + i * 4),
        value.subarray(8),
      ]);
    }
    const digest = () =>
      hash(
        JSON.stringify(
          nativeValues(db, "SELECT k,n,p FROM t ORDER BY k").map(
            ([k, n, p]) => [
              String(k),
              String(n),
              Buffer.from(p as Uint8Array).toString("base64"),
            ],
          ),
        ),
      );
    const seeded = digest();
    db.run("UPDATE t SET n=n+1 WHERE k=?", [BigInt(Math.floor(rows! / 2))]);
    expected.set(`${rows}-${width}`, {
      seeded,
      updated: digest(),
      valuesSHA256: input.digest("hex"),
    });
  } finally {
    db.close();
  }
}
async function bundle(entry: string, minify: boolean) {
  const built = await build({
    configFile: false,
    publicDir: false,
    logLevel: "error",
    build: {
      write: false,
      minify,
      target: "esnext",
      lib: { entry: resolve(entry), formats: ["es"] },
    },
  });
  const chunks = (Array.isArray(built) ? built : [built]).flatMap((x) =>
    "output" in x ? x.output.filter((f) => f.type === "chunk") : [],
  );
  assert.equal(chunks.length, 1);
  return chunks[0]!.code;
}
const runner = await bundle("scripts/lsm-bench-workload.ts", false);
const standalone = await bundle("e2e/fixtures/lsm-runtime.ts", true);
function size(bytes: Uint8Array | string) {
  return {
    raw: Buffer.byteLength(bytes),
    gzip: gzipSync(bytes, { level: 9 }).length,
    brotli: brotliCompressSync(bytes, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).length,
    sha256: hash(bytes),
  };
}
const server = createServer((req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  if (new URL(req.url!, "http://localhost").pathname === "/runner.js") {
    res.setHeader("Content-Type", "text/javascript");
    res.end(runner);
  } else {
    res.setHeader("Content-Type", "text/html");
    res.end("<!doctype html><title>MoonBit LSM experiment</title>");
  }
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const results = [];
let version = "";
const percentile = (numbers: number[], p: number) =>
  numbers.toSorted((a, b) => a - b)[
    Math.max(0, Math.ceil(numbers.length * p) - 1)
  ]!;
function summarize(samples: LsmSample[][]) {
  const all = samples.flat(),
    mean = (f: (s: LsmSample) => number) =>
      all.reduce((n, s) => n + f(s), 0) / all.length;
  return {
    meanUs: mean((s) => s.totalMs) * 1000,
    medianUs:
      percentile(
        all.map((s) => s.totalMs),
        0.5,
      ) * 1000,
    p99Us:
      percentile(
        all.map((s) => s.totalMs),
        0.99,
      ) * 1000,
    maxUs: Math.max(...all.map((s) => s.totalMs)) * 1000,
    medianRunUs:
      percentile(
        samples.map(
          (run) => run.reduce((n, s) => n + s.totalMs, 0) / run.length,
        ),
        0.5,
      ) * 1000,
    ioUs: mean((s) => s.ioMs) * 1000,
    meanWriteBytes: mean((s) => s.writeBytes),
    meanReadBytes: mean((s) => s.readBytes),
    meanWrites: mean((s) => s.writes),
    maintenanceCalls: all.filter((s) => s.publications > 1).length,
  };
}
try {
  const browser = await chromium.launch();
  version = browser.version();
  try {
    // Alternate order by fixture; fresh page/context per strategy. One machine,
    // one Chromium process; this is not a multi-browser performance claim.
    for (const [index, [rows, width]] of fixtures.entries())
      for (const strategy of (index % 2
        ? ["lsm", "journal"]
        : ["journal", "lsm"]) as Strategy[]) {
        console.log(`${rows}/${width}/${strategy}`);
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
          const baseline = await heap(),
            key = `${rows}-${width}`,
            oracle = expected.get(key)!;
          const start = performance.now();
          await page.evaluate(
            async ({ strategy, rows, width, name }) => {
              const r = await import(
                /* @vite-ignore */ `${location.origin}/runner.js`
              );
              await r.setup(strategy, rows, width, name);
            },
            {
              strategy,
              rows: rows!,
              width: width!,
              name: `bench-${key}-${strategy}-${Date.now().toString(36)}`,
            },
          );
          const setupMs = performance.now() - start;
          assert.equal(
            await page.evaluate(() => window.lsmBench.digest()),
            oracle.seeded,
            "native seeded typed rows",
          );
          const seededHeap = await heap(),
            seededStats = await page.evaluate(() => window.lsmBench.stats());
          const workloads = [];
          let warmHeap: Awaited<ReturnType<typeof heap>> | undefined;
          for (const kind of ["point", "batch", "get", "range"] as const) {
            const samples = await page.evaluate(
              ({ kind, runs, iterations }) =>
                window.lsmBench.measure(kind, runs, iterations),
              { kind, runs, iterations },
            );
            assert.equal(
              await page.evaluate(() => window.lsmBench.digest()),
              oracle.updated,
              `${key}/${strategy}/${kind}/native typed rows`,
            );
            const beforeReopen = await page.evaluate(() =>
              window.lsmBench.stats(),
            );
            if (kind === "range") warmHeap = await heap();
            const reopenMs = await page.evaluate(() =>
              window.lsmBench.reopen(),
            );
            const summary = summarize(samples);
            console.log(kind, JSON.stringify(summary));
            workloads.push({
              kind,
              samples,
              summary,
              beforeReopen,
              reopenMs,
              verifiedSHA256: oracle.updated,
            });
          }
          const retainedHeap = await heap(),
            retainedStats = await page.evaluate(() => window.lsmBench.stats());
          const drainMs = await page.evaluate(() => window.lsmBench.drain());
          assert.equal(
            await page.evaluate(() => window.lsmBench.digest()),
            oracle.updated,
            "drained/replayed native typed rows",
          );
          const drainedStats = await page.evaluate(() =>
              window.lsmBench.stats(),
            ),
            drainedHeap = await heap();
          const disk = await page.evaluate(() => window.lsmBench.disk());
          await page.evaluate(() => window.lsmBench.close());
          results.push({
            rows,
            payloadBytes: width,
            strategy,
            setupMs,
            seededStats,
            workloads,
            retainedStats,
            drainMs,
            drainedStats,
            disk,
            memory: {
              baseline,
              seeded: seededHeap,
              warm: warmHeap,
              retained: retainedHeap,
              drained: drainedHeap,
            },
            fixture: oracle,
          });
        } finally {
          await context.close();
        }
      }
  } finally {
    await browser.close();
  }
} finally {
  await new Promise<void>((done) => server.close(() => done()));
}
const report = {
  format: 1,
  measuredAt: new Date().toISOString(),
  smoke,
  environment: {
    node: process.version,
    chromium: version,
    cpu: cpus()[0]?.model,
    platform: platform(),
    arch: arch(),
    moon: execFileSync("moon", ["version"], { encoding: "utf8" }).split(
      "\n",
    )[0],
    sqlite: process.versions.sqlite,
  },
  method: {
    runs,
    iterations,
    warmup: 2,
    description:
      "Ordered int64 KV experiment, not SQL execution. Identical MoonBit release JS codec, binary full after-images, whole-memtable merge semantics and strict IndexedDB durable completion. Journal reference retains all rows; binary log plus whole base64 snapshot at existing ImageStore 128-record/4-MiB threshold. LSM: 64-KiB memtable/WAL limit or 128 WAL records, 16-KiB blocks, 256-KiB cache accounting encoded bytes, fanout-4 size-tiered streaming compaction. Point alternates one INTEGER field; batch overwrites 16 adjacent rows with +/-1 logical effect. Get/range vary keys across the whole dataset. Get samples average 16 sequential lookups to reduce clock quantization; get p99 is a group mean, not individual-call tail latency. Other samples measure one operation. COOP/COEP enables high-resolution clocks. All samples include automatic flush/compaction; final drain measured separately. Reopen before every next workload drops caches; open latency excludes first SST read. Native SQLite INTEGER/BLOB row hashes checked after seed, each workload, replay and drain. ASCII metadata and submitted binary bytes counted, constant root/CAS record bytes omitted. No physical filesystem byte claim.",
    memory:
      "Fresh Chromium page/context per layout, single process, alternating strategy order by dataset. CDP Runtime.getHeapUsage after forced GC. Baseline before fixture generation, seeded after seed/verification, warm after bounded range reads with populated cache, retained after reopen drops cache, drained after final flush. JS usedSize and backingStorageSize separate. Retention samples, not transient compaction peak, RSS or IndexedDB service memory. Cache budget counts encoded bytes and excludes JS object overhead. Sparse block manifest, pinned iterators, active output/input buffers are additional. No physical garbage collection: retired/orphan blocks are retained for snapshots and included in disk diagnostics.",
  },
  sizes: {
    standaloneJsWithIdb: size(standalone),
    moonbitJsFullApi: size(
      readFileSync("_build/js/release/build/mizchi/sqlike/lsm/lsm.js"),
    ),
    moonbitWasmFullApi: size(
      readFileSync("_build/wasm-gc/release/build/mizchi/sqlike/lsm/lsm.wasm"),
    ),
  },
  artifacts: {
    runnerSHA256: hash(runner),
    sourceSHA256: Object.fromEntries(
      [
        "scripts/bench-lsm.ts",
        "scripts/lsm-bench-workload.ts",
        "adapters/lsm-database.ts",
        "adapters/lsm-indexeddb.ts",
        "packages/sqlike/src/lsm/lsm.mbt",
      ].map((path) => [path, hash(readFileSync(path))]),
    ),
  },
  results,
};
writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(`Saved ${output}`);
