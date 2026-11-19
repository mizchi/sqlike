import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSqlikeRuntime } from "../scripts/build-sqlike-runtime.ts";
import { defineSqlike } from "../src/sqlike-features.ts";
import { buildDefinedCatalog } from "../scripts/defined-compiler.ts";
import { buildOxcBundle } from "../scripts/oxc-runtime.ts";

test.use({ serviceWorkers: "block" });
const catalog = {
  schema: [
    "CREATE TABLE seed AS SELECT CAST(1 AS INTEGER) AS id,'initial' AS v",
    "CREATE TABLE t(id INTEGER PRIMARY KEY,v DEFAULT(lower('A')||json_extract('{\"v\":2}','$.v')))",
  ],
  queries: [
    { name: "seed", sql: "SELECT * FROM seed" },
    { name: "clear", sql: "DELETE FROM seed" },
    { name: "add", sql: "INSERT INTO t(id) VALUES(?) RETURNING *" },
    { name: "q", sql: "SELECT * FROM t ORDER BY id" },
  ],
};

for (const target of ["js", "wasm"] as const)
  test(`CTAS initial rows and expression defaults persist offline in ${target} IndexedDB`, async ({
    page,
    context,
  }) => {
    test.setTimeout(90000);
    const dir = await mkdtemp(join(tmpdir(), "sqlike-schema-browser-"));
    try {
      const built = await buildSqlikeRuntime(
        defineSqlike({ mode: "defined" }),
        {
          catalog,
          outDir: join(dir, "engine"),
          targets: [target === "js" ? "js" : "wasm-gc"],
        },
      );
      const entry = join(dir, "entry.ts"),
        host = JSON.stringify(resolve("adapters/defined-database-core.ts"));
      await writeFile(
        entry,
        `import {createDefinedDatabase} from ${host};` +
          (target === "js"
            ? `import * as raw from ${JSON.stringify(join(built.directory, "runtime.js"))};export const DB=createDefinedDatabase(raw);`
            : `import {definedWasm} from ${JSON.stringify(resolve("adapters/defined-wasm.ts"))};const {instance}=await WebAssembly.instantiate(await(await fetch('/schema-assets/runtime.wasm')).arrayBuffer(),{},{builtins:['js-string'],importedStringConstants:'_'});export const DB=createDefinedDatabase(definedWasm(instance.exports));`),
      );
      const bundle = await buildOxcBundle(entry),
        outputs = (Array.isArray(bundle) ? bundle : [bundle]).flatMap((r) =>
          "output" in r ? r.output : [],
        );
      const chunk = outputs.find((r) => r.type === "chunk" && r.isEntry);
      if (!chunk || chunk.type !== "chunk") throw Error("missing JS");
      const files = new Map<string, Buffer>();
      for (const output of outputs)
        files.set(
          output.fileName,
          Buffer.from(output.type === "chunk" ? output.code : output.source),
        );
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route("**/schema", (r) =>
        r.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
      );
      await page.route("**/schema-assets/**", (r) => {
        const body = files.get(
          new URL(r.request().url()).pathname.slice("/schema-assets/".length),
        );
        return body
          ? r.fulfill({ contentType: "text/javascript", body })
          : r.abort();
      });
      if (target === "wasm") {
        const bytes = await readFile(join(built.directory, "runtime.wasm"));
        await page.route("**/schema-assets/runtime.wasm", (r) =>
          r.fulfill({ contentType: "application/wasm", body: bytes }),
        );
      }
      const source = buildDefinedCatalog(catalog),
        serialized = {
          entryFile: chunk.fileName,
          schema: Array.from(source.schema),
          statements: Array.from(source.statements),
          manifest: source.manifest,
        };
      await page.goto("/schema");
      const initial = await page.evaluate(async (source) => {
        const entry = `/schema-assets/${source.entryFile}`;
        const { DB } = await import(/* @vite-ignore */ entry);
        const catalog = {
          ...source,
          schema: Uint8Array.from(source.schema),
          statements: Uint8Array.from(source.statements),
        };
        const db = await DB.open("schema-check", catalog);
        (globalThis as any).schemaTest = { DB, catalog, db };
        const rows = (await db.execute("seed")).rows;
        await db.execute("clear");
        await db.execute("add", [1n]);
        await db.close();
        return rows.map((r: any[]) => r.map(String));
      }, serialized);
      expect(initial).toEqual([["1", "initial"]]);
      await context.setOffline(true);
      const reopened = await page.evaluate(async () => {
        const { DB, catalog } = (globalThis as any).schemaTest,
          db = await DB.open("schema-check", catalog);
        const seed = (await db.execute("seed")).rows;
        await db.execute("add", [2n]);
        const rows = (await db.execute("q")).rows;
        await db.close();
        return { seed, rows: rows.map((r: any[]) => r.map(String)) };
      });
      expect(reopened).toEqual({
        seed: [],
        rows: [
          ["1", "a2"],
          ["2", "a2"],
        ],
      });
      expect(errors).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
