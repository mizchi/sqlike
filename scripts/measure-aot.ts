import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { sourceHashes } from "./measurement-manifest.ts";
import { createServer } from "node:http";
import { brotliCompressSync, gzipSync, constants } from "node:zlib";
import { createHash } from "node:crypto";
import { cpus, platform, arch } from "node:os";
import { chromium } from "@playwright/test";
import * as runtime from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import { MoonDatabase } from "../adapters/moon-database.ts";
import { buildCatalog } from "./aot-compiler.ts";
import { aotBindings } from "../src/aot-values.ts";

const runs = 3;
const bytes = (data: Buffer) => ({
  raw: data.length,
  gzip: gzipSync(data, { level: 9 }).length,
  brotli: brotliCompressSync(data, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }).length,
});
const assets = new Map<string, { data: Buffer; br: Buffer }>(),
  artifacts = [];
for (const file of await readdir("dist", {
  recursive: true,
  withFileTypes: true,
})) {
  if (!file.isFile() || /^(main\.es-|turso-)/.test(file.name)) continue;
  const path = `${file.parentPath}/${file.name}`.replace(/^dist/, "");
  const data = await readFile(`dist${path}`),
    br = brotliCompressSync(data, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    });
  assets.set(path, { data, br });
}
for (const [name, path] of [
  [
    "aot-runtime-js",
    "_build/js/release/build/mizchi/litestream-example/runtime/runtime.js",
  ],
  ["dynamic-sql-js", "_build/js/release/build/mizchi/sqlike/sqlike.js"],
  [
    "aot-runtime-wasm-gc",
    "_build/wasm-gc/release/build/mizchi/litestream-example/runtime/runtime.wasm",
  ],
  ["compiled-program", "examples/notes/program.generated.json"],
] as const) {
  const data = await readFile(path);
  artifacts.push({
    name,
    path,
    bytes: bytes(data),
    sha256: createHash("sha256").update(data).digest("hex"),
  });
}
const network: { path: string; raw: number; wire: number; status: number }[] =
  [];
