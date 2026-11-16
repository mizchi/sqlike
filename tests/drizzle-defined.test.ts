import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { integer, text, sqliteTable } from "drizzle-orm/sqlite-core";
import { drizzle } from "../adapters/drizzle.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { compileDrizzleCatalog } from "../scripts/drizzle-defined-compiler.ts";
import { openDrizzlePrepared } from "../adapters/drizzle-defined.ts";
import { createDefinedDatabase } from "../adapters/defined-database-core.ts";
import { definedWasm } from "../adapters/defined-wasm.ts";
import * as runtime from "../_build/js/release/build/mizchi/sqlike/defined/defined.js";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { build } from "vite";
import { chromium } from "@playwright/test";
import { buildSqlikeRuntime } from "../scripts/build-sqlike-runtime.ts";
import { defineSqlike, primaryKeyIndex } from "../src/sqlike-features.ts";

const tasks = sqliteTable("tasks", {
  id: integer().primaryKey(),
  title: text().notNull(),
  active: integer({ mode: "boolean" }).notNull(),
  created: integer({ mode: "timestamp_ms" }).notNull(),
  meta: text({ mode: "json" }),
});

const schema = [
  "CREATE TABLE tasks(id INTEGER PRIMARY KEY,title TEXT NOT NULL,active INTEGER NOT NULL,created INTEGER NOT NULL,meta TEXT)",
];

