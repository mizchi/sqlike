import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSqlikeRuntime } from "../scripts/build-sqlike-runtime.ts";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import { buildDefinedCatalog } from "../scripts/defined-compiler.ts";
import {
  defineSqlike,
  sqlitePages,
  primaryKeyIndex,
} from "../src/sqlike-features.ts";
import { SqlitePagerClient } from "../src/sqlite-pager.ts";
import { sqlitePagerWasm } from "../src/sqlite-pager-wasm.ts";
import { MemorySqlitePageStore } from "../adapters/sqlite-page-store.ts";
import { definedWasm } from "../adapters/defined-wasm.ts";
import { aotBindings } from "../src/aot-values.ts";

test("incremental pager is optional and parser-free for AOT/binary on JS/Wasm", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sqlike-pager-profile-"));
  const source = {
    schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER,s TEXT)"],
    queries: [
      {
        name: "add",
        sql: "INSERT INTO t VALUES(?1,100,'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')",
      },
      { name: "update", sql: "UPDATE t SET n=101 WHERE id=?1" },
    ],
  };
  const binary = buildDefinedCatalog(source, {
    sqliteExport: true,
    pageSize: 512,
  });
  try {
    for (const mode of ["aot", "defined"] as const)
      for (const enabled of [false, true]) {
        const built = await buildSqlikeRuntime(
          defineSqlike({
            mode,
            features: [primaryKeyIndex, ...(enabled ? [sqlitePages] : [])],
          }),
          {
            catalog: source,
            outDir: join(directory, mode, String(enabled)),
            minify: false,
          },
        );
        const code = await readFile(
          join(built.directory, "runtime.js"),
          "utf8",
        );
        assert.doesNotMatch(code, /function [^\n]*parse__statement\(/);
        assert.equal(/function [^\n]*pager__changes\(/.test(code), enabled);
        if (!enabled) {
          assert.ok(!built.exports.includes("sqlite_pager_open"));
          continue;
        }
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
        for (const raw of [
          js,
          { ...wasm, ...definedWasm(wasm), ...sqlitePagerWasm(wasm) },
        ]) {
          const db =
            mode === "aot"
              ? raw.aot_open(
                  buildCatalog(source, { pageSize: 512 }).artifact,
                  "",
                )
              : raw.defined_open(
                  binary.schema,
                  binary.statements,
                  new Uint8Array(),
                );
          const exec = (q: string, args: bigint[]) => {
            const r = JSON.parse(
              (mode === "aot" ? raw.aot_execute : raw.defined_execute)(
                db,
                q,
                aotBindings(args),
              ),
            );
            assert.equal(r.error, undefined);
          };
          for (let i = 1; i <= 100; i++) exec("add", [BigInt(i)]);
          const store = new MemorySqlitePageStore();
          const client = await SqlitePagerClient.open(raw, store, (p) =>
            mode === "aot"
              ? raw.aot_pager_prepare(db, p)
              : raw.defined_pager_prepare(db, binary.storage!, p),
          );
          assert.equal((await client.flush()).info.snapshot, true);
          exec("update", [50n]);
          const next = await client.flush();
          assert.equal(next.info.snapshot, false);
          assert.equal(next.commit!.pages.length, 2);
          client.close();
        }
      }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
