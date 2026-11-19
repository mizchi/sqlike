import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as js from "../_build/js/release/build/mizchi/sqlike/full/full.js";
import { openSql } from "../src/sqlike-runtime.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "./compatibility/native-values.ts";
import { aotBindings } from "../src/aot-values.ts";

const wasm = (await WebAssembly.instantiate(readFileSync(
  "_build/wasm-gc/release/build/mizchi/sqlike/full/full.wasm",
), {}, { builtins: ["js-string"], importedStringConstants: "_" })).instance.exports as unknown as typeof js;

for (const [target, runtime] of [["js", js], ["wasm", wasm]] as const) {
  test(`SQL cache bounds entries/text, refreshes LRU and remains opt-in (${target})`, () => {
    const prepared: string[] = [];
    const tracked = { ...runtime, database_prepare(db: ReturnType<typeof js.database_open>, sql: string) {
      prepared.push(sql);
      return runtime.database_prepare(db, sql);
    } };
    const cold = openSql<ReturnType<typeof runtime.database_open>>(tracked);
    cold.values("SELECT 1"); cold.values("SELECT 1");
    assert.equal(prepared.length, 0);
    cold.close();
    const db = openSql(tracked, undefined, { statementCache: { capacity: 2, maxSqlBytes: 40 } });
    for (const sql of ["SELECT 1", "SELECT 2", "SELECT 1", "SELECT 3", "SELECT 2"])
      db.values(sql);
    assert.deepEqual(prepared, ["SELECT 1", "SELECT 2", "SELECT 3", "SELECT 2"]);
    const large = "SELECT '" + "x".repeat(50) + "'";
    db.values(large); db.values(large);
    assert.equal(prepared.length, 4);
    db.close();
    const byteBound = openSql(tracked, undefined, { statementCache: { capacity: 3, maxSqlBytes: 20 } });
    for (const sql of ["SELECT 1", "SELECT 2", "SELECT 1"]) byteBound.values(sql);
    assert.deepEqual(prepared.slice(4), ["SELECT 1", "SELECT 2", "SELECT 1"]);
    byteBound.close();
    assert.throws(() => db.values("SELECT 1"), /closed/);
    assert.throws(() => openSql(tracked, undefined, { statementCache: { capacity: 257 } }), /cache/i);
    for (const capacity of [undefined, null, -1, 0.5, NaN, Infinity])
      assert.throws(() => openSql(tracked, undefined, { statementCache: { capacity: capacity as number } }), /cache/i);
    for (const maxSqlBytes of [null, 0, -1, 0.5, Infinity, 4194305])
      assert.throws(() => openSql(tracked, undefined, { statementCache: { capacity: 1, maxSqlBytes: maxSqlBytes as number } }), /cache/i);
  });

  test(`cached plans follow binding types, DDL ABA, host rollback and live counters (${target})`, () => {
    const db = openSql(runtime, undefined, { statementCache: { capacity: 8 } });
    const native = new NodeDatabase(":memory:");
    const run = (sql: string) => { native.run(sql); db.run(sql); };
    const compare = (sql: string, params: Parameters<typeof db.values>[1] = []) =>
      assert.deepEqual(db.values(sql, params), nativeValues(native, sql, params), sql);
    try {
      run("CREATE TABLE t(id INTEGER PRIMARY KEY,n REAL CHECK(n>=0),label TEXT UNIQUE)");
      run("INSERT INTO t VALUES(1,1,'one'),(2,2,'two')");
      const q = "SELECT id,n,label,typeof(n) FROM t WHERE id=?";
      for (const value of [1n, 2, "1", null, Uint8Array.of(49), 2n]) compare(q, [value]);
      compare("UPDATE t SET n=n+? WHERE id=? RETURNING id,n,n AS id", [1n, 1n]);
      assert.throws(() => db.values("UPDATE t SET n=-1 RETURNING id"));
      assert.throws(() => native.run("UPDATE t SET n=-1 RETURNING id"));
      compare("SELECT changes(),last_insert_rowid()");
      compare(q, [1n]);
      assert.throws(() => db.query("UPDATE t SET n=7"), /read-only/);
      compare(q, [1n]);
      run("BEGIN"); run("ALTER TABLE t ADD COLUMN b TEXT DEFAULT 'old'");
      compare("SELECT * FROM t WHERE id=?", [1n]);
      run("ROLLBACK"); run("ALTER TABLE t ADD COLUMN c TEXT DEFAULT 'new'");
      compare("SELECT * FROM t WHERE id=?", [1n]);
      assert.throws(() => db.transaction(() => {
        db.values(q, [1n]); db.run("UPDATE t SET n=99 WHERE id=1"); throw Error("rollback");
      }), /rollback/);
      compare(q, [1n]);
      db.transaction(() => {
        assert.throws(() => db.savepoint(() => {
          db.run("UPDATE t SET n=55 WHERE id=1"); throw Error("nested");
        }), /nested/);
        compare(q, [1n]);
      });
    } finally { db.close(); native.close(); }
  });

  test(`low-level prepared SQL observes a restored schema with the same cookie (${target})`, () => {
    const db = runtime.database_open(), other = runtime.database_open();
    const exec = (db: ReturnType<typeof js.database_open>, sql: string) => {
      const r = JSON.parse(runtime.database_exec(db, sql, "[]", false));
      assert.equal(r.error, undefined);
    };
    exec(db, "CREATE TABLE t(id INTEGER PRIMARY KEY,n TEXT)");
    exec(db, "INSERT INTO t VALUES(1,'old')");
    exec(other, "CREATE TABLE t(n TEXT,id INTEGER PRIMARY KEY)");
    exec(other, "INSERT INTO t VALUES('new',1)");
    assert.equal(runtime.database_version(db), runtime.database_version(other));
    const query = runtime.database_prepare(db, "SELECT n FROM t WHERE id=?");
    const params = aotBindings([1n]);
    assert.match(runtime.database_prepared_exec(query, params, true, true), /old/);
    assert.equal(runtime.database_restore(db, runtime.database_dump(other)), "{}");
    assert.match(runtime.database_prepared_exec(query, params, true, true), /new/);
    const clockSql = "SELECT CURRENT_TIMESTAMP,changes(),last_insert_rowid()";
    const clock = runtime.database_prepare(db, clockSql);
    const observed = [];
    for (const millis of ["0", "1000000000000"]) {
      assert.equal(runtime.database_set_clock(db, millis), "{}");
      const result = runtime.database_prepared_exec(clock, "[]", true, true);
      assert.deepEqual(JSON.parse(result), JSON.parse(runtime.database_query_values(db, clockSql, "[]")));
      observed.push(result);
    }
    assert.notEqual(observed[0], observed[1]);
  });

  test(`cached UPDATE retains FK, trigger, no-op effects and failed-write state (${target})`, () => {
    const cached = openSql(runtime, undefined, { statementCache: { capacity: 8 } });
    const plain = openSql(runtime);
    const native = new NodeDatabase(":memory:");
    try {
      for (const sql of [
        "CREATE TABLE p(id INTEGER PRIMARY KEY,n INTEGER CHECK(n>=0))",
        "CREATE TABLE c(id INTEGER PRIMARY KEY,pid INTEGER REFERENCES p(id) ON UPDATE CASCADE)",
        "CREATE TABLE log(id INTEGER PRIMARY KEY,n INTEGER)",
        "CREATE TRIGGER audit AFTER UPDATE ON p BEGIN INSERT INTO log(n) VALUES(new.n); END",
        "INSERT INTO p VALUES(1,1)", "INSERT INTO c VALUES(1,1)",
      ]) for (const db of [native, plain, cached]) db.run(sql);
      const query = "UPDATE p SET id=?,n=? WHERE id=? RETURNING id,n";
      for (const params of [[2n, 2n, 1n], [1n, 3n, 2n], [1n, 3n, 1n]]) {
        const expected = nativeValues(native, query, params);
        assert.deepEqual(cached.values(query, params), expected);
        assert.deepEqual(plain.values(query, params), expected);
      }
      for (const db of [native, plain, cached]) assert.throws(() => db.run(query, [2n, -1n, 1n]));
      for (const sql of ["SELECT * FROM p", "SELECT * FROM c", "SELECT * FROM log ORDER BY id", "SELECT changes(),last_insert_rowid()"])
        for (const db of [plain, cached]) assert.deepEqual(db.values(sql), nativeValues(native, sql), sql);
    } finally { cached.close(); plain.close(); native.close(); }
  });
}