const server = createServer((req, res) => {
  const path = new URL(req.url!, "http://localhost").pathname;
  const item = assets.get(
    path === "/"
      ? "/index.html"
      : path === "/lite/"
        ? "/lite/index.html"
        : path,
  );
  const compressed = String(req.headers["accept-encoding"]).includes("br");
  const data = item
    ? compressed
      ? item.br
      : item.data
    : Buffer.from("missing");
  network.push({
    path,
    raw: item?.data.length ?? data.length,
    wire: data.length,
    status: item ? 200 : 404,
  });
  res.writeHead(item ? 200 : 404, {
    "Content-Type": path.endsWith(".js")
      ? "text/javascript"
      : path.endsWith(".wasm")
        ? "application/wasm"
        : "text/html",
    ...(item && compressed ? { "Content-Encoding": "br" } : {}),
    "Cache-Control": "no-store",
    "Content-Length": String(data.length),
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
  });
  res.end(data);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
interface Sample {
  engine: string;
  run: number;
  coldReadyMs: number;
  wireBytes: number;
  decodedBytes: number;
  requests: typeof network;
  cache: { path: string; bytes: number }[];
  offlineReadyMs: number;
  durable100Ms?: number;
  read100Ms?: number;
  checkpointMs?: number;
}
const samples: Sample[] = [];
let browserVersion = "";
try {
  for (const engine of ["aot", "sqlike", "sqlite"] as const)
    for (let run = 0; run < runs; run++) {
      const browser = await chromium.launch();
      browserVersion = browser.version();
      try {
        const context = await browser.newContext(),
          page = await context.newPage(),
          start = network.length;
        await page.goto(
          `${origin}/${engine === "aot" ? "lite/" : ""}?engine=${engine}&client=measure${engine}${run}`,
        );
        await page.waitForFunction(
          (kind) =>
            kind === "aot" ? window.liteDemo?.ready : window.syncDemo?.ready,
          engine,
        );
        const readyMs = await page.evaluate(() => performance.now());
        await page.evaluate(() => navigator.serviceWorker.ready);
        await page.waitForFunction(() => !!navigator.serviceWorker.controller);
        const cold = network.slice(start);
        if (cold.some((r) => r.status !== 200))
          throw Error(`failed requests ${JSON.stringify(cold)}`);
        const cache = await page.evaluate(async () => {
          const files = [];
          for (const key of await caches.keys()) {
            const c = await caches.open(key);
            for (const req of await c.keys())
              files.push({
                path: new URL(req.url).pathname,
                bytes: (await (await c.match(req))!.arrayBuffer()).byteLength,
              });
          }
          return files;
        });
        let durable100Ms: number | undefined,
          read100Ms: number | undefined,
          checkpointMs: number | undefined;
        if (engine === "aot") {
          ({ durable100Ms, read100Ms, checkpointMs } = await page.evaluate(
            async () => {
              const start = performance.now();
              for (let i = 0; i < 100; i++)
                await window.liteDemo.execute("add", [
                  BigInt(i + 1),
                  `note${i}`,
                  BigInt(i),
                ]);
              const written = performance.now();
              for (let i = 0; i < 100; i++)
                await window.liteDemo.execute("get", [BigInt(i + 1)]);
              const read = performance.now();
              await window.liteDemo.checkpoint();
              return {
                durable100Ms: written - start,
                read100Ms: read - written,
                checkpointMs: performance.now() - read,
              };
            },
          ));
        }
        const reloadStart = network.length;
        await context.setOffline(true);
        await page.reload();
        await page.waitForFunction(
          (kind) =>
            kind === "aot" ? window.liteDemo?.ready : window.syncDemo?.ready,
          engine,
        );
        const offlineReadyMs = await page.evaluate(() => performance.now());
        if (
          engine === "aot" &&
          (await page.evaluate(() => window.liteDemo.state())).rows.length !==
            100
        )
          throw Error("offline saved rows lost");
        const unexpected = network.slice(reloadStart);
        if (unexpected.length) throw Error("offline reload used server");
        samples.push({
          engine,
          run,
          coldReadyMs: readyMs,
          wireBytes: cold.reduce((n, r) => n + r.wire, 0),
          decodedBytes: cold.reduce((n, r) => n + r.raw, 0),
          requests: cold,
          cache,
          offlineReadyMs,
          durable100Ms,
          read100Ms,
          checkpointMs,
        });
        console.log(
          `${engine} ${run + 1}/${runs}: ${samples.at(-1)!.wireBytes} bytes, ready ${readyMs.toFixed(1)}ms, offline ${offlineReadyMs.toFixed(1)}ms`,
        );
      } finally {
        await browser.close();
      }
    }
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const schema = "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER,title TEXT)";
const definitions = [
  { name: "add", sql: "INSERT INTO t VALUES(?,?,?)" },
  { name: "constant", sql: "SELECT ?+1 AS n,upper(?) AS t" },
  { name: "point", sql: "SELECT id,n,title FROM t WHERE id=?" },
];
const built = buildCatalog({ schema: [schema], queries: definitions }),
  db = runtime.aot_open(built.artifact, ""),
  dynamic = new MoonDatabase();
dynamic.run(schema);
for (let i = 0; i < 100; i++) {
  const params = [BigInt(i + 1), BigInt(i), `note${i}`];
  dynamic.run(definitions[0]!.sql, params);
  const r = JSON.parse(runtime.aot_execute(db, "add", aotBindings(params)));
  if (r.error) throw Error(r.error);
}
const cpu = [];
for (const [name, count, bindings] of [
  ["constant", 10000, [2n, "hello"]],
  ["point", 2000, [50n]],
] as const) {
  const sql = definitions.find((q) => q.name === name)!.sql,
    params = [...bindings],
    encoded = aotBindings(params);
  const actions = {
    aot: () => {
      const r = JSON.parse(runtime.aot_execute(db, name, encoded));
      if (r.error) throw Error(r.error);
      return r.rows;
    },
    dynamic: () => dynamic.queryValues(sql, params),
  };
  for (const action of Object.values(actions))
    for (let i = 0; i < 1000; i++) action();
  for (let run = 0; run < 5; run++)
    for (const engine of (run % 2
      ? ["dynamic", "aot"]
      : ["aot", "dynamic"]) as ("aot" | "dynamic")[]) {
      const start = performance.now();
      for (let i = 0; i < count; i++) actions[engine]();
      cpu.push({
        name,
        engine,
        run,
        iterations: count,
        milliseconds: performance.now() - start,
      });
    }
}
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const summary = ["aot", "sqlike", "sqlite"].map((engine) => {
  const selected = samples.filter((s) => s.engine === engine);
  return {
    engine,
    wireBytes: median(selected.map((s) => s.wireBytes)),
    coldReadyMs: median(selected.map((s) => s.coldReadyMs)),
    offlineReadyMs: median(selected.map((s) => s.offlineReadyMs)),
  };
});
const report = {
  sourceHashes: sourceHashes(["scripts/measure-aot.ts"]),
  format: 1,
  measuredAt: new Date().toISOString(),
  environment: {
    node: process.version,
    chromium: browserVersion,
    cpu: cpus()[0]?.model,
    platform: platform(),
    arch: arch(),
  },
  method: {
    runs,
    compression: "HTTP Brotli quality 11; gzip 9 for artifact sizes",
    browser:
      "Fresh Chromium process/profile per cold sample. Localhost, no throttling. Includes page, Service Worker precache, generated catalog/template, database Worker and DB initialization. Offline reload keeps IDB/cache. AOT includes SQLite writer and LTX reader/writer. Full engine demos also include synchronization UI/protocol; feature sets differ.",
    cpu: "Node JS backend; 100 rows, 1000 warm-up iterations, 5 measured runs in alternating order. Same bound SELECT SQL; AOT executes named AST and decodes result JSON, dynamic MoonDatabase reparses SQL and decodes positional result JSON. No IDB, Worker RPC or server sync in CPU comparison. Absolute engine times are not durable browser write latency.",
    durable:
      "AOT browser only: 100 sequential strict IDB write commits, 100 Worker point reads, one SQLite+LTX checkpoint; measured separately after cold startup.",
  },
  artifacts,
  samples,
  summary,
  cpu,
};
await mkdir("measurements", { recursive: true });
await writeFile(
  "measurements/aot-current.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(summary, null, 2));
