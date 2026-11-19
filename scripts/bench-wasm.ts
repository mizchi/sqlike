import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { arch, cpus, platform, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { chromium } from "@playwright/test";
import { build } from "vite";
import * as aot from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import * as dynamic from "../_build/js/release/build/mizchi/sqlike/full/full.js";
import { NodeDatabase } from "../adapters/node-database.ts";
import { aotBindings } from "../src/aot-values.ts";
import { applyLtx } from "../src/ltx.ts";
import { nativeValues } from "../tests/compatibility/native-values.ts";
import type { Value } from "../src/contract.ts";
import { buildCatalog } from "./aot-compiler.ts";
import {
  runSpeedBench,
  type BenchEngines,
  type SpeedInput,
  type SpeedSample,
} from "./wasm-bench-workload.ts";

const options = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    if (!/^--output=/.test(arg)) throw Error(`unknown option ${arg}`);
    return ["output", arg.slice("--output=".length)];
  }),
);
const paths = {
  aotJS: "_build/js/release/build/mizchi/litestream-example/runtime/runtime.js",
  sqlJS: "_build/js/release/build/mizchi/sqlike/full/full.js",
  aotWasm:
    "_build/wasm-gc/release/build/mizchi/litestream-example/runtime/runtime.wasm",
  sqlWasm: "_build/wasm-gc/release/build/mizchi/sqlike/full/full.wasm",
};
const hash = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
const files = Object.fromEntries(
  Object.entries(paths).map(([name, path]) => [name, readFileSync(path)]),
);
const source = {
  schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER,title TEXT)"],
  queries: [
    { name: "add", sql: "INSERT INTO t VALUES(?,?,?)" },
    { name: "constant", sql: "SELECT ?+1 AS n,upper(?) AS t" },
    { name: "point", sql: "SELECT id,n,title FROM t WHERE id=?" },
    { name: "scan", sql: "SELECT id,n,title FROM t ORDER BY id" },
    { name: "update", sql: "UPDATE t SET n=? WHERE id=?" },
  ],
};
const { artifact } = buildCatalog(source),
  native = new NodeDatabase(":memory:");
const directory = mkdtempSync(join(tmpdir(), "sqlike-wasm-bench-"));
let input: SpeedInput;
try {
  native.run(source.schema[0]!);
  const db = aot.aot_open(artifact, ""),
    seeds = [];
  for (let i = 0; i < 100; i++) {
    const params = [BigInt(i + 1), BigInt(i), `note${i}`];
    const bindings = aotBindings(params);
    seeds.push(bindings);
    native.run(source.queries[0]!.sql, params);
    assert.equal(
      JSON.parse(aot.aot_execute(db, "add", bindings)).error,
      undefined,
    );
  }
  const originalRows = nativeValues(native, source.queries[3]!.sql);
  const expected = (sql: string, params: Value[]) =>
    nativeValues(native, sql, params).map((row) =>
      JSON.parse(aotBindings(row)),
    );
  const queries = source.queries.slice(1).map((query) => {
    const params: Value[] =
      query.name === "constant"
        ? [2n, "hello"]
        : query.name === "point"
          ? [50n]
          : query.name === "update"
            ? [7n, 50n]
            : [];
    const rows = expected(query.sql, params); // Executes the update on the oracle.
    const write = query.name === "update";
    return {
      ...query,
      bindings: aotBindings(params),
      expected: rows,
      write,
      iterations:
        query.name === "constant" ? 10000 : query.name === "point" ? 2000 : 500,
      ...(write
        ? {
            check: {
              name: "point",
              sql: source.queries[2]!.sql,
              bindings: aotBindings([50n]),
              expected: expected(source.queries[2]!.sql, [50n]),
            },
          }
        : {}),
    };
  });
  const sqlite = aot.sqlite_data_base64(aot.aot_export_sqlite(db));
  const imagePath = join(directory, "export.sqlite");
  writeFileSync(imagePath, Buffer.from(sqlite, "base64"));
  const reopened = new NodeDatabase(imagePath, false, true);
  try {
    assert.deepEqual(nativeValues(reopened, "PRAGMA integrity_check"), [
      ["ok"],
    ]);
    assert.deepEqual(
      nativeValues(reopened, source.queries[3]!.sql),
      originalRows,
    );
  } finally {
    reopened.close();
  }
  const checkpoint = new NodeDatabase(":memory:");
  let ltxInput: string;
  try {
    checkpoint.run("CREATE TABLE payload(id INTEGER PRIMARY KEY,b BLOB)");
    let state = 123456789;
    for (let i = 0; i < 64; i++) {
      const bytes = new Uint8Array(2048);
      for (let j = 0; j < bytes.length; j++) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        bytes[j] = state & 255;
      }
      checkpoint.run("INSERT INTO payload VALUES(?,?)", [BigInt(i + 1), bytes]);
    }
    ltxInput = Buffer.from(checkpoint.raw.serialize()).toString("base64");
  } finally {
    checkpoint.close();
  }
  const encoded = aot.encode_ltx_base64("", ltxInput, "1", "1", "0");
  assert.equal(JSON.parse(aot.ltx_info(encoded)).error, undefined);
  const ltx = aot.ltx_data_base64(encoded);
  // Also check the regular byte API; applyLtx delegates to the MoonBit decoder.
  assert.deepEqual(
    applyLtx(
      new Uint8Array(),
      "0",
      new Uint8Array(Buffer.from(ltx, "base64")),
      3,
    ).data,
    new Uint8Array(Buffer.from(ltxInput, "base64")),
  );
  input = {
    schema: source.schema[0]!,
    artifact,
    insertSQL: source.queries[0]!.sql,
    seeds,
    queries,
    sqlite,
    ltxInput,
    ltx,
    warmup: 1000,
    runs: 7,
    checkpointIterations: 10,
    checkpointWarmup: 3,
  };
} finally {
  native.close();
  rmSync(directory, { recursive: true, force: true });
}

