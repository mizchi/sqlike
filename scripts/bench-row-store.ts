import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir, cpus } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";
import type { RowOperation } from "./row-store-workload.ts";
import { createHash } from "node:crypto";
import { chromium } from "@playwright/test";
import * as runtime from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import { buildCatalog } from "./aot-compiler.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "../tests/compatibility/native-values.ts";
import { aotBindings } from "../src/aot-values.ts";
import { sampleHeapDuring } from "./heap-sampling.ts";
import { sourceHashes } from "./measurement-manifest.ts";
import type { Value } from "../src/contract.ts";

const args = process.argv.slice(2);
for (const arg of args)
  if (!/^--(before-js|before-wasm|output)=.+$/.test(arg)) throw Error(`unknown option ${arg}`);
const option = (key: string) => args.find(a => a.startsWith(`--${key}=`))?.slice(key.length + 3);
assert.equal(!!option("before-js"), !!option("before-wasm"));
const output = option("output") ?? "measurements/row-store-current.json";
const hash = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const check = (text: string) => { const v = JSON.parse(text); if (v.error) throw Error(v.error); return v; };
const schema = [
  "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER,body TEXT)",
  "CREATE TABLE cold(id INTEGER PRIMARY KEY,n INTEGER,body TEXT)",
];
const bulk = (table: string) => `INSERT INTO ${table} VALUES${Array(100).fill("(?,?,?)").join(",")}`;
const queries = [
  { name: "seed", sql: bulk("t") }, { name: "coldSeed", sql: bulk("cold") },
  { name: "point", sql: "SELECT id,n,body FROM t WHERE id=?" },
  { name: "scan", sql: "SELECT id,n,body FROM t ORDER BY id" },
  { name: "cold", sql: "SELECT id,n,body FROM cold ORDER BY id" },
  { name: "update", sql: "UPDATE t SET n=? WHERE id=?" },
  { name: "delete", sql: "DELETE FROM t WHERE id=?" },
];
const { artifact } = buildCatalog({ schema, queries });
const artifacts = [
  { engine: "after/js", path: "_build/js/release/build/mizchi/litestream-example/runtime/runtime.js" },
  { engine: "after/wasm", path: "_build/wasm-gc/release/build/mizchi/litestream-example/runtime/runtime.wasm" },
  ...(option("before-js") ? [
    { engine: "before/js", path: option("before-js")! },
    { engine: "before/wasm", path: option("before-wasm")! },
  ] : []),
].map(a => ({ ...a, data: readFileSync(a.path) }));
const fixtures = [];
const cells = (db: NodeDatabase, sql: string) => nativeValues(db, sql).map(row => JSON.parse(aotBindings(row)));
for (const [rows, coldRows] of [[100, 0], [1000, 0], [5000, 0], [100, 5000]]) {
  const db = new NodeDatabase(":memory:"), handle = runtime.aot_open(artifact, "");
  try {
    for (const sql of schema) db.run(sql);
    for (const [table, count, query] of [["t", rows!, "seed"], ["cold", coldRows!, "coldSeed"]] as const)
      for (let start = 0; start < count; start += 100) {
        const values: Value[] = [];
        for (let i = start; i < start + 100; i++) values.push(BigInt(i + 1), BigInt(i * 4), "x".repeat(64));
        db.run(bulk(table), values);
        check(runtime.aot_execute(handle, query, aotBindings(values)));
      }
    const id = BigInt(Math.floor(rows! / 2)), value = 9000000n;
    const image = runtime.aot_dump(handle);
    const before = cells(db, queries[3]!.sql), cold = cells(db, queries[4]!.sql);
    db.run(queries[5]!.sql, [value, id]);
    const update = cells(db, queries[3]!.sql);
    db.run(queries[6]!.sql, [id]);
    const erase = cells(db, queries[3]!.sql);
    fixtures.push({ rows: rows!, coldRows: coldRows!, artifact, image,
      bindings: { point: aotBindings([id]), update: aotBindings([value, id]), delete: aotBindings([id]) },
      expected: { before: hash(JSON.stringify(before)), update: hash(JSON.stringify(update)), delete: hash(JSON.stringify(erase)), cold: hash(JSON.stringify(cold)) },
    });
  } finally { db.close(); }
}
const built = await build({ configFile: false, publicDir: false, logLevel: "silent", build: {
  write: false, minify: false, target: "esnext", lib: { entry: resolve("scripts/row-store-workload.ts"), formats: ["es"] },
} });
const bundle = Array.isArray(built) ? built[0] : built;
assert.ok(bundle && "output" in bundle);
const chunks = bundle.output.filter(c => c.type === "chunk");
assert.equal(chunks.length, 1);
const runner = chunks[0]!.code;
const kinds = ["clone", "update", "delete"] as const;
const server = createServer((req, res) => {
  const index = Number(new URL(req.url!, "http://localhost").pathname.slice(1));
  const file = artifacts[index];
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  if (req.url === "/runner.js") { res.setHeader("Content-Type", "text/javascript"); res.end(runner); return; }
  if (req.url === "/") { res.setHeader("Content-Type", "text/html"); res.end("<!doctype html>"); }
  else if (file) { res.setHeader("Content-Type", file.engine.endsWith("wasm") ? "application/wasm" : "text/javascript"); res.end(file.data); }
  else { res.statusCode = 404; res.end(); }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch();
const results = [], tmp = mkdtempSync(join(tmpdir(), "row-store-"));
try {
  for (const fixture of fixtures)
    for (const [index, a] of artifacts.entries()) {
      const context = await browser.newContext(), page = await context.newPage();
      try {
        await page.goto(origin);
        await page.evaluate(async input => {
          const path = "/runner.js";
          await (await import(path)).setup(input);
        }, { fixture, index, wasm: a.engine.endsWith("wasm") });
        const verify = async () => {
          const images = await page.evaluate(() => window.rowStore.verify()) as string[];
          for (const [i, image] of images.entries()) {
            const path = join(tmp, "candidate.sqlite"); writeFileSync(path, Buffer.from(image, "base64"));
            const native = new NodeDatabase(path);
            try {
              assert.equal(native.raw.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
              assert.equal(hash(JSON.stringify(cells(native, queries[3]!.sql))), i === 0 ? fixture.expected.before : i === 1 ? fixture.expected.update : fixture.expected.delete);
              assert.equal(hash(JSON.stringify(cells(native, queries[4]!.sql))), fixture.expected.cold);
            } finally { native.close(); }
          }
        };
        await verify();
        const samples: { kind: RowOperation; run: number; iterations: number; milliseconds: number }[] = [];
        const iterations: Record<RowOperation, number> = { clone: 0, update: 0, delete: 0 };
        for (const kind of kinds) {
          await page.evaluate(k => window.rowStore.run(k, 200), kind);
          let count = 100;
          for (let round = 0; round < 2; round++) {
            const ms = await page.evaluate(({ kind, count }) => window.rowStore.run(kind, count), { kind, count }) as number;
            count = Math.max(1, Math.min(50000, Math.ceil(count * 20 / Math.max(ms, 0.01))));
          }
          iterations[kind] = count;
        }
        for (let run = 0; run < 7; run++)
          for (const offset of [0, 1, 2]) {
            const kind = kinds[(run + offset) % 3]!, count = iterations[kind]!;
            samples.push({ kind, run, iterations: count, milliseconds: await page.evaluate(({ kind, count }) => window.rowStore.run(kind, count), { kind, count }) as number });
          }
        await verify();
        await page.evaluate(() => window.rowStore.clear());
        const cdp = await context.newCDPSession(page);
        const heap = () => cdp.send("Runtime.getHeapUsage");
        await cdp.send("HeapProfiler.collectGarbage");
        const baseline = await heap();
        const { value: _, ...observedPeak } = await sampleHeapDuring(() => page.evaluate(() => window.rowStore.hold(32)), heap);
        await cdp.send("HeapProfiler.collectGarbage");
        const retained = await heap();
        await page.evaluate(() => window.rowStore.verifyHeld());
        const summary = kinds.map(kind => {
          const times = samples.filter(s => s.kind === kind).map(s => s.milliseconds * 1000 / s.iterations).toSorted((a, b) => a - b);
          return { kind, medianUs: times[3], minUs: times[0], maxUs: times[6] };
        });
        results.push({ rows: fixture.rows, coldRows: fixture.coldRows, engine: a.engine, samples, summary,
          memory: { versions: 32, baseline, retained, observedPeak }, verified: true });
        console.log(fixture.rows, fixture.coldRows, a.engine, summary);
      } finally { await context.close(); }
    }
} finally {
  await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(tmp, { recursive: true });
}
writeFileSync(output, JSON.stringify({
  format: 1, measuredAt: new Date().toISOString(),
  sourceHashes: sourceHashes(["scripts/bench-row-store.ts", "scripts/row-store-workload.ts", "scripts/heap-sampling.ts", "scripts/aot-compiler.ts", "tests/compatibility/native-values.ts", "src/aot-values.ts"]),
  environment: { node: process.version, chromium: browser.version(), cpu: cpus()[0]?.model, nativeSQLite: process.versions.sqlite },
  method: "Fresh Chromium context per engine/dataset. Warm base PK index, then clone or clone+one actual UPDATE/DELETE; discard candidates except the last. No storage/RPC. Two calibration rounds target 20ms, 7 samples, operation order rotated. Native typed row hashes and SQLite integrity/rows verified before and after timing; base isolation verified. Separate untimed workload retains 32 updated clones and yields between operations. GC before baseline/retained; 2ms heap samples include garbage and are not a true peak/RSS. Memory baseline already contains the warmed base and module. Mutation always starts from the same base; no repeated no-op UPDATE or empty DELETE.",
  artifacts: artifacts.map(({ data, ...a }) => ({ ...a, sha256: hash(data) })),
  programSHA256: hash(artifact), runnerSHA256: hash(runner), results,
}, null, 2) + "\n");
console.log(`Saved ${output}`);
