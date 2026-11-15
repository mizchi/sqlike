import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { brotliCompressSync, constants } from "node:zlib";
import { chromium } from "@playwright/test";
import { build } from "vite";
import { buildCatalog } from "./aot-compiler.ts";
import { releaseSchema } from "../tests/compatibility/release-scenarios.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "../tests/compatibility/native-values.ts";
import { aotBindings } from "../src/aot-values.ts";
import { sampleHeapDuring } from "./heap-sampling.ts";
import { sourceHashes } from "./measurement-manifest.ts";
const queries = [
  { name: "tenant", sql: "INSERT INTO tenants(tenant) VALUES('a')" },
  {
    name: "add",
    sql: "INSERT INTO tasks(id,tenant,title,score,payload) VALUES(?,'a',?,?,?)",
  },
  { name: "rename", sql: "UPDATE tasks SET title=? WHERE id=?" },
  {
    name: "get",
    sql: "SELECT id,title,typeof(score),score,hex(payload) FROM tasks WHERE id=?",
  },
  { name: "audit", sql: "SELECT count(*) FROM audit" },
  { name: "totals", sql: "SELECT tenant,total FROM tenants ORDER BY tenant" },
];
const built = await build({
  configFile: false,
  publicDir: false,
  logLevel: "error",
  build: {
    write: false,
    minify: true,
    target: "esnext",
    lib: { entry: "scripts/release-app-workload.ts", formats: ["es"] },
  },
});
const b = Array.isArray(built) ? built[0] : built;
assert.ok(b && "output" in b);
const chunks = b.output.filter((c) => c.type === "chunk");
assert.equal(chunks.length, 1);
const html = "<!doctype html><title>Release application benchmark</title>",
  runner = chunks[0]!.code;
const hash = (s: string | Uint8Array) =>
  createHash("sha256").update(s).digest("hex");
