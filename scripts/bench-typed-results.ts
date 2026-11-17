import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { cpus } from "node:os";
import { chromium } from "@playwright/test";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "../tests/compatibility/native-values.ts";
import { aotBindings } from "../src/aot-values.ts";
import { engineSourcePaths, sourceHashes, fileHash } from "./measurement-manifest.ts";

const smoke = process.argv.includes("--smoke");
const files: Record<string, string> = {
  "/sql.js": "_build/js/release/build/mizchi/sqlike/sqlike.js",
  "/typed.js": "_build/js/release/build/mizchi/sqlike/experimental-typed/experimental-typed.js",
};
const server = createServer((req, res) => {
  const path = files[req.url!];
  res.setHeader("Content-Type", path ? "text/javascript" : "text/html");
  res.end(path ? readFileSync(path) : "<!doctype html><title>Native result ABI trial</title>");
});
await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch();
const results = [];
try {
  for (const rows of smoke ? [100] : [1000, 100000]) {
    const native = new NodeDatabase(":memory:");
    let image: string;
    const queries = [];
    try {
      native.run("CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER,title TEXT)");
      native.transaction(() => {
        const insert = native.raw.prepare("INSERT INTO t VALUES(?,?,?)");
        for (let i = 0; i < rows; i++) insert.run(i + 1, i * 3, `note${i}`);
      });
      image = Buffer.from(native.raw.serialize()).toString("base64");
      for (const [name, sql, params] of [
        ["point", "SELECT id,n,title FROM t WHERE id=?", [BigInt(Math.floor(rows / 2))]],
        ["scan", "SELECT id,n,title FROM t ORDER BY id", []],
      ] as const) queries.push({ name, sql, bindings: aotBindings([...params]),
        expected: JSON.stringify(nativeValues(native, sql, [...params]), (_, v) => typeof v === "bigint" ? { integer: String(v) } : v) });
    } finally { native.close(); }
    const page = await browser.newPage();
    try {
      // tsx annotates nested JS function names; keep that setup-only helper
      // available when Playwright serializes this self-contained callback.
      await page.addInitScript("globalThis.__name = value => value");
      await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
      const samples = await page.evaluate(async ({ image, queries, smoke }) => {
        const legacy = await import(location.origin + "/sql.js"), typed = await import(location.origin + "/typed.js");
        const ldb = legacy.database_open(), tdb = typed.open();
        const checked = (text: string) => { const r = JSON.parse(text); if (r.error) throw Error(r.error); return r; };
        checked(legacy.database_import_sqlite_base64(ldb, image));
        checked(typed.restore(tdb, legacy.database_dump(ldb)));
        const cell = (c: any): any => c.t === "integer" ? BigInt(c.v) : c.t === "null" ? null : c.t === "blob" ? Uint8Array.from(c.v) : c.v;
        const encode = (r: unknown) => JSON.stringify(r, (_, v) => typeof v === "bigint" ? { integer: String(v) } : v);
        const samples = [];
        for (const query of queries) {
          const lp = legacy.database_prepare(ldb, query.sql), tp = typed.prepare(tdb, query.sql);
          const drivers = [
            { name: "json-to-native-values", call: () => checked(legacy.database_prepared_exec(lp, query.bindings, true, true)).rows.map((row: any[]) => row.map(cell)) },
            { name: "native-values", call: () => typed.values(tp, query.bindings) },
          ];
          const loops = new Map<string, number>();
          for (const driver of drivers) {
            if (encode(driver.call()) !== query.expected) throw Error(`typed result mismatch: ${query.name}/${driver.name}`);
            driver.call();
            let n = query.name === "scan" ? 1 : 100;
            for (let round = 0; round < (smoke ? 0 : 2); round++) {
              const start = performance.now();
              for (let i = 0; i < n; i++) driver.call();
              n = Math.max(1, Math.min(query.name === "scan" ? 2 : 100000, Math.ceil(n * 20 / Math.max(0.1, performance.now() - start))));
            }
            loops.set(driver.name, n);
          }
          for (let run = 0; run < (smoke ? 1 : 3); run++) for (const driver of run % 2 ? [...drivers].reverse() : drivers) {
            const iterations = loops.get(driver.name)!;
            let count = 0;
            const start = performance.now();
            for (let i = 0; i < iterations; i++) count += driver.call().length;
            const milliseconds = performance.now() - start;
            if (count !== iterations * JSON.parse(query.expected).length) throw Error("result count");
            samples.push({ query: query.name, engine: driver.name, run, iterations, milliseconds });
          }
          for (const driver of drivers) if (encode(driver.call()) !== query.expected) throw Error("post-timing result mismatch");
        }
        return samples;
      }, { image, queries, smoke });
      assert.equal(samples.length, smoke ? 4 : 12);
      results.push({ rows, verified: true, samples });
      console.log(`native result ABI: ${rows} rows verified`);
    } finally { await page.close(); }
  }
  writeFileSync(smoke ? "/tmp/sqlike-typed-result-smoke.json" : "measurements/optimization-typed-results.json", JSON.stringify({
    measuredAt: new Date().toISOString(), smoke, cpu: cpus()[0]?.model, chromium: browser.version(),
    method: "Both JS paths return native Value[][] including BigInt, finite numeric and text fields. Legacy prepared JSON ABI includes JSON.parse plus per-cell native conversion. Experimental SELECT-only ABI keeps JSON bindings but returns primitives through public FFI; no internal enum layout crosses into JS. Setup excluded; same native SQLite image, pre/post exact typed native oracle, rotated order, three samples targeting 20ms, scan at most two iterations. Separate from Cell[][] legacy benchmark; no claim that the two ABI workloads are identical.",
    sourceHashes: sourceHashes([...engineSourcePaths(), "scripts/bench-typed-results.ts", "src/aot-values.ts"]),
    artifacts: Object.fromEntries(Object.values(files).map(path => [path, fileHash(path)])), results,
  }, null, 2) + "\n");
} finally { await browser.close(); await new Promise<void>(r => server.close(() => r())); }
