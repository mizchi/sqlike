import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as js from "../_build/js/release/build/mizchi/sqlike/sqlike.js";
import { aotBindings, aotValue } from "../src/aot-values.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "./compatibility/native-values.ts";

test("rowid cache deletion preserves reads, rollback, triggers and replicated deltas on JS/Wasm", async () => {
  const wasm = (await WebAssembly.instantiate(readFileSync(
    "_build/wasm-gc/release/build/mizchi/sqlike/sqlike.wasm"), {},
    { builtins: ["js-string"], importedStringConstants: "_" })).instance.exports as unknown as typeof js;
  for (const runtime of [js, wasm]) {
    const native = new NodeDatabase(":memory:");
    native.run("CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)");
    native.run("CREATE INDEX by_n ON t(n,id)");
    native.transaction(() => {
      const insert = native.raw.prepare("INSERT INTO t VALUES(?,?)");
      for (let i = 1; i <= 10000; i++) insert.run(i, i % 17);
    });
    const handle = runtime.database_open();
    assert.equal(runtime.database_import_sqlite_base64(handle,
      Buffer.from(native.raw.serialize()).toString("base64")), "{}");
    const checked = (text: string) => { const r = JSON.parse(text); if (r.error) throw Error(r.error); return r; };
    const db = {
      run: (sql: string, params: bigint[] = []) => checked(runtime.database_exec(handle, sql, aotBindings(params), false)),
      values: (sql: string) => checked(runtime.database_query_values(handle, sql, "[]")).rows.map((row: any[]) => row.map(aotValue)),
    };
    const run = (sql: string, params: bigint[] = []) => { native.run(sql, params); db.run(sql, params); };
    const queries = [
      "SELECT id,n FROM t ORDER BY id LIMIT 20 OFFSET 123",
      "SELECT id,n FROM t ORDER BY id DESC LIMIT 20 OFFSET 123",
      "SELECT id,n FROM t WHERE id>=125 AND id<390 ORDER BY id",
      "SELECT id,n FROM t WHERE n>=5 AND n<12 ORDER BY n DESC,id DESC LIMIT 140 OFFSET 117",
      "SELECT id,n FROM t WHERE n>=5 AND n<12 AND id%3!=0 ORDER BY n DESC,id DESC LIMIT 140 OFFSET 117",
      "SELECT sum(id),count(*) FROM t",
    ];
    const check = () => { for (const sql of queries) assert.deepEqual(db.values(sql), nativeValues(native, sql), sql); };
    try {
      check();
      for (let i = 1; i <= 400; i++) {
        run("DELETE FROM t WHERE id=?", [BigInt(i * 2)]);
        if (i % 127 === 0) check();
      }
      run("UPDATE t SET id=20001 WHERE id=1");
      run("INSERT INTO t VALUES(-3,4),(20002,5)"); check();
      run("BEGIN"); run("SAVEPOINT s");
      run("DELETE FROM t WHERE id>=129 AND id<=513"); check();
      run("ROLLBACK TO s"); check(); run("RELEASE s"); run("ROLLBACK"); check();
      run("CREATE TABLE log(id INTEGER)");
      run("CREATE TRIGGER log_delete AFTER DELETE ON t BEGIN INSERT INTO log VALUES(old.id); END");
      run("CREATE TRIGGER prevent_delete AFTER DELETE ON t WHEN old.id=901 BEGIN SELECT RAISE(ABORT,'blocked'); END");
      check();
      const mirror = runtime.database_clone(handle);
      const serial = runtime.database_serial(handle);
      assert.equal(runtime.database_ack_delta(handle, serial), "{}");
      for (const target of [native, db]) assert.throws(() => target.run("DELETE FROM t WHERE id>=899 AND id<=903"), /blocked/);
      check();
      run("DELETE FROM t WHERE id>=125 AND id<=263 RETURNING id");
      check();
      assert.deepEqual(db.values("SELECT * FROM log ORDER BY id"), nativeValues(native, "SELECT * FROM log ORDER BY id"));
      assert.equal(runtime.database_apply_delta(mirror, runtime.database_delta(handle, false)), "{}");
      assert.equal(runtime.database_dump(mirror), runtime.database_dump(handle));
      run("DROP TRIGGER prevent_delete");
      run("DELETE FROM t WHERE id>7000"); check();
      assert.deepEqual(db.values("SELECT id,n FROM t ORDER BY id"), nativeValues(native, "SELECT id,n FROM t ORDER BY id"));
      run("DELETE FROM t"); check();
      run("INSERT INTO t VALUES(-3,1),(0,2),(99999,3)"); check();
    } finally { native.close(); }
  }
});
