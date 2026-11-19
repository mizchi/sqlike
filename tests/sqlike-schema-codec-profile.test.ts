import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { parseAst } from "vite";
import { buildSqlikeRuntime } from "../scripts/build-sqlike-runtime.ts";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import { buildDefinedCatalog } from "../scripts/defined-compiler.ts";
import { defineSqlike } from "../src/sqlike-features.ts";
import { openCompiled } from "../src/sqlike-runtime.ts";
import { createDefinedDatabase } from "../adapters/defined-database-core.ts";
import { definedWasm } from "../adapters/defined-wasm.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "./compatibility/native-values.ts";
import type { CatalogSource } from "../src/aot-contract.ts";

const plain: CatalogSource = {
  schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY)"],
  queries: [{ name: "q", sql: "SELECT 1" }],
};
const optional: CatalogSource = {
  schema: [
    "CREATE TABLE p(a INTEGER,b INTEGER,PRIMARY KEY(a,b))",
    "CREATE TABLE c(id INTEGER PRIMARY KEY,a INTEGER,b INTEGER,FOREIGN KEY(a,b) REFERENCES p(a,b) ON DELETE CASCADE ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED)",
    "CREATE TABLE log(v INTEGER)",
    "CREATE TRIGGER tr AFTER INSERT ON c WHEN NEW.id>0 BEGIN INSERT INTO log VALUES(NEW.id); END",
  ],
  queries: [
    { name: "begin", sql: "BEGIN" },
    { name: "parent", sql: "INSERT INTO p VALUES(1,2)" },
    { name: "child", sql: "INSERT INTO c VALUES(3,1,2)" },
    { name: "change", sql: "UPDATE p SET b=4 WHERE a=1" },
    { name: "read", sql: "SELECT id,a,b FROM c" },
    { name: "log", sql: "SELECT v FROM log" },
    { name: "remove", sql: "DELETE FROM p" },
    { name: "empty", sql: "SELECT id FROM c" },
    { name: "commit", sql: "COMMIT" },
  ],
};

test("FK and trigger codecs disappear when disabled, retain wire semantics when enabled on JS/Wasm", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sqlike-schema-codecs-"));
  try {
    for (const source of [plain, optional]) for (const mode of ["aot", "defined"] as const) {
      const built = await buildSqlikeRuntime(defineSqlike({ mode }), {
        catalog: source, outDir: join(dir, source === plain ? "plain" : "optional", mode), minify: false,
      });
      if (source === plain) {
        const code = await readFile(join(built.directory, "runtime.js"), "utf8");
        for (const node of parseAst(code).body) {
          if (node.type !== "FunctionDeclaration") continue;
          const name = node.id?.name ?? "";
          if (/(ForeignKey|TriggerDefinition).*FromJson/.test(name))
            assert.ok(node.end - node.start < 1200, `disabled codec still decodes fields: ${name}`);
          if (/(Selection|Table|SchemaObject).*FromJson/.test(name))
            assert.ok(node.end - node.start < 9000, `derived struct decoder retains avoidable bookkeeping: ${name}`);
        }
        assert.ok(!code.includes("function json__decode__foreign__key("));
        assert.ok(!/function [^\n]*json__decode__(?:foreign__key|trigger__definition)\(/.test(code));
        assert.ok(!/function [^\n]*(?:simple__relation|prepare__point|execute__bound__point)(?:_2einner)?\(/.test(code),
          "FROM-free catalog retains table access optimizers");
      }
      const js = await import(pathToFileURL(join(built.directory, "runtime.js")).href);
      const wasm = (await WebAssembly.instantiate(await readFile(join(built.directory, "runtime.wasm")), {},
        { builtins: ["js-string"], importedStringConstants: "_" })).instance.exports;
      for (const [i, raw] of [js, wasm].entries()) {
        const open = async (catalog: CatalogSource) => mode === "aot"
          ? openCompiled(raw, buildCatalog(catalog).artifact)
          : createDefinedDatabase(i ? definedWasm(raw) : raw).memory(buildDefinedCatalog(catalog));
        const db = await open(source);
        const native = new NodeDatabase(":memory:");
        try {
          native.raw.exec("PRAGMA foreign_keys=ON");
          for (const ddl of source.schema) native.raw.exec(ddl);
          for (const q of source.queries) {
            if (native.raw.prepare(q.sql).columns().length)
              assert.deepEqual((await db.execute(q.name)).rows, nativeValues(native, q.sql));
            else {
              native.raw.exec(q.sql);
              await db.execute(q.name);
            }
          }
        } finally {
          native.close();
          if ("close" in db && typeof db.close === "function") await db.close();
        }
        if (source === plain) await assert.rejects(open(optional), /feature disabled|required feature mismatch/);
      }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