const fixtures = ["plain", "indexed-trigger"].map((profile) => {
  const schema =
    profile === "plain"
      ? releaseSchema.filter(
          (s) => !/^CREATE (?:UNIQUE )?INDEX|^CREATE TRIGGER/i.test(s),
        )
      : releaseSchema;
  const c = buildCatalog({ schema, queries });
  return {
    profile,
    schema,
    body: JSON.stringify({
      artifact: c.artifact,
      hash: c.manifest.artifactSHA256,
    }),
    programSHA256: c.manifest.artifactSHA256,
  };
});
const files = new Map<string, { raw: Buffer; br: Buffer }>();
for (const [path, body] of [
  ["/", html],
  ["/runner.js", runner],
  ...fixtures.map((f) => ["/" + f.profile + ".json", f.body]),
]) {
  const raw = Buffer.from(body!);
  files.set(path!, {
    raw,
    br: brotliCompressSync(raw, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }),
  });
}
const requests: { path: string; bytes: number }[] = [];
const server = createServer((req, res) => {
  const path = new URL(req.url!, "http://localhost").pathname,
    f = files.get(path);
  if (!f) {
    res.writeHead(404);
    res.end();
    return;
  }
  const br = String(req.headers["accept-encoding"]).includes("br");
  requests.push({ path, bytes: (br ? f.br : f.raw).length });
  res.writeHead(200, {
    "Content-Type": path.endsWith(".js")
      ? "text/javascript"
      : path.endsWith(".json")
        ? "application/json"
        : "text/html",
    ...(br ? { "Content-Encoding": "br" } : {}),
    "Cache-Control": "no-store",
  });
  res.end(br ? f.br : f.raw);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const samples = [];
let version = "";
try {
  for (const f of fixtures)
    for (let run = 0; run < 3; run++) {
      const browser = await chromium.launch();
      version = browser.version();
      try {
        const page = await browser.newPage();
        const start = requests.length;
        await page.goto(origin);
        await page.evaluate(async () => {
          await import(/* @vite-ignore */ `${location.origin}/runner.js`);
        });
        const cdp = await page.context().newCDPSession(page);
        const heap = async () => {
          await cdp.send("HeapProfiler.collectGarbage");
          return cdp.send("Runtime.getHeapUsage");
        };
        const baseline = await heap();
        const setup = performance.now();
        await page.evaluate(async (profile) => {
          const m = await import(
            /* @vite-ignore */ `${location.origin}/runner.js`
          );
          await m.setup(
            "/" + profile + ".json",
            `release-${profile}-${Date.now()}`,
          );
        }, f.profile);
        const setupMs = performance.now() - setup,
          wireBytes = requests.slice(start).reduce((n, r) => n + r.bytes, 0);
        let timing: unknown, memory: unknown;
        if (run === 0) {
          await page.evaluate(() => window.releaseApp.read(1, 20));
          await page.evaluate(() => window.releaseApp.write(1, 2));
          const read = await page.evaluate(() => window.releaseApp.read()),
            write = await page.evaluate(() => window.releaseApp.write());
          const retained = await heap();
          const { value: _, ...observedPeak } = await sampleHeapDuring(
            () => page.evaluate(() => window.releaseApp.write(1, 64)),
            () => cdp.send("Runtime.getHeapUsage"),
          );
          const after = await heap();
          timing = { read, write };
          memory = { baseline, retained, observedPeak, after };
        }
        const verified = await page.evaluate(() => window.releaseApp.verify());
        const n = new NodeDatabase(":memory:");
        try {
          for (const s of f.schema) n.run(s);
          n.run(queries[0]!.sql);
          for (let i = 1; i <= 100; i++)
            n.run(queries[1]!.sql, [
              BigInt(i),
              `row${i}`,
              1,
              new Uint8Array(64).fill(i & 255),
            ]);
          for (let i = 0; i < verified.writes; i++)
            n.run(queries[2]!.sql, [`changed-${i % 2}`, 1n]);
          const expected = [
            nativeValues(n, queries[3]!.sql, [1n]),
            nativeValues(n, queries[4]!.sql),
            nativeValues(n, queries[5]!.sql),
          ].map((rows) => rows.map((r) => JSON.parse(aotBindings(r))));
          assert.deepEqual(verified.rows, expected, f.profile);
        } finally {
          n.close();
        }
        await page.evaluate(() => window.releaseApp.close());
        samples.push({
          profile: f.profile,
          run,
          setupMs,
          wireBytes,
          timing,
          memory,
          writes: verified.writes,
        });
        console.log(f.profile, run, wireBytes, timing);
      } finally {
        await browser.close();
      }
    }
} finally {
  await new Promise<void>((r) => server.close(() => r()));
}
const sources = [
  "scripts/bench-release-app.ts",
  "scripts/release-app-workload.ts",
  "scripts/heap-sampling.ts",
  "tests/compatibility/release-scenarios.ts",
  "_build/js/release/build/mizchi/litestream-example/runtime/runtime.js",
];
writeFileSync(
  "measurements/release-app-current.json",
  JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      sourceHashes: sourceHashes([
        "scripts/bench-release-app.ts",
        "scripts/release-app-workload.ts",
        "scripts/heap-sampling.ts",
        "tests/compatibility/release-scenarios.ts",
        "adapters/aot-database.ts",
        "adapters/moon-image-store.ts",
        "src/aot-values.ts",
      ]),
      node: process.version,
      chromium: version,
      method:
        "Paired measurement application: same 100 rows, 64-byte BLOB payload, STRICT/FK schema and named AOT queries; plain omits secondary/partial unique indexes and all triggers, indexed-trigger includes feed/expression indexes and audit/counter triggers. Both retain the PK index. Browser main-thread AotDatabase plus real strict IndexedDB; no Worker RPC or server sync. Three fresh browser cold loads per profile; actual Brotli HTTP body bytes include HTML, runtime/IDB adapter and Program JSON. First sample separately times 7x200 point reads and 7x50 durable title updates after warmup. Audit rows grow on updates only with triggers; their costs are part of that workload. Separate 64-update sampled peak (no forced GC); retained/after are forced-GC heap, backing storage separate, not exact transient peak or RSS. Native typed output and replay checked in each sample. Timing is ms/operation.",
      sources: Object.fromEntries(
        sources.map((p) => [p, hash(readFileSync(p))]),
      ),
      programs: fixtures.map((f) => ({
        profile: f.profile,
        programSHA256: f.programSHA256,
      })),
      assets: [...files].map(([path, f]) => ({
        path,
        raw: f.raw.length,
        brotli: f.br.length,
        sha256: hash(f.raw),
      })),
      samples,
    },
    null,
    2,
  ) + "\n",
);
