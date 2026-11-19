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

test("IN SELECT cache is optional across AOT/binary JS/Wasm and never survives rebind or restore", async () => {
  const source = {
    schema: [
      "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER,s TEXT COLLATE NOCASE)",
      "CREATE TABLE r(n INTEGER,s TEXT COLLATE NOCASE)",
    ],
    queries: [
      {
        name: "seed",
        sql: "INSERT INTO t VALUES(1,1,'A'),(2,2,'B'),(3,NULL,NULL)",
      },
      { name: "seedr", sql: "INSERT INTO r VALUES(1,'a'),(2,'b'),(NULL,NULL)" },
      {
        name: "read",
        sql: "SELECT id,n IN(SELECT n FROM r WHERE n<>?1),(n,s) IN(SELECT n,s FROM r WHERE n<>?1) FROM t ORDER BY id",
      },
      {
        name: "correlated",
        sql: "SELECT id,n IN(SELECT n FROM r WHERE r.n=t.n AND r.n<>?1) FROM t ORDER BY id",
      },
      { name: "change", sql: "UPDATE r SET n=9 WHERE n=1" },
    ],
  };
  const dir = await mkdtemp(join(tmpdir(), "sqlike-in-select-"));
  try {
    for (const mode of ["aot", "defined"] as const)
      for (const enabled of [false, true]) {
        const built = await buildSqlikeRuntime(defineSqlike({ mode }), {
          catalog: source,
          outDir: join(dir, `${mode}-${enabled}`),
          optimizers: enabled ? ["inSelectLookup"] : [],
          minify: false,
        });
        assert.equal(built.plan.constants.OPT_IN_SELECT_LOOKUP, enabled);
        assert.equal(built.plan.constants.CAP_QUERY_IN_SELECT, true);
        if (!enabled)
          assert.doesNotMatch(
            await readFile(join(built.directory, "runtime.js"), "utf8"),
            /function [^\n]*(?:in__select__lookup|prepare__in__select)\(/,
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
          const catalog = buildDefinedCatalog(source),
            DB = createDefinedDatabase(i === 0 ? raw : definedWasm(raw));
          const db =
              mode === "aot"
                ? openCompiled(raw, buildCatalog(source).artifact)
                : await DB.memory(catalog),
            native = new NodeDatabase(":memory:");
          try {
            source.schema.forEach((q) => native.raw.exec(q));
            for (const name of ["seed", "seedr"]) {
              native.raw.exec(source.queries.find((q) => q.name === name)!.sql);
              await db.execute(name);
            }
            const image = "dump" in db ? db.dump() : await db.snapshot();
            for (let round = 0; round < 2; round++) {
              for (const name of ["read", "correlated"])
                for (const params of [[0n], [1n], [2n], [null]])
                  assert.deepEqual(
                    (await db.execute(name, params)).rows,
                    nativeValues(
                      native,
                      source.queries.find((q) => q.name === name)!.sql,
                      params,
                    ),
                  );
              if (round === 0) {
                native.raw.exec(
                  source.queries.find((q) => q.name === "change")!.sql,
                );
                await db.execute("change");
              }
            }
            if ("restore" in db) {
              db.restore(image as string);
              assert.deepEqual(db.execute("read", [0n]).rows, [
                [1n, 1n, 1n],
                [2n, 1n, 1n],
                [3n, null, null],
              ]);
            } else {
              const restored = await DB.memory(catalog, {
                image: image as Uint8Array,
              });
              try {
                assert.deepEqual((await restored.execute("read", [0n])).rows, [
                  [1n, 1n, 1n],
                  [2n, 1n, 1n],
                  [3n, null, null],
                ]);
              } finally {
                await restored.close();
              }
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
