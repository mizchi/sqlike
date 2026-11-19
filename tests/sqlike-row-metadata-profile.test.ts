import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSqlikeRuntime } from "../scripts/build-sqlike-runtime.ts";
import { defineSqlike } from "../src/sqlike-features.ts";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import { openCompiled } from "../src/sqlike-runtime.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "./compatibility/native-values.ts";

test("row metadata is optional in AOT and preserves live binds, lazy fields and restored rows", async () => {
  const catalog = {
    schema: [
      "CREATE TABLE t(id INTEGER PRIMARY KEY,s TEXT COLLATE NOCASE,n INTEGER)",
    ],
    queries: [
      {
        name: "seed",
        sql: "INSERT INTO t VALUES(1,'A',-9223372036854775808),(2,'b',NULL),(3,'c',5)",
      },
      {
        name: "scan",
        sql: "SELECT id,(s,n)=(?1,?2) FROM t WHERE (s,id)>(?3,?4) ORDER BY id",
      },
      { name: "point", sql: "SELECT (s,n)=(?1,?2) FROM t WHERE id=?3" },
      { name: "lazy", sql: "SELECT (id,abs(n))<(?1,?2) FROM t WHERE id=1" },
      {
        name: "update",
        sql: "UPDATE t SET n=n+1 WHERE (s,id)>(?1,?2) RETURNING id,n",
      },
    ],
  };
  const dir = await mkdtemp(join(tmpdir(), "sqlike-row-metadata-"));
  try {
    for (const enabled of [false, true]) {
      const built = await buildSqlikeRuntime(defineSqlike({ mode: "aot" }), {
        catalog,
        outDir: join(dir, String(enabled)),
        minify: false,
        optimizers: enabled
          ? ["pointProjection", "rowMetadata"]
          : ["pointProjection"],
      });
      assert.equal(built.plan.constants.OPT_ROW_METADATA, enabled);
      const code = await readFile(join(built.directory, "runtime.js"), "utf8");
      if (!enabled)
        assert.doesNotMatch(code, /function [^\n]*prepare__row__metadata\(/);
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
      for (const raw of [js, wasm]) {
        const native = new NodeDatabase(":memory:"),
          db = openCompiled(raw, buildCatalog(catalog).artifact);
        try {
          catalog.schema.forEach((sql) => native.raw.exec(sql));
          db.execute("seed");
          native.raw.exec(catalog.queries[0]!.sql);
          const before = db.dump();
          for (const [name, params] of [
            ["scan", ["a", -9223372036854775808n, "", 0n]],
            ["scan", ["b", 0n, "A", 1n]],
            ["point", ["a", -9223372036854775808n, 1n]],
            ["point", ["b", null, 2n]],
            ["lazy", [2n, 0n]],
            ["lazy", [0n, 0n]],
            ["update", ["B", 2n]],
          ] as const) {
            const query = catalog.queries.find((q) => q.name === name)!;
            assert.deepEqual(
              db.execute(name, [...params]).rows,
              nativeValues(native, query.sql, [...params]),
            );
          }
          db.restore(before);
          assert.deepEqual(db.execute("point", ["c", 5n, 3n]).rows, [[1n]]);
        } finally {
          native.close();
        }
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
