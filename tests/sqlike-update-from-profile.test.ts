import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defineSqlike } from "../src/sqlike-features.ts";
import { buildSqlikeRuntime } from "../scripts/build-sqlike-runtime.ts";
import { analyzeCatalogRequirements } from "../scripts/analyze-catalog.ts";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import { buildDefinedCatalog } from "../scripts/defined-compiler.ts";
import { openCompiled } from "../src/sqlike-runtime.ts";
import { createDefinedDatabase } from "../adapters/defined-database-core.ts";
import { definedWasm } from "../adapters/defined-wasm.ts";

test("UPDATE FROM catalogs select the feature and retain live prepared bindings without a parser", async () => {
  const catalog = {
    schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)", "CREATE TABLE s(id INTEGER PRIMARY KEY,n INTEGER)"],
    queries: [
      { name: "seedt", sql: "INSERT INTO t VALUES(1,100),(2,200)" },
      { name: "seeds", sql: "INSERT INTO s VALUES(1,10),(2,20)" },
      { name: "q", sql: "UPDATE t AS dst SET n=src.n+?1 FROM s AS src WHERE dst.id=src.id AND dst.id>=?2 RETURNING id,n" },
      { name: "change", sql: "UPDATE s SET n=n+1" },
      { name: "agg", sql: "UPDATE t SET n=daily.n FROM (SELECT id,sum(n) AS n FROM s GROUP BY id) AS daily WHERE t.id=daily.id RETURNING id,n" },
    ],
  };
  const requirements = analyzeCatalogRequirements(catalog);
  assert.deepEqual(requirements.features, ["updateFrom"]);
  assert.deepEqual(analyzeCatalogRequirements({ schema: [], queries: [{ name: "q", sql: "SELECT '$update-from'" }] }).features, []);
  const dir = await mkdtemp(join(tmpdir(), "sqlike-update-from-profile-"));
  try {
    for (const mode of ["aot", "defined"] as const) {
      const built = await buildSqlikeRuntime(defineSqlike({ mode }), { catalog, outDir: join(dir, mode), minify: false });
      assert.deepEqual(built.requirements, requirements);
      const code = await readFile(join(built.directory, "runtime.js"), "utf8");
      assert.doesNotMatch(code, /function [^\n]*parse__statement\(/);
      const js = await import(pathToFileURL(join(built.directory, "runtime.js")).href);
      const wasm = (await WebAssembly.instantiate(await readFile(join(built.directory, "runtime.wasm")), {},
        { builtins: ["js-string"], importedStringConstants: "_" })).instance.exports;
      for (const [i, raw] of [js, wasm].entries()) {
        const db = mode === "aot" ? openCompiled(raw, buildCatalog(catalog).artifact)
          : await createDefinedDatabase(i === 0 ? raw : definedWasm(raw)).memory(buildDefinedCatalog(catalog));
        try {
          await db.execute("seedt"); await db.execute("seeds");
          assert.deepEqual((await db.execute("q", [1n, 1n])).rows, [[1n, 11n], [2n, 21n]]);
          await db.execute("change");
          assert.deepEqual((await db.execute("q", [2n, 2n])).rows, [[2n, 23n]]);
          assert.deepEqual((await db.execute("q", [3n, 9n])).rows, []);
          assert.deepEqual((await db.execute("q", [4n, 1n])).rows, [[1n, 15n], [2n, 25n]]);
          assert.deepEqual((await db.execute("agg")).rows, [[1n, 11n], [2n, 21n]]);
        } finally { if ("close" in db && typeof db.close === "function") await db.close(); }
      }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
