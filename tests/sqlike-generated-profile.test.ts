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

test("generated schema dependencies select JSON functions without a parser and rebuild after reopen", async () => {
  const catalog = {
    schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,doc TEXT,n INT AS(json_extract(doc,'$.n')),twice INT AS(n*2))"],
    queries: [
      { name: "add", sql: "INSERT INTO t VALUES(?,?) RETURNING id,n,twice" },
      { name: "change", sql: "UPDATE t SET doc=? WHERE id=? RETURNING id,n,twice" },
      { name: "q", sql: "SELECT id,n,twice FROM t ORDER BY id" },
    ],
  };
  const requirements = analyzeCatalogRequirements(catalog);
  assert.deepEqual(requirements.features, ["generatedColumns", "sqlJson"]);
  assert.deepEqual(analyzeCatalogRequirements({ schema: [], queries: [{name:"q",sql:"SELECT '$generated-virtual'"}] }).features, []);
  const dir = await mkdtemp(join(tmpdir(), "sqlike-generated-profile-"));
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
        if (mode === "aot") {
          const db = openCompiled(raw, buildCatalog(catalog).artifact);
          assert.deepEqual(db.execute("add", [1n,'{"n":3}']).rows, [[1n,3n,6n]]);
          const image = db.dump();
          assert.deepEqual(db.execute("change", ['{"n":7}',1n]).rows, [[1n,7n,14n]]);
          db.restore(image);
          assert.deepEqual(db.execute("q").rows, [[1n,3n,6n]]);
          assert.throws(()=>db.execute("change", ["{bad",1n]));
          assert.deepEqual(db.execute("q").rows, [[1n,3n,6n]]);
        } else {
          const DB = createDefinedDatabase(i === 0 ? raw : definedWasm(raw));
          const source = buildDefinedCatalog(catalog);
          const db = await DB.memory(source);
          try {
            assert.deepEqual((await db.execute("add", [1n,'{"n":3}'])).rows, [[1n,3n,6n]]);
            const image = await db.snapshot();
            assert.deepEqual((await db.execute("change", ['{"n":7}',1n])).rows, [[1n,7n,14n]]);
            const reopened = await DB.memory(source, {image});
            try {
              assert.deepEqual((await reopened.execute("q")).rows, [[1n,3n,6n]]);
              await assert.rejects(reopened.execute("change", ["{bad",1n]));
              assert.deepEqual((await reopened.execute("q")).rows, [[1n,3n,6n]]);
            } finally { await reopened.close(); }
          } finally { await db.close(); }
        }
      }
    }
  } finally { await rm(dir, {recursive:true,force:true}); }
});