const instantiate = async (bytes: Uint8Array<ArrayBuffer>) => {
  const { instance, module } = await WebAssembly.instantiate(
    bytes,
    {},
    { builtins: ["js-string"], importedStringConstants: "_" },
  );
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  return instance.exports;
};
const engines: BenchEngines = {
  js: { aot, dynamic },
  wasm: {
    aot: (await instantiate(files.aotWasm!)) as unknown as typeof aot,
    dynamic: (await instantiate(files.sqlWasm!)) as unknown as typeof dynamic,
  },
};
console.log("Measuring Node 24 (SQL + SQLite export + LTX snapshot)...");
const nodeReport = runSpeedBench(engines, input);
const bundled = await build({
  configFile: false,
  publicDir: false,
  logLevel: "silent",
  build: {
    write: false,
    minify: false,
    target: "esnext",
    lib: { entry: resolve("scripts/wasm-bench-workload.ts"), formats: ["es"] },
  },
});
const bundle = Array.isArray(bundled) ? bundled[0] : bundled;
if (!bundle || !("output" in bundle))
  throw Error("unexpected benchmark build output");
const chunk = bundle.output.find((item) => item.type === "chunk")!;
const server = createServer((req, res) => {
  const name = new URL(req.url!, "http://localhost").pathname.slice(1);
  const data = name === "runner.js" ? chunk.code : files[name];
  if (name === "") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<!doctype html><title>SQLike Wasm benchmark</title>");
    return;
  }
  res.writeHead(data ? 200 : 404, {
    "Content-Type": name.endsWith("Wasm")
      ? "application/wasm"
      : "text/javascript",
    "Cache-Control": "no-store",
  });
  res.end(data ?? "missing");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
let browserReport: ReturnType<typeof runSpeedBench>, browserVersion: string;
try {
  const browser = await chromium.launch();
  try {
    browserVersion = browser.version();
    const page = await browser.newPage();
    await page.goto(origin);
    console.log(`Measuring Chromium ${browserVersion} (same workload)...`);
    browserReport = await page.evaluate(
      async (input) =>
        (
          await import(/* @vite-ignore */ `${location.origin}/runner.js`)
        ).runBrowserSpeedBench(input),
      input,
    );
  } finally {
    await browser.close();
  }
} finally {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

const summarize = (samples: SpeedSample[]) =>
  [...new Set(samples.map((s) => `${s.name}/${s.engine}`))].map((key) => {
    const selected = samples.filter((s) => `${s.name}/${s.engine}` === key),
      first = selected[0]!;
    const values = selected.map((s) => s.milliseconds).sort((a, b) => a - b);
    const milliseconds = values[Math.floor(values.length / 2)]!;
    return {
      name: first.name,
      engine: first.engine,
      iterations: first.iterations,
      milliseconds,
      microsecondsPerOperation: (milliseconds * 1000) / first.iterations,
      minMilliseconds: values[0],
      maxMilliseconds: values.at(-1),
    };
  });
const report = {
  format: 1,
  measuredAt: new Date().toISOString(),
  environment: {
    node: process.version,
    v8: process.versions.v8,
    cpu: cpus()[0]?.model,
    platform: platform(),
    osRelease: release(),
    arch: arch(),
    moon: execFileSync("moon", ["version"], { encoding: "utf8" }).split(
      "\n",
    )[0],
    chromium: browserVersion!,
    nativeSQLite: process.versions.sqlite,
  },
  artifacts: Object.fromEntries(
    Object.entries(paths).map(([name, path]) => [
      name,
      { path, sha256: hash(files[name]!), bytes: files[name]!.length },
    ]),
  ),
  method:
    "Release builds. Identical pre-encoded bindings and JSON result decoding for JS and Wasm GC public string ABI. In-memory only: no storage, RPC, network or module compilation in timed regions. SQL checked against native SQLite, UPDATE side effects checked, exported SQLite integrity/rows checked by native SQLite, LTX also checked via the MoonBit decoder byte API; JS/Wasm identical bytes and round trip required before/after timing. Rotate engine order, 7 samples after 1000 SQL warmups / 3 checkpoint warmups. Idempotent UPDATE; LTX full snapshot with base64 input/output for both engines. No forced GC; one Node process and one headless Chromium page.",
  workload: {
    schema: input.schema,
    rows: input.seeds.length,
    runs: input.runs,
    warmup: input.warmup,
    queries: input.queries,
    checkpointIterations: input.checkpointIterations,
    checkpointWarmup: input.checkpointWarmup,
    sqliteExportBytes: Buffer.from(input.sqlite, "base64").length,
    ltxInputBytes: Buffer.from(input.ltxInput, "base64").length,
    ltxOutputBytes: Buffer.from(input.ltx, "base64").length,
    sha256: hash(JSON.stringify(input)),
  },
  node: { ...nodeReport, medians: summarize(nodeReport.samples) },
  chromium: { ...browserReport!, medians: summarize(browserReport!.samples) },
};
writeFileSync(
  options.output ?? "measurements/wasm-speed-current.json",
  JSON.stringify(report, null, 2) + "\n",
);
for (const host of ["node", "chromium"] as const) {
  console.log(host);
  console.table(
    report[host].medians.map(({ name, engine, microsecondsPerOperation }) => ({
      name,
      engine,
      us: microsecondsPerOperation.toFixed(2),
    })),
  );
}
