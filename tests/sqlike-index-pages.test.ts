import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as js from "../_build/js/release/build/mizchi/sqlike/sqlike.js";
import { openSql } from "../src/sqlike-runtime.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "./compatibility/native-values.ts";

test("large index leaves preserve composite ties, partial membership and rollback on JS/Wasm", async () => {
  const native = new NodeDatabase(":memory:");
  try {
    native.run("CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER CHECK(n>=-10),s TEXT)");
    native.run("CREATE INDEX ix ON t(n DESC,s COLLATE NOCASE)");
    native.run("CREATE INDEX partial ON t(s COLLATE NOCASE) WHERE n>=0");
    native.transaction(() => {
      const insert = native.raw.prepare("INSERT INTO t VALUES(?,?,?)");
      for (let i = 0; i < 10000; i++) insert.run(i + 1, i % 100, i % 2 ? "a" : "A");
    });
    const image = native.raw.serialize();
    const wasm = (await WebAssembly.instantiate(readFileSync(
      "_build/wasm-gc/release/build/mizchi/sqlike/sqlike.wasm"), {},
      { builtins: ["js-string"], importedStringConstants: "_" })).instance.exports as unknown as typeof js;
    const databases = [js, wasm].map(runtime => {
      const handle = runtime.database_open();
      assert.equal(runtime.database_import_sqlite_base64(handle, Buffer.from(image).toString("base64")), "{}");
      return openSql(runtime, runtime.database_dump(handle), { statementCache: { capacity: 8 } });
    });
    const check = () => {
      for (const sql of [
        "SELECT id,n,s FROM t WHERE n>=48 AND n<51 ORDER BY n DESC,s COLLATE NOCASE",
        "SELECT id,s FROM t WHERE n>=0 ORDER BY s COLLATE NOCASE LIMIT 20 OFFSET 7",
        "SELECT id,n FROM t ORDER BY id LIMIT 20",
      ]) for (const db of databases) assert.deepEqual(db.values(sql), nativeValues(native, sql), sql);
    };
    const run = (sql: string) => { native.run(sql); for (const db of databases) db.run(sql); };
    try {
      check();
      run("UPDATE t SET n=100000,s='z' WHERE id=1");
      run("UPDATE t SET n=-1 WHERE id=9000");
      check();
      run("BEGIN"); run("UPDATE t SET n=49 WHERE id=9000"); check(); run("ROLLBACK"); check();
      for (const db of [native, ...databases]) assert.throws(() => db.run("UPDATE t SET n=-11 WHERE id IN (1,2)"));
      check();
      run("DELETE FROM t WHERE id%2=0"); check();
    } finally { databases.forEach(db => db.close()); }
  } finally { native.close(); }
});
