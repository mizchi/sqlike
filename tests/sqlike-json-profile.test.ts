import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSqlikeRuntime } from "../scripts/build-sqlike-runtime.ts";
import { defineSqlike } from "../src/sqlike-features.ts";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import { buildDefinedCatalog } from "../scripts/defined-compiler.ts";
import { analyzeCatalogRequirements } from "../scripts/analyze-catalog.ts";
import { openCompiled } from "../src/sqlike-runtime.ts";
import { createDefinedDatabase } from "../adapters/defined-database-core.ts";
import { definedWasm } from "../adapters/defined-wasm.ts";
import { compareQueries } from "./compatibility/sqlike-paths.ts";
import type { CatalogSource } from "../src/aot-contract.ts";
import { catalogFunctionConstants } from "../src/catalog-capabilities.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "./compatibility/native-values.ts";
import * as sqlRuntime from "../_build/js/release/build/mizchi/sqlike/full/full.js";

test("flat JSON construction omits SQL JSON parsing, paths, editors and aggregates in AOT/defined JS/Wasm", async () => {
  const source: CatalogSource = {
    schema: [],
    queries: [{ name: "q", sql: "SELECT json_array(?,?),json_object('x',?),json_quote(?)" }],
  };
  const dir = await mkdtemp(join(tmpdir(), "sqlike-json-profile-"));
  try {
    for (const mode of ["aot", "defined"] as const) {
      const built = await buildSqlikeRuntime(defineSqlike({ mode }), {
        catalog: source,
        outDir: join(dir, mode),
        minify: false,
      });
      assert.deepEqual(built.requirements?.functionGroups, ["jsonConstruct"]);
      assert.deepEqual(built.requirements?.queryParts, []);
      const code = await readFile(join(built.directory, "runtime.js"), "utf8");
      for (const symbol of [
        "parse__sql__json",
        "json__path",
        "json__edit",
        "json__merge",
        "json__aggregate",
      ])
        assert.ok(
          !code
            .split("\n")
            .some((line) => line.startsWith("function ") && line.includes(symbol + "(")),
          symbol,
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
        const db =
          mode === "aot"
            ? openCompiled(raw, buildCatalog(source).artifact)
            : await createDefinedDatabase(i === 0 ? raw : definedWasm(raw)).memory(
                buildDefinedCatalog(source),
              );
        try {
          assert.deepEqual((await db.execute("q", ["{}", 1n, "[]", null])).rows, [
            ['["{}",1]', '{"x":"[]"}', "null"],
          ]);
        } finally {
          if ("close" in db && typeof db.close === "function") await db.close();
        }
        for (const sql of [
          "SELECT json_array(json_object('x',1))",
          "SELECT CASE WHEN 0 THEN json_extract('{}','$.x') ELSE 1 END",
        ]) {
          const other = { schema: [], queries: [{ name: "q", sql }] };
          if (mode === "aot")
            assert.throws(
              () => openCompiled(raw, buildCatalog(other).artifact),
              /catalog capability disabled/,
            );
          else
            await assert.rejects(
              createDefinedDatabase(i === 0 ? raw : definedWasm(raw)).memory(
                buildDefinedCatalog(other),
              ),
              /catalog capability disabled/,
            );
        }
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("JSON subtype propagation through collations, unary plus and TEXT casts matches SQLite", async () => {
  await compareQueries([
    "SELECT json_array(json('{}') COLLATE BINARY),json_array(+json('{}')),json_array(CAST(json('{}') AS TEXT))",
    "SELECT json_object('x',json_array(1) COLLATE NOCASE),json_quote(+json_array(1))",
    "SELECT json_array(CASE WHEN 1 THEN json('{}') COLLATE BINARY ELSE '{}' END)",
    "SELECT json_group_array(+json_array(1)),json_group_object('x',CAST(json_array(1) AS TEXT))",
    "SELECT json_array(iif(0,'[]',1,json('{}'),'[]')),json_array(nullif(json('{}'),'[]'))",
    "SELECT json_array((SELECT '[]')),json_extract((SELECT json_array(1)),'$[0]')",
  ]);
});

test("ambiguous JSON subtype propagation is explicitly rejected", () => {
  for (const expr of [
    "(SELECT json('{}'))",
    "coalesce((SELECT json('{}')),'[]')",
    "max(json('{}'),'')",
  ]) {
    const sql = `SELECT json_array(${expr})`;
    const result = JSON.parse(
      sqlRuntime.database_query_values(sqlRuntime.database_open(), sql, "[]"),
    );
    assert.match(result.error, /unsupported JSON subtype propagation/);
    assert.throws(
      () => buildCatalog({ schema: [], queries: [{ name: "q", sql }] }),
      /unsupported JSON subtype propagation/,
    );
  }
});

test("JSON patch parses its target before a NULL patch, matching SQLite error precedence", async () => {
  await compareQueries(["SELECT json_patch(NULL,'bad'),json_patch('{}',NULL)"]);
  const source = { schema: [], queries: [{ name: "q", sql: "SELECT json_patch(?,?)" }] };
  const native = new NodeDatabase(":memory:");
  const dir = await mkdtemp(join(tmpdir(), "sqlike-json-patch-null-"));
  try {
    assert.throws(
      () => nativeValues(native, source.queries[0]!.sql, ["bad", null]),
      /malformed JSON/,
    );
    for (const mode of ["aot", "defined"] as const) {
      const built = await buildSqlikeRuntime(defineSqlike({ mode }), {
        catalog: source,
        outDir: join(dir, mode),
      });
      const js = await import(pathToFileURL(join(built.directory, "runtime.js")).href);
      const wasm = (
        await WebAssembly.instantiate(
          await readFile(join(built.directory, "runtime.wasm")),
          {},
          { builtins: ["js-string"], importedStringConstants: "_" },
        )
      ).instance.exports;
      for (const [i, raw] of [js, wasm].entries()) {
        const db =
          mode === "aot"
            ? openCompiled(raw, buildCatalog(source).artifact)
            : await createDefinedDatabase(i === 0 ? raw : definedWasm(raw)).memory(
                buildDefinedCatalog(source),
              );
        try {
          await assert.rejects(async () => db.execute("q", ["bad", null]), /malformed JSON/);
        } finally {
          if ("close" in db && typeof db.close === "function") await db.close();
        }
      }
    }
  } finally {
    native.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("each JSON family retains native results with the other JSON implementations removed", async () => {
  const fixtures: Record<
    Extract<keyof typeof catalogFunctionConstants, `json${string}`>,
    string
  > = {
    jsonNormalize: "SELECT json(' {\"a\":1} '),json_valid('[]'),json_valid('x')",
    jsonConstruct: "SELECT json_array(1,'[]'),json_object('x',1),json_quote('x')",
    jsonRead: "SELECT json_extract('{\"x\":[1]}','$.x'),json_type('null'),json_array_length('[1]')",
    jsonArrow: "SELECT '{\"x\":[1]}'->'x','{\"x\":\"a\"}'->>'x'",
    jsonEdit:
      "SELECT json_set('{}','$.x',1),json_insert('[1]','$[#]',2),json_replace('[1]','$[0]',2),json_remove('{\"x\":1}','$.x')",
    jsonPatch: 'SELECT json_patch(\'{"a":1,"b":2}\',\'{"a":null,"b":3}\')',
    jsonAggregate: "SELECT json_group_array(1),json_group_object('x',2)",
  };
  const dir = await mkdtemp(join(tmpdir(), "sqlike-json-families-"));
  const native = new NodeDatabase(":memory:");
  try {
    for (const [name, sql] of Object.entries(fixtures)) {
      const source = { schema: [], queries: [{ name: "q", sql }] };
      for (const mode of ["aot", "defined"] as const) {
        const built = await buildSqlikeRuntime(defineSqlike({ mode }), {
          catalog: source,
          outDir: join(dir, name, mode),
        });
        assert.deepEqual(built.requirements?.functionGroups, [name]);
        const js = await import(pathToFileURL(join(built.directory, "runtime.js")).href);
        const wasm = (
          await WebAssembly.instantiate(
            await readFile(join(built.directory, "runtime.wasm")),
            {},
            { builtins: ["js-string"], importedStringConstants: "_" },
          )
        ).instance.exports;
        for (const [i, raw] of [js, wasm].entries()) {
          const db =
            mode === "aot"
              ? openCompiled(raw, buildCatalog(source).artifact)
              : await createDefinedDatabase(i === 0 ? raw : definedWasm(raw)).memory(
                  buildDefinedCatalog(source),
                );
          try {
            assert.deepEqual(
              (await db.execute("q")).rows,
              nativeValues(native, sql),
              `${name}/${mode}/${i}`,
            );
          } finally {
            if ("close" in db && typeof db.close === "function") await db.close();
          }
        }
      }
    }
  } finally {
    native.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("JSON requirements distinguish JSON value arguments from labels and raw document inputs", () => {
  const analyze = (sql: string) =>
    analyzeCatalogRequirements({ schema: [], queries: [{ name: "q", sql }] });
  assert.deepEqual(analyze("SELECT json_object(json_array(1),2)").queryParts, []);
  assert.deepEqual(analyze("SELECT json_array(json_array(1))").queryParts, ["jsonSubtype"]);
  assert.deepEqual(
    analyze("SELECT json_array(CASE WHEN 0 THEN json_array(1) ELSE '[]' END)").queryParts,
    ["jsonSubtype"],
  );
  assert.deepEqual(analyze("SELECT json_extract(json_array(1),'$')").queryParts, []);
  assert.deepEqual(analyze("SELECT json_set('{}','$.x',json_array(1))").queryParts, [
    "jsonSubtype",
  ]);
});

test("nested constructors retain subtype parsing while omitting path, edit, patch and aggregate helpers", async () => {
  const source = {
    schema: [],
    queries: [
      {
        name: "q",
        sql: "SELECT json_array(json_object('x',1)),json_object(json_array(1),json_array(2))",
      },
    ],
  };
  const dir = await mkdtemp(join(tmpdir(), "sqlike-json-nested-"));
  const native = new NodeDatabase(":memory:");
  try {
    for (const mode of ["aot", "defined"] as const) {
      const built = await buildSqlikeRuntime(defineSqlike({ mode }), {
        catalog: source,
        outDir: join(dir, mode),
        minify: false,
      });
      assert.deepEqual(built.requirements?.functionGroups, ["jsonConstruct"]);
      assert.deepEqual(built.requirements?.queryParts, ["jsonSubtype"]);
      const code = await readFile(join(built.directory, "runtime.js"), "utf8");
      assert.match(code, /function [^\n]*parse__sql__json\(/);
      for (const symbol of ["json__path", "json__edit", "json__merge", "json__aggregate"])
        assert.ok(
          !code
            .split("\n")
            .some((line) => line.startsWith("function ") && line.includes(symbol + "(")),
          symbol,
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
        const db =
          mode === "aot"
            ? openCompiled(raw, buildCatalog(source).artifact)
            : await createDefinedDatabase(i === 0 ? raw : definedWasm(raw)).memory(
                buildDefinedCatalog(source),
              );
        try {
          assert.deepEqual(
            (await db.execute("q")).rows,
            nativeValues(native, source.queries[0]!.sql),
          );
        } finally {
          if ("close" in db && typeof db.close === "function") await db.close();
        }
      }
    }
  } finally {
    native.close();
    await rm(dir, { recursive: true, force: true });
  }
});
