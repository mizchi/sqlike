import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defineSqlike } from "../src/sqlike-features.ts";
import { buildSqlikeRuntime } from "../scripts/build-sqlike-runtime.ts";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import { buildDefinedCatalog } from "../scripts/defined-compiler.ts";
import { openCompiled } from "../src/sqlike-runtime.ts";
import { createDefinedDatabase } from "../adapters/defined-database-core.ts";
import { definedWasm } from "../adapters/defined-wasm.ts";

test("CTAS initial data loads in selected AOT and binary builds without its parser, JSON or compiler functions", async () => {
  const catalog = {
    schema: [
      "CREATE TABLE t AS SELECT CAST(key AS INTEGER) AS id,value AS v FROM json_each('[3,1,2]') ORDER BY key DESC",
    ],
    queries: [
      { name: "q", sql: "SELECT rowid,* FROM t ORDER BY rowid" },
      { name: "clear", sql: "DELETE FROM t" },
    ],
  };
  const expected = [
    [1n, 2n, 2n],
    [2n, 1n, 1n],
    [3n, 0n, 3n],
  ];
  const binary = buildDefinedCatalog(catalog);
  assert.equal(binary.schema[5], 7);
  assert.equal(
    buildDefinedCatalog({ schema: ["CREATE TABLE t(v)"], queries: [] })
      .schema[5],
    1,
  );
  const dir = await mkdtemp(join(tmpdir(), "sqlike-ctas-profile-"));
  try {
    for (const mode of ["aot", "defined"] as const) {
      const built = await buildSqlikeRuntime(defineSqlike({ mode }), {
        catalog,
        outDir: join(dir, mode),
        minify: false,
      });
      assert.deepEqual(built.requirements?.features, []);
      assert.deepEqual(built.requirements?.functionGroups, []);
      const code = await readFile(join(built.directory, "runtime.js"), "utf8");
      for (const symbol of [
        "parse__statement",
        "create__table__as",
        "ctas__sql",
        "json__table__rows",
        "compile__program",
      ])
        assert.doesNotMatch(code, new RegExp(`function [^\\n]*${symbol}\\(`));
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
          const artifact = buildCatalog(catalog).artifact,
            db = openCompiled(raw, artifact),
            fresh = openCompiled(raw, artifact);
          assert.deepEqual(db.execute("q").rows, expected);
          const image = db.dump();
          db.execute("clear");
          assert.deepEqual(db.execute("q").rows, []);
          assert.deepEqual(fresh.execute("q").rows, expected);
          db.restore(image);
          assert.deepEqual(db.execute("q").rows, expected);
        } else {
          const DB = createDefinedDatabase(i === 0 ? raw : definedWasm(raw)),
            db = await DB.memory(binary),
            fresh = await DB.memory(binary);
          try {
            assert.deepEqual((await db.execute("q")).rows, expected);
            const image = await db.snapshot();
            await db.execute("clear");
            assert.deepEqual((await db.execute("q")).rows, []);
            assert.deepEqual((await fresh.execute("q")).rows, expected);
            const restored = await DB.memory(binary, { image });
            try {
              assert.deepEqual((await restored.execute("q")).rows, expected);
            } finally {
              await restored.close();
            }
          } finally {
            await db.close();
            await fresh.close();
          }
        }
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
