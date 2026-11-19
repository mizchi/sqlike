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
import { openCompiled } from "../src/sqlike-runtime.ts";
import { createDefinedDatabase } from "../adapters/defined-database-core.ts";
import { definedWasm } from "../adapters/defined-wasm.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "./compatibility/native-values.ts";

test("UPDATE FROM slots and fallback preserve lazy CASE, NOCASE, BLOB, shadowed rowid and int64", async () => {
  const source = {
    schema: [
      "CREATE TABLE t(id INTEGER PRIMARY KEY,n REAL,word TEXT,b BLOB)",
      "CREATE TABLE s(id INTEGER PRIMARY KEY,n REAL,word TEXT COLLATE NOCASE,b BLOB,rowid INTEGER)",
    ],
    queries: [
      {
        name: "t",
        sql: "INSERT INTO t VALUES(1,10,'old',x'ff'),(2,20,'old',NULL),(9007199254740993,30,'old',x'')",
      },
      {
        name: "s",
        sql: "INSERT INTO s VALUES(1,2.25,'A',x'00ff',21),(2,NULL,'B',x'01',22),(9007199254740993,3.5,'a',NULL,23)",
      },
      {
        name: "q",
        sql: "UPDATE t AS dst SET n=CASE WHEN src.word='a' THEN src.n+?1 ELSE dst.n END,word=CAST(src.oid AS TEXT)||':'||CAST(src.rowid AS TEXT),b=src.b FROM s AS src WHERE src.id=dst.id AND src.n IS NOT NULL RETURNING id,n,word,hex(b)",
      },
      { name: "change", sql: "UPDATE s SET n=n+1,word='b' WHERE id=1" },
    ],
  };
  const dir = await mkdtemp(join(tmpdir(), "sqlike-from-slots-"));
  try {
    for (const mode of ["aot", "defined"] as const)
      for (const enabled of [false, true]) {
        const built = await buildSqlikeRuntime(defineSqlike({ mode }), {
          catalog: source,
          outDir: join(dir, `${mode}-${enabled}`),
          optimizers: enabled ? ["updateFromLookup"] : [],
          minify: false,
        });
        if (!enabled)
          assert.doesNotMatch(
            await readFile(join(built.directory, "runtime.js"), "utf8"),
            /function [^\n]*prepare__update__from__slots\(/,
          );
        const js = await import(
            pathToFileURL(join(built.directory, "runtime.js")).href
          ),
          wasm = (
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
                : await createDefinedDatabase(
                    i === 0 ? raw : definedWasm(raw),
                  ).memory(buildDefinedCatalog(source)),
            native = new NodeDatabase(":memory:");
          try {
            source.schema.forEach((q) => native.raw.exec(q));
            for (const name of ["t", "s"]) {
              native.raw.exec(source.queries.find((q) => q.name === name)!.sql);
              await db.execute(name);
            }
            for (const params of [[1n], [2.5], [null]]) {
              assert.deepEqual(
                (await db.execute("q", params)).rows,
                nativeValues(
                  native,
                  source.queries.find((q) => q.name === "q")!.sql,
                  params,
                ),
              );
              native.raw.exec(
                source.queries.find((q) => q.name === "change")!.sql,
              );
              await db.execute("change");
            }
          } finally {
            native.close();
            if ("close" in db) await db.close();
          }
        }
      }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
