import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { join, relative } from "node:path";
import { tmpdir, cpus, platform, arch } from "node:os";
import { createHash } from "node:crypto";
import { chromium } from "@playwright/test";
import { build } from "vite";
import { DatabaseSync } from "node:sqlite";
import { buildCatalog } from "./aot-compiler.ts";
import * as runtime from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import { aotBindings } from "../src/aot-values.ts";
import { applyLtx } from "../src/ltx.ts";
import { sampleHeapDuring } from "./heap-sampling.ts";
import {
  engineSourcePaths,
  sourceHashes,
  fileHash,
  assertFileHashes,
} from "./measurement-manifest.ts";
import type { Phase, Strategy, PagerIdbFixture } from "./idb-pager-workload.ts";
import type * as Workload from "./idb-pager-workload.ts";

const args = process.argv.slice(2);
for (const a of args)
  if (!/^(--smoke|--output=.+|--dataset=\d+-\d+|--window=64)$/.test(a))
    throw Error("unknown option " + a);
const smoke = args.includes("--smoke"),
  runs = smoke ? 1 : 3;
const windowUpdates = args.includes("--window=64") ? 64 : 0;
const strategies: Strategy[] = windowUpdates
  ? ["pager-chunks", "pager-differential"]
  : ["inline", "pager-json", "pager", "pager-chunks", "pager-differential"];
const selected = args.find((a) => a.startsWith("--dataset="))?.slice(10);
const output =
  args.find((a) => a.startsWith("--output="))?.slice(9) ??
  (windowUpdates
    ? `/tmp/sqlike-idb-pager-window-${windowUpdates}${selected ? `-${selected}` : ""}.json`
    : smoke
      ? "/tmp/sqlike-idb-pager-smoke.json"
      : selected
        ? `/tmp/sqlike-idb-pager-${selected}.json`
        : "measurements/sqlite-pager-idb-current.json");
const sha = (x: string | Uint8Array) =>
  createHash("sha256").update(x).digest("hex");
