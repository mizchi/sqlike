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
import { result } from "./compatibility/sqlike-paths.ts";

test("DEFAULT-only function dependencies survive parser-free AOT/binary selection and reopening", async () => {
  const catalog = {
    schema: [
      "CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT DEFAULT(lower('A')||json_extract('{\"s\":\"B\"}','$.s')))",
    ],
    queries: [
      { name: "add", sql: "INSERT INTO t(id) VALUES(?) RETURNING *" },
      { name: "q", sql: "SELECT * FROM t ORDER BY id" },
    ],
  };
  const requirements = analyzeCatalogRequirements(catalog);
  assert.deepEqual(requirements.features, ["sqlJson"]);
  assert.ok(requirements.functionGroups.length > 0);
  const dir = await mkdtemp(join(tmpdir(), "sqlike-default-profile-"));
  try {
    for (const mode of ["aot", "defined"] as const) {
      const built = await buildSqlikeRuntime(defineSqlike({ mode }), {
        catalog,
        outDir: join(dir, mode),
        minify: false,
      });
      assert.deepEqual(built.requirements, requirements);
      assert.doesNotMatch(
        await readFile(join(built.directory, "runtime.js"), "utf8"),
        /function [^\n]*parse__statement\(/,
      );
      const js = await import(
        pathToFileURL(join(built.directory, "runtime.js")).href
      );
      const wasm = (
        await WebAssembly.instantiate(
          await readFile(join(built.directory, "runtime.wasm")),
          {},
          { builtins: ["js-string"], importedStringConstants: "_" },
        )
      ).instance.exports;
      for (const [i, raw] of [js, wasm].entries()) {
        if (mode === "aot") {
          const db = openCompiled(raw, buildCatalog(catalog).artifact);
          assert.deepEqual(db.execute("add", [1n]).rows, [[1n, "aB"]]);
          const image = db.dump();
          db.execute("add", [2n]);
          db.restore(image);
          assert.deepEqual(db.execute("q").rows, [[1n, "aB"]]);
          assert.deepEqual(db.execute("add", [3n]).rows, [[3n, "aB"]]);
          const incompatible = buildCatalog({
            schema: ["CREATE TABLE t(v DEFAULT (date('now')))"],
            queries: [],
          });
          assert.throws(
            () => result(raw.aot_info(raw.aot_open(incompatible.artifact, ""))),
            /feature|function|capability/,
          );
        } else {
          const DB = createDefinedDatabase(i === 0 ? raw : definedWasm(raw)),
            source = buildDefinedCatalog(catalog);
          const db = await DB.memory(source);
          try {
            assert.deepEqual((await db.execute("add", [1n])).rows, [
              [1n, "aB"],
            ]);
            const image = await db.snapshot();
            await db.execute("add", [2n]);
            const restored = await DB.memory(source, { image });
            try {
              assert.deepEqual((await restored.execute("q")).rows, [
                [1n, "aB"],
              ]);
              assert.deepEqual((await restored.execute("add", [3n])).rows, [
                [3n, "aB"],
              ]);
            } finally {
              await restored.close();
            }
          } finally {
            await db.close();
          }
        }
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
