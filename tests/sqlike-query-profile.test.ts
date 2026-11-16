import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSqlikeRuntime } from "../scripts/build-sqlike-runtime.ts";
import { analyzeCatalogRequirements } from "../scripts/analyze-catalog.ts";
import { defineSqlike } from "../src/sqlike-features.ts";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import { buildDefinedCatalog } from "../scripts/defined-compiler.ts";
import { openCompiled } from "../src/sqlike-runtime.ts";
import { createDefinedDatabase } from "../adapters/defined-database-core.ts";
import { definedWasm } from "../adapters/defined-wasm.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "./compatibility/native-values.ts";

const fixtures = [
  { name: "plain", sql: "SELECT 1", parts: [] },
  { name: "cte", sql: "WITH a(x) AS (SELECT 1) SELECT x FROM a", parts: ["cte"] },
  {
    name: "recursive",
    sql: "WITH RECURSIVE a(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM a WHERE x<3) SELECT x FROM a ORDER BY x",
    parts: ["compound", "cte", "recursiveCte"],
  },
  {
    name: "join",
    sql: "SELECT a.x,b.y FROM (SELECT 1 AS x) a LEFT JOIN (SELECT 2 AS y) b ON a.x<b.y",
    parts: ["cte", "join"],
  },
  { name: "compound", sql: "SELECT 2 AS x UNION SELECT 1 ORDER BY x", parts: ["compound"] },
] as const;

test("CTE, recursion, joins and compound SELECTs are independently inferred, removed and validated", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sqlike-query-profile-"));
  const native = new NodeDatabase(":memory:");
  try {
    for (const fixture of fixtures) {
      const catalog = { schema: [], queries: [{ name: "q", sql: fixture.sql }] };
      for (const mode of ["aot", "defined"] as const) {
        const built = await buildSqlikeRuntime(defineSqlike({ mode }), {
          catalog,
          outDir: join(dir, fixture.name, mode),
          minify: false,
        });
        assert.deepEqual(built.requirements?.queryParts, fixture.parts, fixture.name);
        const code = await readFile(join(built.directory, "runtime.js"), "utf8");
        for (const [part, symbols] of Object.entries({
          cte: ["execute__cte", "prepare__cte"],
          recursiveCte: ["execute__recursive__cte"],
          join: ["using__row", "using__pairs"],
          compound: ["compound__relation", "compound__order__index"],
        }))
          if (!(fixture.parts as readonly string[]).includes(part))
            for (const symbol of symbols)
              assert.ok(
                !code
                  .split("\n")
                  .some((line) => line.startsWith("function ") && line.includes(symbol + "(")),
                `${fixture.name}: ${symbol}`,
              );
        const js = await import(pathToFileURL(join(built.directory, "runtime.js")).href);
        const wasm = (
          await WebAssembly.instantiate(
            await readFile(join(built.directory, "runtime.wasm")),
            {},
            { builtins: ["js-string"], importedStringConstants: "_" },
          )
        ).instance.exports;
        for (const [i, raw] of [js, wasm].entries()) {
          const open = async (source: typeof catalog) =>
            mode === "aot"
              ? openCompiled(raw, buildCatalog(source).artifact)
              : await createDefinedDatabase(i === 0 ? raw : definedWasm(raw)).memory(
                  buildDefinedCatalog(source),
                );
          const db = await open(catalog);
          try {
            assert.deepEqual((await db.execute("q")).rows, nativeValues(native, fixture.sql));
          } finally {
            if ("close" in db && typeof db.close === "function") await db.close();
          }
          for (const other of fixtures) {
            if (!other.parts.some((p) => !(fixture.parts as readonly string[]).includes(p)))
              continue;
            await assert.rejects(
              open({ schema: [], queries: [{ name: "q", sql: other.sql }] }),
              /catalog capability disabled/,
            );
          }
        }
      }
    }
  } finally {
    native.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("structural requirements include unused subqueries and view definitions", () => {
  const source = {
    schema: ["CREATE VIEW v AS WITH a(x) AS(SELECT 1) SELECT x FROM a"],
    queries: [{ name: "q", sql: "SELECT CASE WHEN 0 THEN (SELECT 1 UNION SELECT 2) ELSE 0 END" }],
  };
  assert.deepEqual(analyzeCatalogRequirements(source).queryParts, ["compound", "cte"]);
});
