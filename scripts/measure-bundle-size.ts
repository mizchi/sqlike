import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, join } from "node:path";
import { chromium } from "@playwright/test";
import { measureBrowserBundle, bundleSizeTable, replaceBundleSizeTable } from "./bundle-size.ts";
import { buildSqlikeRuntime } from "./build-sqlike-runtime.ts";
import { buildDefinedCatalog } from "./defined-compiler.ts";
import { defineSqlike, allSqlikeFeatures, primaryKeyIndex } from "../src/sqlike-features.ts";
import { sourceHashes, engineSourcePaths, assertFileHashes } from "./measurement-manifest.ts";

const reportPath = "measurements/bundle-size-current.json";
const readmes = [["README.md", "en"], ["README.ja.md", "ja"]] as const;
const args = process.argv.slice(2);
if (args.length) {
  assert.deepEqual(args, ["--check"]);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assertFileHashes(report.sourceHashes);
  for (const [path, language] of readmes) {
    const readme = await readFile(path, "utf8");
    assert.equal(readme, replaceBundleSizeTable(readme, bundleSizeTable(report.results, language)), `${path} sizes are stale`);
  }
  console.log("English/Japanese README bundle sizes match the verified measurement");
  process.exit(0);
}

const directory = resolve("generated/bundle-size");
await mkdir(directory, { recursive: true });
const version = JSON.parse(await readFile("npm/sqlike/package.json", "utf8")).version;
const sqlite = JSON.parse(await readFile("node_modules/@sqlite.org/sqlite-wasm/package.json", "utf8"));
const turso = JSON.parse(await readFile("node_modules/@tursodatabase/database-wasm/package.json", "utf8"));
const entries: { id: string; name: string; entry: string; kind: "sql" | "defined" | "sqlite" | "turso"; wasm: boolean }[] = [];
const execution = allSqlikeFeatures.filter((f) => !["binarySync", "sqlitePages", "ltx"].includes(f.name));
const profiles = [
  { id: "all", label: "全実行機能", features: execution },
  { id: "without-three", label: "JSON・日時・windowなし", features: execution.filter((f) => !["sqlJson", "dateTime", "windowFunctions"].includes(f.name)) },
  { id: "primary-key", label: "主キー索引のみ", features: [primaryKeyIndex] },
];
const wasmLoad = `const {instance}=await WebAssembly.instantiateStreaming(fetch(new URL('./runtime.wasm',import.meta.url)),{},{builtins:['js-string'],importedStringConstants:'_'});`;
const definedHost = JSON.stringify(resolve("adapters/defined-database-core.ts"));
const wasmHost = JSON.stringify(resolve("adapters/defined-wasm.ts"));
const sqlHost = JSON.stringify(resolve("src/sqlike-runtime.ts"));
entries.push({ id: "sql-js", name: `SQLike ${version} / 通常SQL / JS`, entry: resolve("npm/sqlike/index.ts"), kind: "sql", wasm: false });
const sqlWasmDir = join(directory, "sql-wasm");
await mkdir(sqlWasmDir, { recursive: true });
await copyFile("_build/wasm-gc/release/build/mizchi/sqlike/sqlike.wasm", join(sqlWasmDir, "runtime.wasm"));
await writeFile(join(sqlWasmDir, "entry.ts"), `import {openSql,type SqlRuntime} from ${sqlHost};\n${wasmLoad}\nexport const openDatabase=(image?:string)=>openSql(instance.exports as unknown as SqlRuntime,image);\n`);
entries.push({ id: "sql-wasm", name: `SQLike ${version} / 通常SQL / Wasm GC`, entry: join(sqlWasmDir, "entry.ts"), kind: "sql", wasm: true });
for (const profile of profiles) {
  const profileDir = join(directory, profile.id);
  await buildSqlikeRuntime(defineSqlike({ mode: "defined", features: profile.features }), { outDir: profileDir });
  for (const wasm of [false, true]) {
    const entry = join(profileDir, wasm ? "wasm-entry.ts" : "js-entry.ts");
    const runtime = wasm ? `import {definedWasm} from ${wasmHost};\n${wasmLoad}\nconst runtime=definedWasm(instance.exports);` : `import * as runtime from './runtime.js';`;
    await writeFile(entry, `import {createDefinedDatabase} from ${definedHost};\nexport {DefinedStatement} from ${definedHost};\n${runtime}\nexport const DefinedDatabase=createDefinedDatabase(runtime);\n`);
    entries.push({ id: `defined-${profile.id}-${wasm ? "wasm" : "js"}`, name: `SQLike ${version} / 事前定義・${profile.label} / ${wasm ? "Wasm GC" : "JS"}`, entry: profile.id === "all" && !wasm ? resolve("npm/sqlike/defined.ts") : entry, kind: "defined", wasm });
  }
}
entries.push(
  { id: "sqlite", name: `sqlite-wasm ${sqlite.version}`, entry: resolve("node_modules/@sqlite.org/sqlite-wasm", sqlite.exports["."].import), kind: "sqlite", wasm: true },
  { id: "turso", name: `Turso ${turso.version}`, entry: resolve("node_modules/@tursodatabase/database-wasm", turso.exports["."].default), kind: "turso", wasm: true },
);

