import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { analyzeCatalogRequirements } from "../scripts/analyze-catalog.ts";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import { buildDefinedCatalog } from "../scripts/defined-compiler.ts";
import { buildSqlikeRuntime } from "../scripts/build-sqlike-runtime.ts";
import { defineSqlike } from "../src/sqlike-features.ts";
import { openCompiled } from "../src/sqlike-runtime.ts";
import { createDefinedDatabase } from "../adapters/defined-database-core.ts";
import { definedWasm } from "../adapters/defined-wasm.ts";
import type { CatalogSource } from "../src/aot-contract.ts";
import type { Value } from "../src/contract.ts";

const fixtures = [
  { name: "plain", sql: "SELECT ? AS v", params: [9007199254740993n], groups: [] },
  { name: "call", sql: "SELECT lower(?) AS v", params: ["HELLO"], groups: ["call"] },
  { name: "like", sql: "SELECT ? LIKE ? AS v", params: ["hello", "h%"], groups: [] },
  { name: "cast", sql: "SELECT CAST(? AS INTEGER) AS v", params: ["42tail"], groups: ["cast"] },
  { name: "case", sql: "SELECT CASE WHEN ? THEN 'yes' ELSE 'no' END AS v", params: [1n], groups: ["case"] },
  { name: "between", sql: "SELECT ? BETWEEN 1 AND 3 AS v", params: [2n], groups: ["between"] },
  {
    name: "subquery", sql: "SELECT (SELECT ?) AS v, EXISTS(SELECT 1 WHERE 0) AS e",
    params: [42n], groups: ["subquery"],
  },
  {
    name: "unused", sql: "SELECT CASE WHEN 0 THEN (SELECT lower(?)) ELSE 'clean' END AS v",
    params: ["HELLO"], groups: ["call", "case", "subquery"],
  },
  {
    name: "cte", sql: "WITH a(x) AS (SELECT ?) SELECT x FROM a",
    params: [42n], groups: [],
  },
  {
    name: "window", sql: "SELECT count(*) OVER() AS v",
    params: [], groups: [],
  },
  {
    name: "windowSort", sql: "SELECT row_number() OVER(ORDER BY 1) AS v",
    params: [], groups: [],
  },
  {
    name: "schemaCast", schema: ["CREATE TABLE t(v TEXT DEFAULT(CAST(42 AS TEXT)))"],
    sql: "INSERT INTO t DEFAULT VALUES RETURNING v", params: [], groups: ["cast"],
  },
  {
    name: "schemaCall", schema: ["CREATE TABLE t(v TEXT DEFAULT(lower('X')) CHECK(length(v)>0))"],
    sql: "INSERT INTO t DEFAULT VALUES RETURNING v", params: [], groups: ["call"],
  },
] satisfies { name: string; schema?: string[]; sql: string; params: Value[]; groups: string[] }[];

test("expression inference traverses schema and unused branches but ignores SQL-looking literals", () => {
  for (const fixture of fixtures)
    assert.deepEqual(
      analyzeCatalogRequirements({ schema: fixture.schema ?? [], queries: [{ name: "q", sql: fixture.sql }] }).expressionGroups,
      fixture.groups, fixture.name,
    );
  const schema = [
    "CREATE TABLE t(v TEXT DEFAULT(lower('X')) CHECK(length(v)>0))",
    "CREATE VIEW vv AS SELECT (SELECT v FROM t) AS v",
  ];
  assert.deepEqual(analyzeCatalogRequirements({
    schema, queries: [{ name: "q", sql: "SELECT v FROM t" }],
  }).expressionGroups, ["call", "subquery"]);
  assert.deepEqual(analyzeCatalogRequirements({
    schema: [], queries: [{ name: "q", sql: "SELECT 'lower((SELECT 1))' AS v" }],
  }).expressionGroups, []);
});

test("catalog expression gates remove unused call evaluation and reject incompatible JSON/binary catalogs on JS and Wasm", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sqlike-expressions-"));
  try {
    for (const fixture of fixtures) {
      const catalog: CatalogSource = {
        schema: fixture.schema ?? [], queries: [{ name: "q", sql: fixture.sql }],
      };
      const oracle = new DatabaseSync(":memory:");
      for (const ddl of catalog.schema) oracle.exec(ddl);
      const query = oracle.prepare(fixture.sql);
      query.setReadBigInts(true);
      query.setReturnArrays(true);
      const expected = query.all(...fixture.params);
      oracle.close();
      for (const mode of ["aot", "defined"] as const) {
        const built = await buildSqlikeRuntime(defineSqlike({ mode }), {
          catalog, outDir: join(directory, fixture.name, mode), minify: false,
        });
        assert.deepEqual(built.requirements!.expressionGroups, fixture.groups);
        if (fixture.name === "plain") {
          const code = await readFile(join(built.directory, "runtime.js"), "utf8");
          assert.ok(!/function [^\n]*evaluate__call\(/.test(code), "unused function evaluator");
          assert.ok(!/function [^\n]*cast__value\(/.test(code), "unused CAST evaluator");
          assert.ok(!/function [^\n]*runtime__call__allowed\(/.test(code), "unused function validation dispatcher");
          assert.equal(built.plan.constants.CAP_EXPRESSION_CALL, false);
          assert.equal(built.plan.constants.CAP_EXPRESSION_SUBQUERY, false);
        }
        if (fixture.name === "window")
          assert.equal(built.plan.constants.CAP_EXPRESSION_CALL, true, "window's internal evaluator dependency");
        if (fixture.name === "windowSort") {
          assert.equal(built.plan.constants.CAP_QUERY_ORDER_BY, false, "window ordering is independent of final result ordering");
          const code = await readFile(join(built.directory, "runtime.js"), "utf8");
          assert.match(code, /function [^\n]*sort__query__rows\(/);
        }
        const js = await import(pathToFileURL(join(built.directory, "runtime.js")).href);
        const wasm = (await WebAssembly.instantiate(
          await readFile(join(built.directory, "runtime.wasm")), {},
          { builtins: ["js-string"], importedStringConstants: "_" },
        )).instance.exports;
        for (const [i, raw] of [js, wasm].entries()) {
          const open = async (source: CatalogSource) => mode === "aot"
            ? openCompiled(raw, buildCatalog(source).artifact)
            : await createDefinedDatabase(i === 0 ? raw : definedWasm(raw)).memory(buildDefinedCatalog(source));
          const db = await open(catalog);
          try {
            assert.deepEqual((await db.execute("q", fixture.params)).rows, expected, `${fixture.name}/${mode}/${i}`);
          } finally {
            if ("close" in db && typeof db.close === "function") await db.close();
          }
          if (fixture.name === "window") {
            // The window feature closes over call support even though this
            // fixture has no Call node. Verify the emitted constant, too.
            const reused = await open({
              schema: [], queries: [{ name: "q", sql: "SELECT count(*) AS v" }],
            });
            try {
              assert.deepEqual((await reused.execute("q")).rows, [[1n]]);
            } finally {
              if ("close" in reused && typeof reused.close === "function") await reused.close();
            }
          }
          if (fixture.name !== "plain") continue;
          for (const other of fixtures.filter((f) => f.groups.length))
            await assert.rejects(open({
              schema: other.schema ?? [], queries: [{ name: "q", sql: other.sql }],
            }), /catalog capability disabled: expression/);
        }
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
