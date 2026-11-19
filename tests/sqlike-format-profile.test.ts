import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSqlikeRuntime } from "../scripts/build-sqlike-runtime.ts";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import { buildDefinedCatalog } from "../scripts/defined-compiler.ts";
import { defineSqlike } from "../src/sqlike-features.ts";
import { openCompiled } from "../src/sqlike-runtime.ts";
import { createDefinedDatabase } from "../adapters/defined-database-core.ts";
import { definedWasm } from "../adapters/defined-wasm.ts";

test("format is inferred from IR, removed independently and rejected when absent on JS/Wasm", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sqlike-format-profile-"));
  try {
    for (const mode of ["aot", "defined"] as const) {
      for (const enabled of [false, true]) {
        const catalog = {
          schema: [],
          queries: [
            {
              name: "q",
              sql: enabled
                ? "SELECT format('%04d:%Q',42,'a')"
                : "SELECT length('x')",
            },
          ],
        };
        const built = await buildSqlikeRuntime(defineSqlike({ mode }), {
          catalog,
          outDir: join(directory, mode, String(enabled)),
          minify: false,
        });
        assert.deepEqual(built.requirements?.functionGroups, [
          enabled ? "format" : "length",
        ]);
        const code = await readFile(
          join(built.directory, "runtime.js"),
          "utf8",
        );
        assert.equal(/function [^\n]*format__value\(/.test(code), enabled);
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
        for (const [index, raw] of [js, wasm].entries()) {
          const open = async (source: typeof catalog) =>
            mode === "aot"
              ? openCompiled(raw, buildCatalog(source).artifact)
              : await createDefinedDatabase(
                  index === 0 ? raw : definedWasm(raw),
                ).memory(buildDefinedCatalog(source));
          const db = await open(catalog);
          try {
            assert.deepEqual((await db.execute("q")).rows, [
              [enabled ? "0042:'a'" : 1n],
            ]);
          } finally {
            if ("close" in db && typeof db.close === "function")
              await db.close();
          }
          if (!enabled)
            await assert.rejects(
              open({
                schema: [],
                queries: [
                  {
                    name: "q",
                    sql: "SELECT CASE WHEN 0 THEN format('%d',1) ELSE 1 END",
                  },
                ],
              }),
              /catalog capability disabled/,
            );
        }
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
