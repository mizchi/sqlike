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

test("catalogs infer aggregate ordering and retain subtype dependencies in selected AOT/binary JS/Wasm", async () => {
  const catalog = { schema: [], queries: [{
    name: "q", sql: "SELECT json_group_array(json_object('n',1) ORDER BY 1) FILTER(WHERE 1)",
  }] };
  const requirements = analyzeCatalogRequirements(catalog);
  assert.deepEqual(requirements.features, ["aggregateFilter", "aggregateOrderBy", "sqlJson"]);
  assert.deepEqual(requirements.functionGroups, ["jsonAggregate", "jsonConstruct"]);
  assert.deepEqual(requirements.queryParts, ["jsonSubtype"]);
  assert.deepEqual(analyzeCatalogRequirements({
    schema: [], queries: [{ name: "q", sql: "SELECT 'ORDER BY'" }],
  }).features, []);
  const dir = await mkdtemp(join(tmpdir(), "sqlike-ordered-profile-"));
  try {
    for (const mode of ["aot", "defined"] as const) {
      const built = await buildSqlikeRuntime(defineSqlike({ mode }), {
        catalog, outDir: join(dir, mode), minify: false,
      });
      assert.deepEqual(built.requirements, requirements);
      const code = await readFile(join(built.directory, "runtime.js"), "utf8");
      assert.doesNotMatch(code, /function [^\n]*parse__statement\(/);
      const js = await import(pathToFileURL(join(built.directory, "runtime.js")).href);
      const wasm = (await WebAssembly.instantiate(
        await readFile(join(built.directory, "runtime.wasm")), {},
        { builtins: ["js-string"], importedStringConstants: "_" },
      )).instance.exports;
      for (const [i, raw] of [js, wasm].entries()) {
        const db = mode === "aot" ? openCompiled(raw, buildCatalog(catalog).artifact)
          : await createDefinedDatabase(i === 0 ? raw : definedWasm(raw)).memory(buildDefinedCatalog(catalog));
        try { assert.deepEqual((await db.execute("q")).rows, [['[{"n":1}]']]); }
        finally { if ("close" in db && typeof db.close === "function") await db.close(); }
      }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