const fixtures = new Map<string, PagerIdbFixture>();
const catalogs = [];
for (const [count, payload] of smoke
  ? [[200, 32]]
  : [
      [5000, 32],
      [100000, 32],
      [5000, 4096],
    ]) {
  if (selected && `${count}-${payload}` !== selected) continue;
  const source = {
    schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER,s TEXT)"],
    queries: [
      {
        name: "seed",
        sql:
          "INSERT INTO t VALUES " +
          Array.from(
            { length: 100 },
            (_, i) => `(?${i + 1},100,'${"x".repeat(payload!)}')`,
          ).join(","),
      },
      { name: "update", sql: "UPDATE t SET n=?2 WHERE id=?1" },
      { name: "verify", sql: "SELECT count(*),sum(n),sum(length(s)) FROM t" },
    ],
  };
  const built = buildCatalog(source),
    db = runtime.aot_open(built.artifact, "");
  for (let start = 0; start < count!; start += 100) {
    const result = JSON.parse(
      runtime.aot_execute(
        db,
        "seed",
        aotBindings(
          Array.from({ length: 100 }, (_, i) => BigInt(start + i + 1)),
        ),
      ),
    );
    assert.equal(result.error, undefined);
  }
  const info = JSON.parse(runtime.aot_info(db)),
    image = runtime.aot_dump(db);
  assert.equal(JSON.parse(image).error, undefined);
  const saved = JSON.stringify({
    format: "moon-aot-store@1",
    programId: info.programId,
    image,
    head: "0",
    acked: "0",
    checkpointSerial: -1,
    base: "",
    baseHash: sha(new Uint8Array()),
    pending: [],
  });
  fixtures.set(`${count}-${payload}`, {
    artifact: built.artifact,
    hash: built.manifest.artifactSHA256,
    saved,
    count: count!,
    payload: payload!,
  });
  catalogs.push({
    count,
    payload,
    sourceSHA256: sha(JSON.stringify(source)),
    artifactSHA256: built.manifest.artifactSHA256,
    seedSHA256: sha(saved),
  });
}
assert.ok(fixtures.size, "no selected dataset");
const built = await build({
  configFile: false,
  publicDir: false,
  logLevel: "error",
  build: {
    write: false,
    target: "esnext",
    minify: "oxc",
    rolldownOptions: { output: { codeSplitting: false } },
    lib: { entry: "scripts/idb-pager-workload.ts", formats: ["es"] },
  },
});
const chunks = (Array.isArray(built) ? built : [built]).flatMap((r) =>
  "output" in r ? r.output.filter((c) => c.type === "chunk") : [],
);
assert.equal(chunks.length, 1);
const code = chunks[0]!.code;
mkdirSync("generated/idb-pager-bench", { recursive: true });
writeFileSync("generated/idb-pager-bench/runtime.js", code);
const artifacts = {
  "generated/idb-pager-bench/runtime.js": fileHash(
    "generated/idb-pager-bench/runtime.js",
  ),
  "_build/js/release/build/mizchi/litestream-example/runtime/runtime.js":
    fileHash(
      "_build/js/release/build/mizchi/litestream-example/runtime/runtime.js",
    ),
};
const sources = sourceHashes([
  ...engineSourcePaths(),
  ...chunks
    .flatMap((c) => Object.keys(c.modules))
    .filter(
      (p) =>
        p.startsWith(process.cwd() + "/") &&
        !p.includes("/node_modules/") &&
        !p.includes("/_build/"),
    )
    .map((p) => relative(process.cwd(), p)),
  "scripts/bench-idb-pager.ts",
  "scripts/aot-compiler.ts",
  "scripts/heap-sampling.ts",
  "src/ltx.ts",
]);
const server = createServer((req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  const url = new URL(req.url!, "http://localhost");
  if (url.pathname === "/runtime.js") {
    res.setHeader("Content-Type", "text/javascript");
    res.end(code);
  } else if (url.pathname.startsWith("/fixture/")) {
    const fixture = fixtures.get(url.pathname.slice(9));
    res.writeHead(fixture ? 200 : 404, { "Content-Type": "application/json" });
    res.end(fixture ? JSON.stringify(fixture) : "missing");
  } else {
    res.setHeader("Content-Type", "text/html");
    res.end("<!doctype html><title>SQLike IndexedDB pager benchmark</title>");
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`,
  tmp = mkdtempSync(join(tmpdir(), "sqlike-idb-pager-"));
const results = [];
let version = "";
const median = (xs: number[]) =>
  xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)]!;
try {
  const browser = await chromium.launch();
  version = browser.version();
  try {
    for (const [key, fixture] of fixtures)
      for (const strategy of strategies) {
        console.log("measuring", key, strategy);
        const context = await browser.newContext({ serviceWorkers: "block" }),
          page = await context.newPage();
        page.setDefaultTimeout(60000);
        try {
          await page.goto(origin);
          const cdp = await context.newCDPSession(page);
          const heap = () => cdp.send("Runtime.getHeapUsage");
          const gc = async () => {
            await cdp.send("HeapProfiler.collectGarbage");
            return heap();
          };
          await page.evaluate(async () => {
            await import(/* @vite-ignore */ `${location.origin}/runtime.js`);
          });
          const baseline = await gc();
          const setupStarted = performance.now();
          await page.evaluate(
            ({ key, strategy }) =>
              (
                import(
                  /* @vite-ignore */ `${location.origin}/runtime.js`
                ) as Promise<typeof Workload>
              ).then((m) =>
                m.setup(
                  `/fixture/${key}`,
                  strategy,
                  "bench-" + key + "-" + strategy,
                ),
              ),
            { key, strategy },
          );
          const setupMs = performance.now() - setupStarted;
          const retained = await gc();
          const phases = [];
          for (const phase of ["natural", "snapshot"] as Phase[]) {
            const preparationMs: number[] = [];
            const prepare = async () => {
              if (phase !== "snapshot" || !windowUpdates) return;
              const started = performance.now();
              await page.evaluate(
                (n) =>
                  (
                    import(
                      /* @vite-ignore */ `${location.origin}/runtime.js`
                    ) as Promise<typeof Workload>
                  ).then((m) => m.prepare(n)),
                windowUpdates,
              );
              preparationMs.push(performance.now() - started);
            };
            const samples = [];
            for (let i = 0; i < runs; i++) {
              await prepare();
              await gc();
              samples.push(
                await page.evaluate(
                  (phase) =>
                    (
                      import(
                        /* @vite-ignore */ `${location.origin}/runtime.js`
                      ) as Promise<typeof Workload>
                    ).then((m) => m.step(phase)),
                  phase,
                ),
              );
            }
            // I/O accounting and CDP sampling are separate operations, never timing samples.
            await prepare();
            await gc();
            const io = await page.evaluate(
              (phase) =>
                (
                  import(
                    /* @vite-ignore */ `${location.origin}/runtime.js`
                  ) as Promise<typeof Workload>
                ).then((m) => m.io(phase)),
              phase,
            );
            await prepare();
            const before = await gc();
            const observed = await sampleHeapDuring(
              () =>
                page.evaluate(
                  (phase) =>
                    (
                      import(
                        /* @vite-ignore */ `${location.origin}/runtime.js`
                      ) as Promise<typeof Workload>
                    ).then((m) => m.step(phase)),
                  phase,
                ),
              heap,
            );
            const after = await gc();
            const memory = {
              before,
              after,
              samples: observed.samples,
              peak: observed.peak,
              operation: observed.value,
            };
            phases.push({
              phase,
              preparationMs,
              samples,
              medianMs: median(samples.map((x) => x.totalMs)),
              medianWriteMs: median(samples.map((x) => x.writeMs)),
              medianCheckpointMs: median(samples.map((x) => x.checkpointMs)),
              io,
              memory,
            });
          }
          const checked = await page.evaluate(() =>
            (
              import(
                /* @vite-ignore */ `${location.origin}/runtime.js`
              ) as Promise<typeof Workload>
            ).then((m) => m.verify()),
          );
          let image: Uint8Array = new Uint8Array(),
            head = "0";
          for (const f of checked.files) {
            image = applyLtx(
              image,
              head,
              Buffer.from(f.data, "base64"),
              3,
            ).data;
            head = f.maxTXID;
          }
          assert.deepEqual(
            Buffer.from(image),
            Buffer.from(checked.sqlite, "base64"),
            "durable LTX must reconstruct the current SQLite image",
          );
          const file = join(tmp, "check.sqlite");
          writeFileSync(file, image);
          const native = new DatabaseSync(file);
          let values: unknown[];
          try {
            assert.equal(
              native.prepare("PRAGMA integrity_check").get()!.integrity_check,
              "ok",
            );
            const changes = new Map(checked.mutations.map((x) => [x.id, x.n]));
            const expectedSum =
              fixture.count * 100 +
              [...changes.values()].reduce((n, x) => n + x - 100, 0);
            values = Object.values(
              native
                .prepare("SELECT count(*),sum(n),sum(length(s)) FROM t")
                .get()!,
            );
            assert.deepEqual(values, [
              fixture.count,
              expectedSum,
              fixture.count * fixture.payload,
            ]);
            assert.deepEqual(checked.logical, [values.map(String)]);
          } finally {
            native.close();
          }
          const one = {
            count: fixture.count,
            payload: fixture.payload,
            strategy,
            setupMs,
            phases,
            memory: { baseline, retained },
            verified: {
              head,
              files: checked.files.length,
              sqliteSHA256: sha(image),
              sqliteBytes: image.length,
              typedAggregate: checked.logical,
              reopened: true,
              outboxPruned: true,
            },
          };
          results.push(one);
          console.log(
            strategy,
            phases.map((p) => ({
              phase: p.phase,
              ms: p.medianMs.toFixed(2),
              bytes: p.io!.statistics.writes.total,
            })),
          );
        } finally {
          await context.close();
        }
      }
  } finally {
    await browser.close();
  }
} finally {
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
  rmSync(tmp, { recursive: true, force: true });
}
const paired = new Map<string, string>();
assert.equal(results.length, fixtures.size * strategies.length);
for (const row of results) {
  const key = `${row.count}-${row.payload}`;
  const previous = paired.get(key);
  if (previous)
    assert.equal(
      row.verified.sqliteSHA256,
      previous,
      "paired strategies must produce identical SQLite bytes",
    );
  else paired.set(key, row.verified.sqliteSHA256);
}
assertFileHashes(sources);
assertFileHashes(artifacts);
const report = {
  format: "sqlike-idb-pager-bench@1",
  measuredAt: new Date().toISOString(),
  smoke,
  runs,
  strategies,
  selection: selected ?? null,
  workload: {
    pageSize: 4096,
    seedBatch: 100,
    payload: "unchanged repeated ASCII x",
    warmups: 2,
    windowUpdates,
    preparation: windowUpdates
      ? "Before every snapshot probe, mock ACK/prune pending files (retaining copies for the LTX oracle), reset the baseline and execute/checkpoint 63 unmeasured mutations; the timed 64th mutation forces one compaction of the resulting 127 journal records. Preparation is excluded and recorded separately."
      : null,
  },
  pairedSQLiteImagesMatch: true,
  environment: {
    node: process.version,
    chromium: version,
    cpu: cpus()[0]?.model,
    platform: platform(),
    arch: arch(),
  },
  scope:
    "Real Chromium strict IndexedDB: existing inline checkpoint, incremental pager with legacy JSON CRC catalog (provider CRC capability disabled), incremental pager with binary per-page CRC records, and the same pager with binary logical snapshot chunks. A fifth strategy reuses immutable logical parts. All selected strategies share the same minified bundle/engine/catalog/seed. Times include one SQL UPDATE, logical publication and checkpoint completion. One natural and one forced snapshot warmup; three timing samples by default; GC outside timers. Natural thresholds unchanged (128 records/4 MiB); snapshot phase forces one logical snapshot before UPDATE. Separate I/O and memory probes. Value submissions estimated as UTF8 JSON with binary fields null plus binary view byte lengths and put/get key JSON. Not physical disk I/O, IDB encoding or service/process memory. CDP sampled peaks may miss synchronous transients. Setup/bootstrap, verification, reopen, ACK/GC and network excluded from operation times and submission counters; setupMs is recorded separately.",
  catalogs,
  results,
  artifacts,
  sources,
};
writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log("wrote", output);
