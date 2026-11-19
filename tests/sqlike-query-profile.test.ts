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
import type { CatalogSource } from "../src/aot-contract.ts";
import type { Value } from "../src/contract.ts";

const fixtures = [
  { name: "plain", sql: "SELECT 1", parts: [] },
  { name: "source", sql: "SELECT x FROM (SELECT 1 AS x)", parts: ["cte", "source"] },
  { name: "order", sql: "SELECT 1 AS x ORDER BY x DESC NULLS FIRST", parts: ["orderBy"] },
  { name: "distinct", sql: "SELECT DISTINCT 1", parts: ["distinct"] },
  { name: "limit", sql: "SELECT 1 LIMIT 1 OFFSET -1", parts: ["limitOffset"] },
  { name: "grouping", sql: "SELECT 1 GROUP BY 1 HAVING 1", parts: ["groupBy"] },
  {
    name: "representative",
    sql: "SELECT x,max(n) FROM(SELECT 1 AS x,2 AS n)",
    parts: ["aggregateRepresentative", "cte", "source"],
  },
  { name: "inSelect", sql: "SELECT 1 IN(SELECT 1)", parts: ["inSelect"] },
  {
    name: "cte",
    sql: "WITH a(x) AS (SELECT 1) SELECT x FROM a",
    parts: ["cte", "source"],
  },
  {
    name: "recursive",
    sql: "WITH RECURSIVE a(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM a WHERE x<3) SELECT x FROM a ORDER BY x",
    parts: ["compound", "cte", "orderBy", "recursiveCte", "source"],
  },
  {
    name: "join",
    sql: "SELECT a.x,b.y FROM (SELECT 1 AS x) a LEFT JOIN (SELECT 2 AS y) b ON a.x<b.y",
    parts: ["cte", "join", "source"],
  },
  {
    name: "compound",
    sql: "SELECT 2 AS x UNION SELECT 1 ORDER BY x",
    parts: ["compound", "orderBy"],
  },
] as const;

