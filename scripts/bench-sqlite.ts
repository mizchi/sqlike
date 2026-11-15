import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { cpus, arch, platform, release } from "node:os";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { build } from "vite";
import { buildCatalog } from "./aot-compiler.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "../tests/compatibility/native-values.ts";
import { aotBindings } from "../src/aot-values.ts";
import type { Cell, Value } from "../src/contract.ts";
import type {
  ComparisonInput,
  ComparisonQuery,
} from "./sqlite-bench-workload.ts";
import { summarizeProfile } from "./profile-summary.ts";
import { sourceHashes } from "./measurement-manifest.ts";

const args = process.argv.slice(2);
for (const arg of args)
  if (
    !/^(--smoke|--output=.+|--rows=\d+(,\d+)*|--profiles=false|--profile-queries=[a-z,]+)$/.test(
      arg,
    )
  )
    throw Error(`unknown option ${arg}`);
const smoke = args.includes("--smoke"),
  profiles = !smoke && !args.includes("--profiles=false");
const output =
  args.find((a) => a.startsWith("--output="))?.slice(9) ??
  (smoke
    ? "/tmp/browser-litestream-sqlite-smoke.json"
    : "measurements/sqlite-speed-current.json");
const rowCounts = smoke
  ? [100]
  : (args.find((a) => a.startsWith("--rows="))?.slice(7) ?? "100,1000,5000")
      .split(",")
      .map(Number);
assert.ok(
  rowCounts.every((n) => n >= 100 && n <= 10000 && n % 100 === 0),
  "rows must be multiples of 100 in 100..10000",
);
const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const schema = [
  "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER,grp INTEGER,title TEXT)",
  "CREATE INDEX ix_t_n ON t(n)",
  "CREATE TABLE cold(id INTEGER PRIMARY KEY,n INTEGER,grp INTEGER,title TEXT)",
];
const bulk = (table: string) =>
  `INSERT INTO ${table} VALUES${Array(100).fill("(?,?,?,?)").join(",")}`;
const queries = [
  { name: "constant", sql: "SELECT ?+1 AS n,upper(?) AS t" },
  { name: "point", sql: "SELECT id,n,title FROM t WHERE id=?" },
  { name: "miss", sql: "SELECT id,n,title FROM t WHERE id=?" },
  {
    name: "range",
    sql: "SELECT id,n,title FROM t WHERE n>=? AND n<? ORDER BY n",
  },
  { name: "limit", sql: "SELECT id,n,title FROM t ORDER BY id LIMIT 10" },
  { name: "aggregate", sql: "SELECT sum(n),count(*) FROM t" },
  { name: "scan", sql: "SELECT id,n,title FROM t ORDER BY id" },
  { name: "update", sql: "UPDATE t SET n=? WHERE id=?" },
];
const profileQueries = args
  .find((a) => a.startsWith("--profile-queries="))
  ?.slice(18)
  .split(",") ?? ["point", "range", "limit", "scan", "update"];
for (const name of profileQueries)
  if (!queries.some((q) => q.name === name))
    throw Error(`unknown profile query: ${name}`);
const source = {
  schema,
  queries: [
    { name: "add", sql: bulk("t") },
    { name: "addCold", sql: bulk("cold") },
    ...queries,
  ],
};
const { artifact } = buildCatalog(source);
const files: Record<
  string,
  { data: Buffer | string; type: string; path?: string }
> = {};
for (const [name, path] of Object.entries({
  aotJS: "_build/js/release/build/mizchi/litestream-example/runtime/runtime.js",
  sqlJS: "_build/js/release/build/mizchi/sqlike/sqlike.js",
  aotWasm:
    "_build/wasm-gc/release/build/mizchi/litestream-example/runtime/runtime.wasm",
  sqlWasm: "_build/wasm-gc/release/build/mizchi/sqlike/sqlike.wasm",
  sqliteSDK: "node_modules/@sqlite.org/sqlite-wasm/dist/index.mjs",
  "sqlite3.wasm": "node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm",
}))
  files[name] = {
    path,
    data: readFileSync(path),
    type: path.endsWith(".wasm") ? "application/wasm" : "text/javascript",
  };