const files = new Map<string, Buffer>();
const results = [];
for (const row of entries) {
  const { files: emitted, ...measured } = await measureBrowserBundle(row.entry);
  if (row.kind === "defined") assert.deepEqual([...measured.exports].sort(), ["DefinedDatabase", "DefinedStatement"]);
  assert.equal(measured.assets.some((a) => a.file.endsWith(".wasm")), row.wasm, `${row.id}: Wasm must be included exactly when required`);
  for (const [file, bytes] of emitted) files.set(`/${row.id}/${file}`, bytes);
  results.push({ id: row.id, name: row.name, kind: row.kind, entrySource: row.entry.replace(resolve(".") + "/", ""), ...measured });
  console.log(row.id, measured.totals);
}

// Execute the exact minified entry/assets counted above, with no dev server transforms.
const catalog = buildDefinedCatalog({
  schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT NOT NULL)"],
  queries: [
    { name: "add", sql: "INSERT INTO t VALUES(?,?) RETURNING id,v" },
    { name: "get", sql: "SELECT id,v FROM t ORDER BY id" },
  ],
});
const encoded = { schema: [...catalog.schema], statements: [...catalog.statements], manifest: catalog.manifest };
const requests: { path: string; status: number }[] = [];
const server = createServer((req, res) => {
  const path = new URL(req.url!, "http://localhost").pathname;
  const bytes = path === "/" ? Buffer.from("<!doctype html><title>Bundle verification</title>") : files.get(path);
  requests.push({ path, status: bytes ? 200 : 404 });
  res.writeHead(bytes ? 200 : 404, {
    "Content-Type": path.endsWith(".wasm") ? "application/wasm" : path.endsWith(".js") ? "text/javascript" : "text/html",
    "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp",
    "Cache-Control": "no-store",
  });
  res.end(bytes ?? "unmeasured asset");
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert.ok(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch();
let browserVersion = "";
try {
  browserVersion = browser.version();
  for (const row of results) {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    try {
      await page.goto(origin);
      const actual = await page.evaluate(async ({ url, kind, catalog }) => {
        const module = await import(/* @vite-ignore */ url);
        if (kind === "defined") {
          const db = await module.DefinedDatabase.memory({ ...catalog, schema: new Uint8Array(catalog.schema), statements: new Uint8Array(catalog.statements) });
          await db.execute("add", [1n, "verified"]);
          const rows = (await db.prepare("get").all()).map((r: unknown[]) => r.map((v) => typeof v === "bigint" ? String(v) : v));
          await db.close();
          return rows;
        }
        if (kind === "sqlite") {
          const sqlite = await module.default();
          const db = new sqlite.oo1.DB(":memory:");
          try {
            db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT NOT NULL);INSERT INTO t VALUES(1,'verified');");
            const rows = db.exec("SELECT id,v FROM t", { rowMode: "array", returnValue: "resultRows" });
            return rows.map((r: unknown[]) => [String(r[0]), r[1]]);
          } finally { db.close(); }
        }
        if (kind === "turso") {
          const db = await module.connect(":memory:");
          try {
            await db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT NOT NULL)");
            await db.prepare("INSERT INTO t VALUES(?,?)").run(1, "verified");
            return (await db.prepare("SELECT id,v FROM t").all()).map((r: { id: unknown; v: string }) => [String(r.id), r.v]);
          } finally { await db.close(); }
        }
        const db = module.openDatabase();
        try {
          db.run("CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT NOT NULL)");
          db.values("INSERT INTO t VALUES(?,?) RETURNING id,v", [1n, "verified"]);
          return db.values("SELECT id,v FROM t").map((r: unknown[]) => r.map((v) => typeof v === "bigint" ? String(v) : v));
        } finally { db.close(); }
      }, { url: `${origin}/${row.id}/${row.entry}`, kind: row.kind, catalog: encoded });
      assert.deepEqual(actual, [["1", "verified"]], row.id);
      assert.deepEqual(errors, [], row.id);
      console.log(`${row.id}: measured browser bundle passed`);
    } finally { await page.close(); }
  }
  assert.deepEqual(requests.filter((r) => r.status !== 200 && r.path !== "/favicon.ico"), [], "runtime fetched an unmeasured asset");
} finally {
  await browser.close();
  await new Promise<void>((done, fail) => server.close((error) => error ? fail(error) : done()));
}

const report = {
  format: 1, measuredAt: new Date().toISOString(), node: process.version, browser: browserVersion,
  method: "Browser ESM public entry exports retained; Vite/Oxc minification, esnext, ES workers, legal/purity comments retained, assetsInlineLimit=0. Every emitted JS chunk, Worker and Wasm asset counted once, including optional emitted workers. Brotli quality 11 applied per asset with decompression round trip. Wasm is compiler/package release output, without additional wasm-opt. Excludes app code/HTML, precompiled schema/statements, build-time compiler, optional SQLite exporter, Litestream and source maps. Not feature-equivalent engines or a minimal startup-download measurement.",
  versions: { sqlike: version, sqlite: sqlite.version, turso: turso.version },
  sourceHashes: sourceHashes([
    ...engineSourcePaths(), "scripts/bundle-size.ts", "scripts/measure-bundle-size.ts", "scripts/build-sqlike-runtime.ts", "scripts/oxc-runtime.ts", "scripts/sqlike-runtime-declarations.ts", "scripts/defined-compiler.ts", "scripts/aot-compiler.ts",
    "src/sqlike-features.ts", "src/sqlike-runtime.ts", "src/aot-values.ts", "src/defined-contract.ts", "src/defined-database-contract.ts", "src/persistence-contract.ts",
    "adapters/defined-database-core.ts", "adapters/defined-database.ts", "adapters/defined-wasm.ts", "adapters/moon-image-store.ts", "npm/sqlike/index.ts", "npm/sqlike/defined.ts", "npm/sqlike/package.json",
    "_build/js/release/build/mizchi/sqlike/sqlike.js", "_build/js/release/build/mizchi/sqlike/defined/defined.js", "_build/wasm-gc/release/build/mizchi/sqlike/sqlike.wasm",
    ...profiles.flatMap((p) => [join(directory, p.id, "runtime.js"), join(directory, p.id, "runtime.wasm")].map((path) => path.replace(resolve(".") + "/", ""))),
    "node_modules/@sqlite.org/sqlite-wasm/package.json", "node_modules/@sqlite.org/sqlite-wasm/dist/index.mjs", "node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm",
    "node_modules/@tursodatabase/database-wasm/package.json", "node_modules/@tursodatabase/database-wasm/dist/promise-default.js", "node_modules/@tursodatabase/database-wasm/dist/index-default.js", "node_modules/@tursodatabase/database-wasm/dist/turso.wasm32-wasi.wasm",
  ]),
  results, browserSmoke: "passed", measuredAssetsOnly: true,
};
await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
for (const [path, language] of readmes)
  await writeFile(path, replaceBundleSizeTable(await readFile(path, "utf8"), bundleSizeTable(results, language)));
console.log(bundleSizeTable(results));
