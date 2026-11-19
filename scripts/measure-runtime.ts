import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import { createHash } from "node:crypto";
import { cpus, platform, arch, totalmem } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { MemoryDebugger } from "./runtime-cdp.ts";
import { sourceHashes } from "./measurement-manifest.ts";
import { wasmSections } from "./runtime-metrics.ts";
import { RPC_HEADER } from "../src/database-rpc.ts";
import { MAX_RESPONSE } from "../src/http.ts";
import { browserEngines } from "../src/browser-engine.ts";

const options = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    if (!/^--(runs|output|memory)=/.test(arg))
      throw new Error(`unknown argument ${arg}`);
    return arg.slice(2).split(/=(.*)/s).slice(0, 2);
  }),
);
const runs = Number(options.runs ?? 3);
if (!Number.isInteger(runs) || runs < 1 || runs > 20)
  throw new Error("runs must be 1..20");
const output = options.output ?? "measurements/runtime-current.json";
const execute = promisify(execFile);
const distFiles = (
  await readdir("dist", { recursive: true, withFileTypes: true })
)
  .filter((file) => file.isFile())
  .map((file) => `${file.parentPath}/${file.name}`.replace(/^dist/, ""));
const served = new Map<string, { data: Buffer; br: Buffer; gzip: Buffer }>();
const size = (data: Buffer) => ({
  raw: data.length,
  gzip: gzipSync(data, { level: 9 }).length,
  brotli: brotliCompressSync(data, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }).length,
});
const assets = [];
for (const path of distFiles) {
  const data = await readFile(`dist${path}`);
  const br = brotliCompressSync(data, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  });
  const gzip = gzipSync(data, { level: 9 });
  served.set(path, { data, br, gzip });
  assets.push({
    path,
    bytes: { raw: data.length, gzip: gzip.length, brotli: br.length },
    sha256: createHash("sha256").update(data).digest("hex"),
  });
}
const engineArtifacts = [];
for (const [name, path] of [
  ["sqlite-wasm", "node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm"],
  [
    "turso-wasm",
    "node_modules/@tursodatabase/database-wasm/dist/turso.wasm32-wasi.wasm",
  ],
  [
    "moonbit-js-core",
    "_build/js/release/build/mizchi/litestream/litestream.js",
  ],
  ["moonbit-js-sql", "_build/js/release/build/mizchi/sqlike/full/full.js"],
  [
    "moonbit-wasm-gc-sql",
    "_build/wasm-gc/release/build/mizchi/sqlike/full/full.wasm",
  ],
  [
    "moonbit-wasm-gc-core",
    "_build/wasm-gc/release/build/mizchi/litestream/litestream.wasm",
  ],
]) {
  const data = await readFile(path!);
  engineArtifacts.push({
    name,
    path,
    sha256: createHash("sha256").update(data).digest("hex"),
    bytes: size(data),
    ...(path!.endsWith(".wasm") ? { sections: wasmSections(data) } : {}),
  });
}
interface RequestRecord {
  path: string;
  rawBytes: number;
  wireBytes: number;
  encoding: string;
  status: number;
}
const requests: RequestRecord[] = [];
const server = createServer((req, res) => {
  const path = new URL(req.url!, "http://localhost").pathname;
  const asset = served.get(path === "/" ? "/index.html" : path);
  const encoding = String(req.headers["accept-encoding"] ?? "").includes("br")
    ? "br"
    : "identity";
  const data = asset
    ? encoding === "br"
      ? asset.br
      : asset.data
    : Buffer.from("not found");
  requests.push({
    path,
    rawBytes: asset?.data.length ?? data.length,
    wireBytes: data.length,
    encoding: asset ? encoding : "identity",
    status: asset ? 200 : 404,
  });
  const headers: Record<string, string> = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cache-Control": "no-store",
    "Content-Length": String(data.length),
  };
  headers["Content-Type"] = path.endsWith(".wasm")
    ? "application/wasm"
    : path.endsWith(".js")
      ? "text/javascript"
      : path.endsWith(".json")
        ? "application/json"
        : "text/html";
  if (asset && encoding === "br") headers["Content-Encoding"] = "br";
  res.writeHead(asset ? 200 : 404, headers);
  res.end(data);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string")
  throw new Error("missing server address");
const origin = `http://127.0.0.1:${address.port}`;
const summarize = (records: RequestRecord[]) => ({
  requests: records,
  wireBytes: records.reduce((n, r) => n + r.wireBytes, 0),
  decodedBytes: records.reduce((n, r) => n + r.rawBytes, 0),
});
async function ready(page: Page) {
  await page.waitForFunction(
    () =>
      window.syncDemo?.ready || document.querySelector("#error")?.textContent,
    undefined,
    { timeout: 30000 },
  );
  const error = await page.locator("#error").textContent();
  if (error) throw new Error(error);
  return page.evaluate(() => performance.now());
}
async function offlineReady(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  return page.evaluate(async () => {
    let bytes = 0;
    const files = [];
    for (const key of await caches.keys())
      for (const request of await (await caches.open(key)).keys()) {
        const response = await (await caches.open(key)).match(request);
        const size = (await response!.arrayBuffer()).byteLength;
        bytes += size;
        files.push({ path: new URL(request.url).pathname, bytes: size });
      }
    return { milliseconds: performance.now(), bytes, files };
  });
}
async function rss(debugger_: MemoryDebugger) {
  if (!["darwin", "linux"].includes(platform())) return null;
  const { processInfo } = await debugger_.send<{
    processInfo: { id: number; type: string }[];
  }>("SystemInfo.getProcessInfo");
  const ids = processInfo
    .map((p) => p.id)
    .filter((id) => Number.isInteger(id) && id > 0);
  const result = await execute("ps", [
    "-p",
    ids.join(","),
    "-o",
    "pid=,rss=,vsz=",
  ]);
  const processes = result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [pid, resident, virtual] = line.trim().split(/\s+/).map(Number);
      return {
        pid,
        type: processInfo.find((p) => p.id === pid)?.type,
        rssBytes: resident! * 1024,
        virtualBytes: virtual! * 1024,
      };
    });
  return { bytes: processes.reduce((n, p) => n + p.rssBytes, 0), processes };
}
const samples = [];
const memory = [];
let sqliteCompileOptions: string[] = [];
let browserVersion = "";
try {
  for (const engine of browserEngines) {
    for (let run = 0; run < runs; run++) {
      const browser = await chromium.launch({ headless: true });
      browserVersion = browser.version();
      try {
        const context = await browser.newContext();
        const page = await context.newPage();
        const start = requests.length;
        await page.goto(
          `${origin}/?engine=${engine}&client=size-${engine}-${run}`,
        );
        const readyMs = await ready(page);
        const readyNetwork = summarize(requests.slice(start));
        const cache = await offlineReady(page);
        const offlineNetwork = summarize(requests.slice(start));
        for (const request of readyNetwork.requests.filter(
          (r) => r.path.startsWith("/assets/") && r.status === 200,
        )) {
          if (
            !cache.files.some(
              (file) => file.path === request.path.split("?")[0],
            )
          )
            throw new Error(
              `required engine asset was not cached: ${request.path}`,
            );
        }
        const warmStart = requests.length;
        await page.reload();
        const warmReadyMs = await ready(page);
        await offlineReady(page);
        const warmNetwork = summarize(requests.slice(warmStart));
        await context.setOffline(true);
        await page.reload();
        const offlineReadyMs = await ready(page);
        const result = await page.evaluate(() =>
          window.syncDemo.query("SELECT 1 AS n"),
        );
        if (
          JSON.stringify(result) !==
          JSON.stringify([{ n: { t: "integer", v: "1" } }])
        )
          throw new Error("offline query failed");
        if (engine === "sqlite" && run === 0)
          sqliteCompileOptions = await page.evaluate(async () => {
            const rows = (await window.syncDemo.query(
              "SELECT compile_options FROM pragma_compile_options",
            )) as { compile_options: { t: "text"; v: string } }[];
            return rows.map((row) => row.compile_options.v);
          });
        samples.push({
          engine,
          run,
          coldReadyMs: readyMs,
          offlineCapableMs: cache.milliseconds,
          readyNetwork,
          offlineNetwork,
          cache,
          warmReadyMs,
          warmNetwork,
          offlineReadyMs,
        });
        console.log(
          `${engine} ${run + 1}/${runs}: ready=${readyMs.toFixed(1)}ms offline=${cache.milliseconds.toFixed(1)}ms transfer=${offlineNetwork.wireBytes}B`,
        );
      } finally {
        await browser.close();
      }
    }
    if (options.memory !== "false") {
      // Separate processes: debugger hooks and forced GC do not affect timing runs.
      const reserve = createServer();
      await new Promise<void>((resolve) =>
        reserve.listen(0, "127.0.0.1", resolve),
      );
      const port = (reserve.address() as { port: number }).port;
      await new Promise<void>((resolve) => reserve.close(() => resolve()));
      const browser: Browser = await chromium.launch({
        headless: true,
        args: [`--remote-debugging-port=${port}`],
      });
      let debugger_: MemoryDebugger | undefined;
      try {
        const version = (await (
          await fetch(`http://127.0.0.1:${port}/json/version`)
        ).json()) as { webSocketDebuggerUrl: string };
        debugger_ = await MemoryDebugger.connect(version.webSocketDebuggerUrl);
        const context = await browser.newContext();
        const page = await context.newPage();
        const baseline = await rss(debugger_);
        await page.goto(`${origin}/?engine=${engine}&client=memory-${engine}`);
        await ready(page);
        await offlineReady(page);
        const snapshot = await debugger_.snapshot();
        const resident = await rss(debugger_);
        memory.push({
          engine,
          ...snapshot,
          configuredBridgeBytes:
            engine === "turso"
              ? MAX_RESPONSE + RPC_HEADER
              : engine === "sqlike"
                ? 4096
                : 0,
          resident,
          baseline,
          rssDeltaBytes:
            resident && baseline ? resident.bytes - baseline.bytes : null,
        });
        console.log(
          `${engine}: linear=${snapshot.linearBytes}B heap=${snapshot.jsHeapUsedBytes}B`,
        );
      } finally {
        debugger_?.close();
        await browser.close();
      }
    }
  }
  const report = {
    sourceHashes: sourceHashes([
      "scripts/measure-runtime.ts",
      "scripts/runtime-cdp.ts",
      "scripts/runtime-metrics.ts",
    ]),
    format: 1,
    measuredAt: new Date().toISOString(),
    environment: {
      node: process.version,
      chromium: browserVersion,
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      systemMemoryBytes: totalmem(),
      packages: {
        sqlite: JSON.parse(
          await readFile(
            "node_modules/@sqlite.org/sqlite-wasm/package.json",
            "utf8",
          ),
        ).version,
        turso: JSON.parse(
          await readFile(
            "node_modules/@tursodatabase/database-wasm/package.json",
            "utf8",
          ),
        ).version,
      },
    },
    method: {
      compression:
        "gzip level 9 / Brotli quality 11; HTTP server serves Brotli",
      timing:
        "fresh Chromium process and empty OPFS per cold sample; warm/offline reload keep same profile; localhost; no CPU/network throttling; includes DB/outbox initialization, no server sync",
      memory:
        "separate instrumented process; recursive CDP attach for page and DB Workers; WebAssembly.Memory constructor WeakRefs; forced GC; shared Wasm imports not recounted; configuredBridgeBytes is source configuration, not a heap measurement; JS heap excludes Service Worker; RSS is summed browser processes and includes shared/allocator overhead; capacities are not RSS",
      memorySamplesPerEngine: 1,
      runs,
    },
    assets,
    engineArtifacts,
    sqliteCompileOptions,
    samples,
    memory,
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(`wrote ${output}`);
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
