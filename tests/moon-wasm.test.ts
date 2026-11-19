import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  MoonDatabase,
  type MoonSqlRuntime,
} from "../adapters/moon-database.ts";
import { compatibilityCorpus } from "./compatibility/corpus.ts";
import {
  differentialCase,
  compatibilityError,
  type CompatibilityDriver,
} from "./compatibility/contract.ts";
import { sqliteOracle } from "./compatibility/oracle.ts";
import { bootstrapSafety, observeSQL } from "../src/safety.ts";
import { packResult, unpack, parseStatements } from "../src/protocol.ts";

test("the same MoonBit SQL core runs as Wasm GC and matches all 842 oracle steps", async () => {
  const bytes = await readFile("_build/wasm-gc/release/build/mizchi/sqlike/full/full.wasm");
  const { instance, module } = await WebAssembly.instantiate(
    bytes,
    {},
    { builtins: ["js-string"], importedStringConstants: "_" },
  );
  // The GC module has opaque connection references and JS string builtins; it
  // contains the real SQL engine and imports no native database or host parser.
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  const exports = instance.exports as unknown as MoonSqlRuntime;
  const runtime: MoonSqlRuntime = {
    ...exports,
    database_import_sqlite: (db, image) =>
      exports.database_import_sqlite_base64(
        db,
        Buffer.from(image).toString("base64"),
      ),
    database_is_readonly: (sql) => Boolean(exports.database_is_readonly(sql)),
  };
  const db = new MoonDatabase(undefined, undefined, runtime);
  const physical = MoonDatabase.fromSQLite(
    new Uint8Array(await readFile("tests/fixtures/ltx/base.sqlite")),
    runtime,
  );
  assert.ok(physical.all("SELECT * FROM items").length > 0);
  const oracle = sqliteOracle();
  db.run(
    "CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY NOT NULL,title TEXT NOT NULL,score INTEGER NOT NULL DEFAULT 0,payload BLOB)",
  );
  bootstrapSafety(db, true);
  const candidate: CompatibilityDriver = {
    async execute(statements) {
      try {
        return {
          ok: true,
          effects: db.transaction(() => observeSQL(db, statements)).effects,
        };
      } catch (e) {
        return { ok: false, error: compatibilityError(e) };
      }
    },
    async query(statement) {
      try {
        parseStatements(new TextEncoder().encode(JSON.stringify([statement])));
        return {
          ok: true,
          rows: db
            .query(statement.sql, statement.params.map(unpack))
            .map((r) =>
              Object.fromEntries(
                Object.entries(r).map(([k, v]) => [k, packResult(v)]),
              ),
            ),
        };
      } catch (e) {
        return { ok: false, error: compatibilityError(e) };
      }
    },
  };
  try {
    let steps = 0;
    for (const entry of compatibilityCorpus())
      steps += await differentialCase(entry, oracle, candidate);
    assert.equal(steps, 842);
  } finally {
    oracle.close();
  }
});
