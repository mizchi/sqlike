import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { posix } from "node:path";
import { createServer } from "vite";
import { chromium } from "@playwright/test";
import { pathToFileURL } from "node:url";
import { parseLogicTest, differentialLogicTest } from "./compatibility/sqllogictest.ts";
import { nativeValues } from "./compatibility/native-values.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { verifyPublishedArchive } from "../scripts/npm-publication.ts";

test("packed npm packages work without this workspace and keep optional entries separate", async () => {
  const audit = JSON.parse(await readFile("generated/npm/audit.json", "utf8"));
  const fromRegistry = process.env.SQLIKE_NPM_REGISTRY === "1";
  assert.equal(audit.version, JSON.parse(await readFile("package.json", "utf8")).version);
  assert.equal(audit.packages.length, 2);
  for (const item of audit.packages) {
    assert.ok(item.files.every((file: string) => !/node_modules|\.mbt$|\.ts$|lsm|\/fts\//.test(file.replace(/\.d\.ts$/, ".declaration"))));
    assert.ok(item.files.includes("LICENSE"));
  }
  const modules = (name: string, entry: string): string[] => {
    const chunks = audit.packages.find((p: { name: string }) => p.name === name).chunks;
    const seen = new Set<string>();
    const walk = (file: string): string[] => {
      if (seen.has(file) || !chunks[file]) return [];
      seen.add(file);
      const chunk = chunks[file];
      return [...chunk.modules, ...[...chunk.imports, ...chunk.dynamicImports].flatMap((id: string) => walk(chunks[id] ? id : posix.normalize(posix.join(posix.dirname(file), id))))];
    };
    return walk(entry);
  };
  assert.ok(modules("@mizchi/sqlike", "index.js").every((m) => !m.includes("litestream/") && !m.includes("compiler/")));
  assert.ok(modules("@mizchi/sqlike", "defined.js").every((m) => !m.includes("compiler/") && !m.includes("sqlike/sqlike.js")));
  for (const entry of ["runtime.js", "features.js", "defined-core.js"])
    assert.ok(modules("@mizchi/sqlike", entry).every((m) => !m.includes("_build/")), entry);
  assert.ok(modules("@mizchi/litestream", "index.js").every((m) => !m.includes("mizchi/sqlike/")));
  const dir = await mkdtemp(join(tmpdir(), "sqlike-npm-consumer-"));
  try {
    await writeFile(join(dir, "package.json"), JSON.stringify({
      private: true, type: "module",
      dependencies: Object.fromEntries(audit.packages.map((p: { name: string; tarball: string }) => [p.name, fromRegistry ? audit.version : `file:${resolve(p.tarball)}`])),
    }));
    if (fromRegistry) for (const pkg of audit.packages) {
      const integrity = JSON.parse(execFileSync("npm", ["view", `${pkg.name}@${audit.version}`, "dist.integrity", "--json"], { encoding: "utf8", env: { ...process.env, npm_config_userconfig: "/dev/null" } }));
      verifyPublishedArchive(resolve(pkg.tarball), pkg.name, audit.version, integrity);
    }
    execFileSync("pnpm", ["install", "--ignore-scripts", "--lockfile=false"], {
      cwd: dir, stdio: "pipe", timeout: 120000,
      env: { ...process.env, npm_config_userconfig: "/dev/null" },
    });
    await writeFile(join(dir, "consumer.mjs"), await readFile("tests/fixtures/npm-consumer.mjs", "utf8"));
    const result = execFileSync(process.execPath, [join(dir, "consumer.mjs")], {
      cwd: dir, env: { ...process.env, SQLIKE_NPM_CONSUMER: dir }, encoding: "utf8", timeout: 60000,
    });
    assert.match(result, /packed Node consumer passed/);
    const packed = await import(pathToFileURL(join(dir, "node_modules/@mizchi/sqlike/dist/index.js")).href);
    const candidate = packed.openDatabase(), oracle = new NodeDatabase(":memory:");
    try {
      assert.deepEqual(differentialLogicTest(
        parseLogicTest(await readFile("tests/fixtures/sqllogictest/select1.test", "utf8")),
        { execute: (sql) => oracle.run(sql), query: (sql) => nativeValues(oracle, sql) },
        { execute: (sql) => candidate.run(sql), query: (sql) => candidate.values(sql) },
      ), { statements: 31, queries: 1000 });
    } finally { candidate.close(); oracle.close(); }
    await writeFile(join(dir, "consumer.ts"), `
import {openDatabase, type Value} from '@mizchi/sqlike';
import {DefinedDatabase, type DefinedCatalog} from '@mizchi/sqlike/defined';
import {createDefinedDatabase, type DefinedRuntime} from '@mizchi/sqlike/defined/core';
import {encodeFrame, type Database, type ApplyPolicy} from '@mizchi/litestream';
import * as engine from '@mizchi/sqlike/engine';
const db: Database = openDatabase();
const values: Value[][] = openDatabase().values('SELECT 1');
declare const catalog: DefinedCatalog;
declare const runtime: DefinedRuntime;
const fixed = await DefinedDatabase.memory(catalog);
await createDefinedDatabase(runtime).memory(catalog);
const rows: Value[][] = await fixed.prepare('get').all();
// @ts-expect-error handles are private, not part of the published connection
fixed.handle;
// @ts-expect-error boolean is not a SQLite bind value
openDatabase().values('SELECT ?', [true]);
// @ts-expect-error generated handles cannot be fabricated
engine.database_dump({});
void [db, values, rows, encodeFrame];
`);
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ESNext", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: false, types: [], lib: ["ESNext", "DOM", "DOM.Iterable"] },
      files: ["consumer.ts"],
    }));
    execFileSync("pnpm", ["exec", "tsc", "-p", join(dir, "tsconfig.json")], { encoding: "utf8", stdio: "pipe", timeout: 60000 });
    const catalog = JSON.parse(await readFile(join(dir, "browser-catalog.json"), "utf8"));
    const literal = `{schema:new Uint8Array(${JSON.stringify(catalog.schema)}),statements:new Uint8Array(${JSON.stringify(catalog.statements)}),manifest:${JSON.stringify(catalog.manifest)}}`;
    await writeFile(join(dir, "browser.ts"), (await readFile("tests/fixtures/npm-browser.ts.txt", "utf8")).replace("__NPM_CATALOG__", literal));
    await writeFile(join(dir, "index.html"), '<script type="module" src="/browser.ts"></script>');
    const server = await createServer({ root: dir, configFile: false, publicDir: false, server: { host: "127.0.0.1", port: 0 }, optimizeDeps: { noDiscovery: true } });
    const browser = await chromium.launch({ headless: true });
    try {
      await server.listen();
      const address = server.httpServer!.address() as { port: number };
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      await page.goto(`http://127.0.0.1:${address.port}`);
      await page.waitForFunction(() => "npmCheck" in globalThis);
      const run = () => page.evaluate(() => (globalThis as unknown as { npmCheck(): Promise<unknown> }).npmCheck());
      assert.deepEqual(await run(), { rows: [["1", "persistent"]], protocol: true, wasm: true });
      await page.context().setOffline(true);
      assert.deepEqual(await run(), { rows: [["1", "persistent"]], protocol: true, wasm: true });
      await page.context().setOffline(false);
      await page.reload();
      await page.waitForFunction(() => "npmCheck" in globalThis);
      assert.deepEqual(await run(), { rows: [["1", "persistent"]], protocol: true, wasm: true });
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await server.close();
    }
    // Optional ORM is installed only for its own entry point.
    execFileSync("pnpm", ["add", "drizzle-orm@0.45.4", "--ignore-scripts", "--lockfile=false"], { cwd: dir, stdio: "pipe", timeout: 120000, env: { ...process.env, npm_config_userconfig: "/dev/null" } });
    await writeFile(join(dir, "orm.mjs"), `
import assert from 'node:assert/strict';
import {openDatabase} from '@mizchi/sqlike';
import {drizzle,migrate} from '@mizchi/sqlike/drizzle';
import {sql} from 'drizzle-orm';
import {createHash} from 'node:crypto';
const db=openDatabase(), orm=drizzle(db);
const ddl='CREATE TABLE task(id INTEGER PRIMARY KEY,title TEXT)';
await migrate(orm,[{hash:createHash('sha256').update(ddl).digest('hex'),folderMillis:1,bps:true,sql:[ddl]}]);
orm.transaction(tx=>{tx.run(sql\x60INSERT INTO task VALUES(1,'ok')\x60);assert.throws(()=>tx.transaction(nested=>{nested.run(sql\x60INSERT INTO task VALUES(2,'rollback')\x60);throw Error('rollback')}),/rollback/)});
assert.deepEqual(db.values('SELECT id,title FROM task'),[[1n,'ok']]); db.close();
`);
    execFileSync(process.execPath, [join(dir, "orm.mjs")], { cwd: dir, stdio: "pipe", timeout: 60000 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
