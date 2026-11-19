import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as js from "../_build/js/release/build/mizchi/sqlike/full/full.js";
import { openSql } from "../src/sqlike-runtime.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "./compatibility/native-values.ts";

test("cached rowid allocation follows negative IDs, deletion, triggers, rollback and AUTOINCREMENT", async () => {
  const wasm = (await WebAssembly.instantiate(readFileSync(
    "_build/wasm-gc/release/build/mizchi/sqlike/full/full.wasm"), {},
    { builtins: ["js-string"], importedStringConstants: "_" })).instance.exports as unknown as typeof js;
  for (const runtime of [js, wasm]) for (const autoincrement of [false, true]) {
    const db = openSql(runtime, undefined, { statementCache: { capacity: 8 } });
    const native = new NodeDatabase(":memory:");
    try {
      for (const sql of [
        `CREATE TABLE t(id INTEGER PRIMARY KEY ${autoincrement ? "AUTOINCREMENT" : ""},n TEXT UNIQUE)`,
        "INSERT INTO t VALUES(-3,'a'),(-2,'b')", "INSERT INTO t(n) VALUES('c')",
        "DELETE FROM t WHERE n='c'", "INSERT INTO t(n) VALUES('d')",
        "UPDATE t SET id=100 WHERE n='d'", "INSERT INTO t(n) VALUES('e')",
        "DELETE FROM t WHERE n='e'", "BEGIN", "INSERT INTO t(n) VALUES('rolled')", "ROLLBACK",
        "CREATE TRIGGER spawn AFTER INSERT ON t WHEN new.n='parent' BEGIN INSERT INTO t(n) VALUES('child'); END",
        "INSERT INTO t(n) VALUES('parent')", "DELETE FROM t", "INSERT INTO t(n) VALUES('again')",
      ]) {
        native.run(sql); db.run(sql);
        for (const observe of ["SELECT id,n FROM t ORDER BY id", "SELECT changes(),last_insert_rowid()"])
          assert.deepEqual(db.values(observe), nativeValues(native, observe), sql);
      }
      const invalid = "INSERT INTO t(n) VALUES('partial'),('again')";
      assert.throws(() => db.run(invalid)); assert.throws(() => native.run(invalid));
      db.run("INSERT INTO t(n) VALUES('after failure')"); native.run("INSERT INTO t(n) VALUES('after failure')");
      assert.deepEqual(db.values("SELECT id,n FROM t ORDER BY id"), nativeValues(native, "SELECT id,n FROM t ORDER BY id"));
    } finally { db.close(); native.close(); }
  }
});