const built = await build({
  configFile: false,
  publicDir: false,
  logLevel: "silent",
  build: {
    write: false,
    minify: false,
    target: "esnext",
    lib: {
      entry: resolve("scripts/sqlite-bench-workload.ts"),
      formats: ["es"],
    },
  },
});
const bundle = Array.isArray(built) ? built[0] : built;
assert.ok(bundle && "output" in bundle);
const chunks = bundle.output.filter((c) => c.type === "chunk");
assert.equal(chunks.length, 1);
files["runner.js"] = { data: chunks[0]!.code, type: "text/javascript" };
const server = createServer((req, res) => {
  const name = new URL(req.url!, "http://localhost").pathname.slice(1),
    file = files[name];
  if (name === "") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<!doctype html><title>SQLite comparison</title>");
    return;
  }
  res.writeHead(file ? 200 : 404, {
    "Content-Type": file?.type ?? "text/plain",
    "Cache-Control": "no-store",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
  });
  res.end(file?.data ?? "missing");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
function inputFor(rows: number, coldRows: number): ComparisonInput {
  const native = new NodeDatabase(":memory:"),
    batches: ComparisonInput["batches"] = [];
  try {
    for (const sql of schema) native.run(sql);
    for (const [table, count, name] of [
      ["t", rows, "add"],
      ["cold", coldRows, "addCold"],
    ] as const)
      for (let start = 0; start < count; start += 100) {
        const values: Value[] = [];
        for (let i = start; i < start + 100; i++)
          values.push(BigInt(i + 1), BigInt(i * 3), BigInt(i % 8), `note${i}`);
        const sql = bulk(table),
          bindings = aotBindings(values);
        native.run(sql, values);
        batches.push({ name, sql, bindings });
      }
    const expected = (sql: string, values: Value[]) =>
      nativeValues(native, sql, values).map(
        (row) => JSON.parse(aotBindings(row)) as Cell[],
      );
    const selected = coldRows
      ? queries.filter((q) => ["point", "update"].includes(q.name))
      : queries;
    const workload: ComparisonQuery[] = selected.map((query) => {
      const id = Math.floor(rows / 2),
        params: Value[] =
          query.name === "constant"
            ? [2n, "hello"]
            : query.name === "point"
              ? [BigInt(id)]
              : query.name === "miss"
                ? [BigInt(rows + 1)]
                : query.name === "range"
                  ? [BigInt(id * 3), BigInt((id + 10) * 3)]
                  : query.name === "update"
                    ? [-7n, BigInt(id)]
                    : [];
      const iterations = smoke
        ? 5
        : query.name === "constant"
          ? 10000
          : query.name === "scan"
            ? Math.max(3, Math.floor(10000 / rows))
            : ["aggregate", "update"].includes(query.name)
              ? Math.max(10, Math.floor(50000 / rows))
              : Math.max(20, Math.floor(200000 / rows));
      return {
        ...query,
        bindings: aotBindings(params),
        expected: expected(query.sql, params),
        iterations,
        warmup: smoke ? 1 : Math.min(200, iterations),
        ...(query.name === "update"
          ? {
              write: true,
              check: {
                name: "point",
                sql: queries[1]!.sql,
                bindings: aotBindings([BigInt(id)]),
                expected: expected(queries[1]!.sql, [BigInt(id)]),
              },
            }
          : {}),
      };
    });
    return {
      artifact,
      schema,
      batches,
      rows,
      coldRows,
      queries: workload,
      runs: smoke ? 1 : 7,
    };
  } finally {
    native.close();
  }
}
const median = (values: number[]) =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!;
type Sample = {
  name: string;
  engine: string;
  run: number;
  iterations: number;
  milliseconds: number;
};
function medians(samples: Sample[]) {
  return [...new Set(samples.map((s) => `${s.name}/${s.engine}`))].map(
    (key) => {
      const selected = samples.filter((s) => `${s.name}/${s.engine}` === key),
        first = selected[0]!,
        times = selected.map((s) => s.milliseconds);
      return {
        name: first.name,
        engine: first.engine,
        iterations: first.iterations,
        microseconds: (median(times) * 1000) / first.iterations,
        minMs: Math.min(...times),
        maxMs: Math.max(...times),
      };
    },
  );
}
const profileRun = new Date().toISOString().replace(/[:.]/g, "-");
const results = [],
  cpuProfiles = [];
let chromiumVersion = "";
try {
  const browser = await chromium.launch();
  chromiumVersion = browser.version();
  try {
    for (const [rows, coldRows] of [
      ...rowCounts.map((n) => [n, 0] as const),
      ...(smoke ? [] : [[100, 5000] as const]),
    ]) {
      console.log(`Setup ${rows} rows + ${coldRows} unrelated rows`);
      const input = inputFor(rows, coldRows),
        page = await browser.newPage();
      try {
        await page.goto(origin);
        const info = await page.evaluate(
          async (input) =>
            (
              await import(/* @vite-ignore */ `${location.origin}/runner.js`)
            ).installComparison(input),
          input,
        );
        console.log(
          `Measure SQLite ${info.sqliteVersion}, JS/Wasm, prepared/dynamic (${rows}/${coldRows})`,
        );
        const measured = await page.evaluate(() =>
          window.sqliteBench.measure(),
        );
        const item = {
          rows,
          coldRows,
          sqliteVersion: info.sqliteVersion,
          plans: info.plans,
          workloadSHA256: hash(JSON.stringify(input)),
          queries: input.queries.map(({ expected, check, ...query }) => ({
            ...query,
            expectedRows: expected.length,
            expectedSHA256: hash(JSON.stringify(expected)),
            check,
          })),
          ...measured,
          medians: medians(measured.samples),
        };
        results.push(item);
        console.table(
          item.medians
            .filter((m) => !m.engine.endsWith("/dynamic"))
            .map((m) => ({
              query: m.name,
              engine: m.engine,
              us: m.microseconds.toFixed(2),
            })),
        );
        if (profiles && (rows === 1000 || coldRows)) {
          const session = await page.context().newCDPSession(page);
          await session.send("Profiler.enable");
          await session.send("Profiler.setSamplingInterval", {
            interval: 1000,
          });
          for (const name of coldRows ? ["update"] : profileQueries) {
            await session.send("Profiler.start");
            const calls = await page.evaluate(
              ({ name }) =>
                window.sqliteBench.profile(name, "sqlike-js/aot", 1000),
              { name },
            );
            const { profile } = await session.send("Profiler.stop");
            const path = `measurements/profiles/${profileRun}/sqlite-${rows}-cold${coldRows}-${name}-js-aot.cpuprofile`;
            mkdirSync(`measurements/profiles/${profileRun}`, {
              recursive: true,
            });
            writeFileSync(path, JSON.stringify(profile));
            cpuProfiles.push({
              rows,
              coldRows,
              name,
              engine: "sqlike-js/aot",
              path,
              ...calls,
              ...summarizeProfile(profile),
            });
          }
          await session.detach();
        }
        await page.evaluate(() => window.sqliteBench.close());
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
} finally {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
const report = {
  sourceHashes: sourceHashes([
    "scripts/bench-sqlite.ts",
    "scripts/sqlite-bench-workload.ts",
    "scripts/profile-summary.ts",
  ]),
  profileQueries,
  format: 1,
  measuredAt: new Date().toISOString(),
  smoke,
  environment: {
    node: process.version,
    cpu: cpus()[0]?.model,
    arch: arch(),
    platform: platform(),
    osRelease: release(),
    chromium: chromiumVersion,
    moon: execFileSync("moon", ["version"], { encoding: "utf8" }).split(
      "\n",
    )[0],
    nativeOracle: process.versions.sqlite,
  },
  method:
    "Same Chromium page per dataset, memory only, no storage/network/compilation in timed regions. Six paths: SQLike JS/Wasm GC AOT and dynamic; SQLite WASM cached prepared and prepare/finalize each call. Pre-encoded SQLike bindings and pre-decoded SQLite bindings; all results normalized to typed positional Cell arrays. SQLite type queries/BigInt and SQLike response JSON.parse included, not identical ABI. Native SQLite oracle and UPDATE side effects checked before/after timing. Rotated order, 7 samples, adaptive warmups by dataset and two calibration rounds targeting 50ms per engine/sample (actual iterations recorded). UPDATE repeatedly sets the same value after its first verified change. Main range timings are warm. firstRangeRead is one un-warmed API call, including first preparation/index build, not a median. Separate indexLifecycle probes run after main timings: each cycle changes an indexed n value between -7/-8 outside the requested positive range, then performs a range read; timings include both operations and any index maintenance. indexMovement repeats with -7/(rows*3+7), moving between both ends of the index while preserving the range result. Profiles collected separately after measurements, 1ms sampling, 1 second each; profile durations are not benchmark timings. No forced GC.",
  artifacts: Object.fromEntries(
    Object.entries(files).map(([name, file]) => [
      name,
      {
        path: file.path,
        bytes: Buffer.byteLength(file.data),
        sha256: hash(file.data),
      },
    ]),
  ),
  sourceSHA256: hash(JSON.stringify(source)),
  results,
  cpuProfiles,
};
writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(`Saved ${output}`);
