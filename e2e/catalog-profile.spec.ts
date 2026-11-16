import { test, expect } from "@playwright/test";
import { build } from "vite";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSqlikeRuntime } from "../scripts/build-sqlike-runtime.ts";
import { defineSqlike, primaryKeyIndex } from "../src/sqlike-features.ts";
import { buildDefinedCatalog } from "../scripts/defined-compiler.ts";

test.use({ serviceWorkers: "block" });
const source = {
  schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT)"],
  queries: [
    { name: "add", sql: "INSERT INTO t VALUES(?,?)" },
    {
      name: "list",
      sql: "WITH a AS(SELECT id,v FROM t) SELECT id,lower(v),v GLOB '*a*',json_object('value',v) FROM a ORDER BY id",
    },
  ],
};
for (const target of ["js", "wasm"] as const) {
  test(`catalog-selected ${target} executes with only its runtime and reopens IndexedDB offline`, async ({
    page,
    context,
  }) => {
    test.setTimeout(90000);
    const dir = await mkdtemp(join(tmpdir(), `sqlike-catalog-browser-${target}-`));
    try {
      const built = await buildSqlikeRuntime(
        defineSqlike({ mode: "defined", features: [primaryKeyIndex] }),
        {
          catalog: source,
          outDir: join(dir, "runtime"),
          targets: [target === "js" ? "js" : "wasm-gc"],
          minify: false,
        },
      );
      const raw = await readFile(
        join(built.directory, target === "js" ? "runtime.js" : "runtime.wasm"),
      );
      expect(built.requirements?.queryParts).toEqual(["cte"]);
      expect(built.requirements?.functionGroups).toEqual([
        "caseConversion",
        "glob",
        "jsonConstruct",
      ]);
      if (target === "js")
        expect(raw.toString()).not.toMatch(
          /function [^\n]*(sql__round|substring__value|parse__statement|parse__sql__json|execute__recursive__cte|using__row|compound__relation)\(/,
        );
      const host = JSON.stringify(resolve("adapters/defined-database-core.ts"));
      const entry = join(dir, "entry.ts");
      await writeFile(
        entry,
        `import {createDefinedDatabase} from ${host};\n` +
          (target === "js"
            ? `import * as runtime from ${JSON.stringify(join(built.directory, "runtime.js"))};\nexport const DB=createDefinedDatabase(runtime);`
            : `import {definedWasm} from ${JSON.stringify(resolve("adapters/defined-wasm.ts"))};\nconst {instance}=await WebAssembly.instantiateStreaming(fetch('/catalog-assets/runtime.wasm'),{},{builtins:['js-string'],importedStringConstants:'_'});\nexport const DB=createDefinedDatabase(definedWasm(instance.exports));`),
      );
      const result = await build({
        configFile: false,
        publicDir: false,
        logLevel: "silent",
        build: { write: false, target: "esnext", minify: "oxc", lib: { entry, formats: ["es"] } },
      });
      const files = new Map<string, Buffer>();
      let entryFile = "";
      for (const output of Array.isArray(result) ? result : [result])
        if ("output" in output)
          for (const item of output.output) {
            if (item.type === "chunk") {
              expect(
                Object.keys(item.modules).filter(
                  (p) =>
                    p.includes("/compiler/") ||
                    p.endsWith("/defined/defined.js") ||
                    p.endsWith("/sqlike/sqlike.js"),
                ),
              ).toEqual([]);
              files.set(item.fileName, Buffer.from(item.code));
              if (item.isEntry) entryFile = item.fileName;
            } else files.set(item.fileName, Buffer.from(item.source));
          }
      if (target === "wasm") files.set("runtime.wasm", raw);
      expect(entryFile).not.toBe("");
      await page.route("**/catalog-profile", (r) =>
        r.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
      );
      const requests: string[] = [];
      await page.route("**/catalog-assets/**", (r) => {
        const file = new URL(r.request().url()).pathname.slice("/catalog-assets/".length);
        requests.push(file);
        const body = files.get(file);
        return r.fulfill({
          status: body ? 200 : 404,
          contentType: file.endsWith(".wasm") ? "application/wasm" : "text/javascript",
          body: body ?? "missing asset",
        });
      });
      const catalog = buildDefinedCatalog(source);
      const data = {
        schema: [...catalog.schema],
        statements: [...catalog.statements],
        manifest: catalog.manifest,
      };
      await page.goto("/catalog-profile");
      const open = async () =>
        page.evaluate(
          async ({ entryFile, data, target }) => {
            const mod = await import(/* @vite-ignore */ `/catalog-assets/${entryFile}`);
            const catalog = {
              ...data,
              schema: new Uint8Array(data.schema),
              statements: new Uint8Array(data.statements),
            };
            const name = `catalog-profile-${target}`;
            (globalThis as any).catalogTest = { mod, catalog, name };
            const db = await mod.DB.open(name, catalog);
            const rows = await db.prepare("list").all();
            await db.close();
            return rows;
          },
          { entryFile, data, target },
        );
      expect(await open()).toEqual([]);
      const before = requests.length;
      await context.setOffline(true);
      expect(
        await page.evaluate(async () => {
          const { mod, catalog, name } = (globalThis as any).catalogTest;
          const db = await mod.DB.open(name, catalog);
          await db.execute("add", [1n, "Alpha"]);
          await db.close();
          const reopened = await mod.DB.open(name, catalog);
          const rows = await reopened.prepare("list").all();
          await reopened.close();
          return rows;
        }),
      ).toEqual([[1n, "alpha", 1n, '{"value":"Alpha"}']]);
      expect(requests.length).toBe(before);
      await context.setOffline(false);
      await page.reload();
      expect(await open()).toEqual([[1n, "alpha", 1n, '{"value":"Alpha"}']]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
