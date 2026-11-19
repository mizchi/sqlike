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
import { aotBindings, aotValue } from "../src/aot-values.ts";

test("scalar-only IN aggregates do not retain row-value lookup implementations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sqlike-scalar-in-only-"));
  try {
    const catalog = {
      schema: ["CREATE TABLE t(n INTEGER)"],
      queries: [
        { name: "seed", sql: "INSERT INTO t VALUES(1),(2),(NULL)" },
        {
          name: "read",
          sql: `SELECT count(*) FROM t WHERE n IN(${Array(16).fill("?").join(",")})`,
        },
      ],
    };
    const built = await buildSqlikeRuntime(defineSqlike({ mode: "aot" }), {
      catalog,
      outDir: dir,
      minify: false,
      apiCapabilities: [],
    });
    assert.equal(built.plan.constants.FEATURE_ROW_VALUES, false);
    assert.doesNotMatch(
      await readFile(join(dir, "runtime.js"), "utf8"),
      /function [^\n]*(?:row__in__list__values|row__in__list__key|row__in__list__equal)\(/,
    );
    for (const raw of [
      await import(pathToFileURL(join(dir, "runtime.js")).href),
      (
        await WebAssembly.instantiate(
          await readFile(join(dir, "runtime.wasm")),
          {},
          { builtins: ["js-string"], importedStringConstants: "_" },
        )
      ).instance.exports,
    ]) {
      const program = buildCatalog(catalog).artifact,
        db = raw.aot_open(program, "");
      assert.equal(JSON.parse(raw.aot_info(db)).error, undefined);
      assert.equal(
        JSON.parse(raw.aot_execute(db, "seed", "[]")).error,
        undefined,
      );
      const result = JSON.parse(
        raw.aot_execute(db, "read", aotBindings(Array(16).fill(1n))),
      );
      assert.equal(result.error, undefined);
      assert.equal(aotValue(result.rows[0][0]), 1n);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("IN lookup is removable in AOT/binary and rebuilds after each execution and restore", async () => {
  const parameters = Array.from({ length: 32 }, (_, i) => `?${i + 1}`).join(
    ",",
  );
  const tuples = Array.from(
    { length: 16 },
    (_, i) => `(?${i * 2 + 1},?${i * 2 + 2})`,
  ).join(",");
  const catalog = {
    schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)"],
    queries: [
      { name: "seed", sql: "INSERT INTO t VALUES(1,1),(2,2),(3,NULL)" },
      { name: "read", sql: `SELECT id,n IN(${parameters}) FROM t ORDER BY id` },
      {
        name: "rows",
        sql: `SELECT id,(n,id) IN(${tuples}) FROM t ORDER BY id`,
      },
      { name: "change", sql: "UPDATE t SET n=99 WHERE id=1" },
      {
        name: "row_stats",
        sql: `SELECT count(*),sum(id) FROM t WHERE (n,id) IN(${tuples})`,
      },
      {
        name: "stats",
        sql: `SELECT count(*),count(n),sum(n),avg(n),total(n) FROM t WHERE n IN(${parameters})`,
      },
    ],
  };
  const dir = await mkdtemp(join(tmpdir(), "sqlike-in-lookup-"));
  try {
    for (const mode of ["aot", "defined"] as const)
      for (const enabled of [false, true]) {
        const built = await buildSqlikeRuntime(defineSqlike({ mode }), {
          catalog,
          outDir: join(dir, `${mode}-${enabled}`),
          minify: false,
          optimizers: enabled
            ? ["aggregateScan", "inListLookup"]
            : ["aggregateScan"],
        });
        assert.equal(built.plan.constants.OPT_IN_LIST_LOOKUP, enabled);
        if (!enabled)
          assert.doesNotMatch(
            await readFile(join(built.directory, "runtime.js"), "utf8"),
            /function [^\n]*(?:in__list__lookup|prepare__in__lists|in__list__aggregate__filter)\(/,
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
          const source = buildDefinedCatalog(catalog),
            DB = createDefinedDatabase(i === 0 ? raw : definedWasm(raw));
          const db =
            mode === "aot"
              ? openCompiled(raw, buildCatalog(catalog).artifact)
              : await DB.memory(source);
          try {
            await db.execute("seed");
            assert.deepEqual(
              (await db.execute("row_stats", Array(32).fill(1n))).rows,
              [[1n, 1n]],
            );
            assert.deepEqual(
              (await db.execute("row_stats", Array(32).fill(null))).rows,
              [[0n, null]],
            );
            assert.deepEqual(
              (await db.execute("stats", Array(32).fill(1n))).rows,
              [[1n, 1n, 1n, 1, 1]],
            );
            assert.deepEqual(
              (await db.execute("stats", Array(32).fill(null))).rows,
              [[0n, 0n, null, null, 0]],
            );
            assert.deepEqual(
              (await db.execute("read", Array(32).fill(1n))).rows,
              [
                [1n, 1n],
                [2n, 0n],
                [3n, null],
              ],
            );
            assert.deepEqual(
              (await db.execute("read", Array(32).fill(2n))).rows,
              [
                [1n, 0n],
                [2n, 1n],
                [3n, null],
              ],
            );
            assert.deepEqual(
              (await db.execute("rows", Array(32).fill(1n))).rows,
              [
                [1n, 1n],
                [2n, 0n],
                [3n, 0n],
              ],
            );
            assert.deepEqual(
              (
                await db.execute(
                  "rows",
                  Array.from({ length: 32 }, (_, i) => (i % 2 ? 3n : null)),
                )
              ).rows,
              [
                [1n, 0n],
                [2n, 0n],
                [3n, null],
              ],
            );
            if ("dump" in db) {
              const image = db.dump();
              db.execute("change");
              assert.deepEqual(db.execute("read", Array(32).fill(1n)).rows, [
                [1n, 0n],
                [2n, 0n],
                [3n, null],
              ]);
              db.restore(image);
              assert.deepEqual(db.execute("read", Array(32).fill(1n)).rows, [
                [1n, 1n],
                [2n, 0n],
                [3n, null],
              ]);
            } else {
              const image = await db.snapshot();
              await db.execute("change");
              const restored = await DB.memory(source, { image });
              try {
                assert.deepEqual(
                  (await restored.execute("read", Array(32).fill(1n))).rows,
                  [
                    [1n, 1n],
                    [2n, 0n],
                    [3n, null],
                  ],
                );
              } finally {
                await restored.close();
              }
            }
          } finally {
            if ("close" in db) await db.close();
          }
        }
      }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