test("browser Drizzle prepared bridge runs a minimal bundle without ORM, compiler or SQL parser", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drizzle-defined-browser-"));
  const native = new NodeDatabase(":memory:");
  try {
    const orm = drizzle(native);
    const compiled = compileDrizzleCatalog({
      schema,
      queries: [
        {
          name: "add",
          query: orm
            .insert(tasks)
            .values({
              id: sql.placeholder("id"),
              title: "browser",
              active: true,
              created: new Date(1234),
              meta: { n: 1 },
            })
            .returning({ title: tasks.title }),
        },
        {
          name: "get",
          query: orm
            .select()
            .from(tasks)
            .where(eq(tasks.id, sql.placeholder("id"))),
        },
      ],
    });
    await buildSqlikeRuntime(defineSqlike({ mode: "defined", features: [primaryKeyIndex] }), {
      outDir: dir,
      targets: ["js"],
      minify: false,
    });
    assert.doesNotMatch(
      await readFile(join(dir, "runtime.js"), "utf8"),
      /function [^\n]*parse__statement\(/,
    );
    const entry = join(dir, "entry.ts");
    await writeFile(
      entry,
      `
      import {openDrizzlePrepared} from ${JSON.stringify(resolve("adapters/drizzle-defined.ts"))};
      import {createDefinedDatabase} from ${JSON.stringify(resolve("adapters/defined-database-core.ts"))};
      import * as runtime from './runtime.js';
      const bundle=${JSON.stringify({ ...compiled, catalog: { ...compiled.catalog, schema: [...compiled.catalog.schema], statements: [...compiled.catalog.statements] } })};
      bundle.catalog.schema=new Uint8Array(bundle.catalog.schema);
      bundle.catalog.statements=new Uint8Array(bundle.catalog.statements);
      export async function smoke(){
        const db=await openDrizzlePrepared(createDefinedDatabase(runtime),bundle);
        await db.execute('add',{id:1n});
        const rows=await db.prepare('get').all({id:1n});
        const image=await db.snapshot();await db.close();
        const reopened=await openDrizzlePrepared(createDefinedDatabase(runtime),bundle,{image});
        const restored=await reopened.prepare('get').all({id:1n});await reopened.close();
        const saved=await openDrizzlePrepared(createDefinedDatabase(runtime),bundle,{name:'drizzle-bridge'});
        await saved.execute('add',{id:2n});await saved.close();
        const durable=await openDrizzlePrepared(createDefinedDatabase(runtime),bundle,{name:'drizzle-bridge'});
        const persisted=await durable.prepare('get').all({id:2n});await durable.close();
        const encode=rs=>rs.map(r=>r.map(v=>typeof v==='bigint'?String(v):v));
        return [encode(rows),encode(restored),encode(persisted)];
      }`,
    );
    const output = await build({
      configFile: false,
      publicDir: false,
      logLevel: "silent",
      input: entry,
      build: {
        write: false,
        minify: "oxc",
        target: "esnext",
        rolldownOptions: { preserveEntrySignatures: "strict" },
      },
    });
    const chunks = (Array.isArray(output) ? output : [output]).flatMap((b) =>
      "output" in b ? b.output : [],
    );
    const modules = chunks.flatMap((c) => (c.type === "chunk" ? Object.keys(c.modules) : []));
    assert.equal(
      modules.some(
        (p) =>
          p.includes("node_modules/drizzle-orm") ||
          p.endsWith("/compiler/compiler.js") ||
          p.endsWith("/sqlike/sqlike.js"),
      ),
      false,
    );
    const emitted = chunks.find((c) => c.type === "chunk" && c.isEntry)!;
    assert.ok(emitted.type === "chunk");
    const files = new Map(
      chunks.map((c) => ["/" + c.fileName, c.type === "chunk" ? c.code : c.source]),
    );
    const server = createServer((req, res) => {
      const path = new URL(req.url!, "http://localhost").pathname;
      const bytes =
        path === "/" ? "<!doctype html><title>Prepared bridge</title>" : files.get(path);
      res.writeHead(bytes === undefined ? 404 : 200, {
        "Content-Type": path.endsWith(".js") ? "text/javascript" : "text/html",
      });
      res.end(bytes);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${address.port}`);
      const actual = await page.evaluate(
        async (url) => (await import(/* @vite-ignore */ url)).smoke(),
        "/" + emitted.fileName,
      );
      const expected = [["1", "browser", "1", "1234", '{"n":1}']];
      assert.deepEqual(actual, [expected, expected, [["2", "browser", "1", "1234", '{"n":1}']]]);
    } finally {
      await browser.close();
      await new Promise<void>((done, fail) => server.close((e) => (e ? fail(e) : done())));
    }
  } finally {
    native.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("custom placeholder encoders cannot silently become identity encoders", () => {
  const native = new NodeDatabase(":memory:");
  try {
    const custom = sqliteTable("custom", { id: integer() });
    custom.id.mapToDriverValue = (value) => Number(value) + 100;
    assert.throws(
      () =>
        compileDrizzleCatalog({
          schema: ["CREATE TABLE custom(id INTEGER)"],
          queries: [
            {
              name: "q",
              query: drizzle(native)
                .insert(custom)
                .values({ id: sql.placeholder("id") }),
            },
          ],
        }),
      /unsupported Drizzle placeholder encoder/,
    );
  } finally {
    native.close();
  }
});

test("Drizzle queries compile to binary-only JS/Wasm execution with named codecs and constants", async () => {
  const native = new NodeDatabase(":memory:");
  const orm = drizzle(native);
  const insert = orm
    .insert(tasks)
    .values({
      id: sql.placeholder("id"),
      title: sql.placeholder("title"),
      active: sql.placeholder("active"),
      created: sql.placeholder("created"),
      meta: sql.placeholder("meta"),
    })
    .returning({ id: tasks.id, title: tasks.title });
  const find = orm
    .select()
    .from(tasks)
    .where(eq(tasks.id, sql.placeholder("id")));
  const rename = orm
    .update(tasks)
    .set({ title: sql`${sql.placeholder("title")}` })
    .where(eq(tasks.id, sql.placeholder("id")))
    .returning({ title: tasks.title });
  const constant = orm
    .select({ value: sql`${-0}`.as("value") })
    .from(tasks)
    .limit(1);
  const built = compileDrizzleCatalog({
    schema,
    queries: [
      { name: "add", query: insert },
      { name: "find", query: find },
      { name: "rename", query: rename },
      { name: "constant", query: constant },
    ],
  });
  // The binding plan is JSON data; ORM encoders/objects do not cross the build boundary.
  const compiled = { ...built, bindings: JSON.parse(JSON.stringify(built.bindings)) };
  const wasm = (
    await WebAssembly.instantiate(
      readFileSync("_build/wasm-gc/release/build/mizchi/sqlike/defined/defined.wasm"),
      {},
      { builtins: ["js-string"], importedStringConstants: "_" },
    )
  ).instance.exports;
  try {
    for (const raw of [runtime, definedWasm(wasm)]) {
      const db = await openDrizzlePrepared(createDefinedDatabase(raw), compiled);
      const values = {
        id: 1n,
        title: "one",
        active: true,
        created: new Date(1234),
        meta: { n: 1 },
      };
      assert.deepEqual((await db.execute("add", values)).rows, [[1n, "one"]]);
      assert.deepEqual(await db.prepare("find").all({ id: 1n }), [
        [1n, "one", 1n, 1234n, '{"n":1}'],
      ]);
      assert.deepEqual(await db.prepare("rename").get({ id: 1n, title: "two" }), ["two"]);
      assert.equal(Object.is((await db.prepare("constant").get())![0], -0), true);
      const before = await db.snapshot();
      await assert.rejects(db.execute("rename", { id: 1n }), /missing.*title/);
      await assert.rejects(
        db.execute("rename", { id: 1n, title: "bad", typo: 1 }),
        /unknown.*typo/,
      );
      await assert.rejects(
        db.execute("add", { ...values, id: 2n, created: new Date(NaN) }),
        /date/i,
      );
      assert.deepEqual(await db.snapshot(), before);
      await db.close();
    }
    const corrupt = structuredClone(compiled);
    corrupt.bindings.queries[0]!.parameters[0] = {
      kind: "placeholder",
      name: "wrong",
      codec: "value",
    };
    await assert.rejects(
      openDrizzlePrepared(createDefinedDatabase(runtime), corrupt),
      /binding.*checksum/,
    );
  } finally {
    native.close();
  }
});