test("CTE, recursion, joins and compound SELECTs are independently inferred, removed and validated", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sqlike-query-profile-"));
  const native = new NodeDatabase(":memory:");
  try {
    for (const fixture of fixtures) {
      const catalog = {
        schema: [],
        queries: [{ name: "q", sql: fixture.sql }],
      };
      for (const mode of ["aot", "defined"] as const) {
        const built = await buildSqlikeRuntime(defineSqlike({ mode }), {
          catalog,
          outDir: join(dir, fixture.name, mode),
          minify: false,
        });
        assert.deepEqual(
          built.requirements?.queryParts,
          fixture.parts,
          fixture.name,
        );
        const code = await readFile(
          join(built.directory, "runtime.js"),
          "utf8",
        );
        if (fixture.name === "plain")
          assert.ok(
            !/function [^\n]*validate__group__output\(/.test(code),
            `${mode}: aggregate output validation remains in plain SELECT`,
          );
        for (const [part, symbols] of Object.entries({
          cte: ["execute__cte", "prepare__cte"],
          recursiveCte: ["execute__recursive__cte"],
          join: ["using__row", "using__pairs"],
          compound: ["compound__relation", "compound__order__index"],
          inSelect: ["in__select__lookup", "row__in__select"],
          aggregateRepresentative: ["aggregate__representative__row"],
          source: ["source__rows", "empty__source", "json__decode__source"],
          orderBy: ["sort__query__rows"],
        }))
          if (!(fixture.parts as readonly string[]).includes(part))
            for (const symbol of symbols)
              assert.ok(
                !code
                  .split("\n")
                  .some(
                    (line) =>
                      line.startsWith("function ") &&
                      line.includes(symbol + "("),
                  ),
                `${fixture.name}: ${symbol}`,
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
          const open = async (source: typeof catalog) =>
            mode === "aot"
              ? openCompiled(raw, buildCatalog(source).artifact)
              : await createDefinedDatabase(
                  i === 0 ? raw : definedWasm(raw),
                ).memory(buildDefinedCatalog(source));
          const db = await open(catalog);
          try {
            assert.deepEqual(
              (await db.execute("q")).rows,
              nativeValues(native, fixture.sql),
            );
          } finally {
            if ("close" in db && typeof db.close === "function")
              await db.close();
          }
          for (const other of fixtures) {
            if (
              !other.parts.some(
                (p) => !(fixture.parts as readonly string[]).includes(p),
              )
            )
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
    queries: [
      {
        name: "q",
        sql: "SELECT CASE WHEN 0 THEN (SELECT 1 UNION SELECT 2) ELSE 0 END",
      },
    ],
  };
  assert.deepEqual(analyzeCatalogRequirements(source).queryParts, [
    "compound",
    "cte",
    "source",
  ]);
  assert.deepEqual(analyzeCatalogRequirements({
    schema: ["CREATE TABLE t(v TEXT DEFAULT 'ORDER BY DISTINCT LIMIT FROM')"],
    queries: [{ name: "q", sql: "SELECT 'FROM t ORDER BY v LIMIT 1' AS v" }],
  }).queryParts, []);
  assert.deepEqual(analyzeCatalogRequirements({
    schema: ["CREATE VIEW unused AS SELECT DISTINCT 1 AS v ORDER BY v LIMIT 1 OFFSET 0"],
    queries: [{ name: "q", sql: "SELECT CASE WHEN 0 THEN(SELECT v FROM unused) ELSE 0 END" }],
  }).queryParts, ["distinct", "limitOffset", "orderBy", "source"]);
});

test("source/order/distinct/limit gates preserve collation, NULL order, parameters, EXISTS and compound results", async () => {
  const catalog: CatalogSource = {
    schema: [
      "CREATE TABLE t(v TEXT)",
      "CREATE VIEW limited AS SELECT v FROM t ORDER BY v LIMIT 2",
    ],
    queries: [
      { name: "seed", sql: "INSERT INTO t VALUES('a'),('A'),('b'),(NULL),('c'),('b')" },
      { name: "ordered", sql: "SELECT v FROM t ORDER BY v COLLATE NOCASE DESC NULLS FIRST LIMIT ? OFFSET ?" },
      { name: "distinct", sql: "SELECT DISTINCT v COLLATE NOCASE FROM t ORDER BY 1 LIMIT ? OFFSET ?" },
      { name: "exists", sql: "SELECT EXISTS(SELECT DISTINCT v FROM t ORDER BY v LIMIT ? OFFSET ?)" },
      { name: "compound", sql: "SELECT v FROM t UNION ALL SELECT v FROM t ORDER BY 1 LIMIT ? OFFSET ?" },
      { name: "view", sql: "SELECT v FROM limited" },
    ],
  };
  const directory = await mkdtemp(join(tmpdir(), "sqlike-query-shapes-"));
  try {
    for (const mode of ["aot", "defined"] as const) for (const shortcuts of [true, false]) {
      const built = await buildSqlikeRuntime(defineSqlike({ mode }), {
        catalog, outDir: join(directory, mode, String(shortcuts)), optimizers: shortcuts ? undefined : [],
      });
      const js = await import(pathToFileURL(join(built.directory, "runtime.js")).href);
      const wasm = (await WebAssembly.instantiate(await readFile(join(built.directory, "runtime.wasm")), {},
        { builtins: ["js-string"], importedStringConstants: "_" })).instance.exports;
      for (const [i, raw] of [js, wasm].entries()) {
        const native = new NodeDatabase(":memory:");
        const db = mode === "aot" ? openCompiled(raw, buildCatalog(catalog).artifact)
          : await createDefinedDatabase(i ? definedWasm(raw) : raw).memory(buildDefinedCatalog(catalog));
        try {
          for (const ddl of catalog.schema) native.raw.exec(ddl);
          native.raw.exec(catalog.queries[0]!.sql);
          await db.execute("seed");
          for (const q of catalog.queries.slice(1)) {
            const parameters: Value[][] = q.name === "view" ? [[]] : [[2n, 1n], [0n, 0n], [-1n, -5n], [10n, 100n], ["2", "1"]];
            for (const params of parameters)
              assert.deepEqual((await db.execute(q.name, params)).rows, nativeValues(native, q.sql, params), `${mode}/${i}/${q.name}/${params}`);
            if (q.name !== "view") {
              for (const params of [[null, 0n], [1.5, 0n], [1n, "bad"]] satisfies Value[][]) {
                // SQLite rewrites EXISTS's nonzero LIMIT to one, including
                // fractional values. The current subset rejects this input.
                if (q.name === "exists" && params[0] === 1.5) {
                  assert.deepEqual(nativeValues(native, q.sql, params), [[1n]]);
                  await assert.rejects(async () => db.execute(q.name, params), /datatype mismatch/);
                  continue;
                }
                assert.throws(() => nativeValues(native, q.sql, params), /datatype mismatch/);
                await assert.rejects(async () => db.execute(q.name, params), /datatype mismatch/);
              }
            }
          }
        } finally {
          native.close();
          if ("close" in db && typeof db.close === "function") await db.close();
        }
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
