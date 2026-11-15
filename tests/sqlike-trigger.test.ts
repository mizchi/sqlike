import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as sql from "../_build/js/release/build/mizchi/sqlike/sqlike.js";
import * as aot from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import { aotBindings, aotValue } from "../src/aot-values.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "./compatibility/native-values.ts";
import type { Cell, Value } from "../src/contract.ts";
import { MoonDatabase } from "../adapters/moon-database.ts";
const schema = [
  "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)",
  "CREATE TABLE audit(id INTEGER PRIMARY KEY AUTOINCREMENT,row_id INTEGER,before_n INTEGER,after_n INTEGER,event TEXT,direct_changes INTEGER,parent_rowid INTEGER)",
  "CREATE TRIGGER ai AFTER INSERT ON t BEGIN INSERT INTO audit(row_id,after_n,event,direct_changes,parent_rowid) VALUES(new.id,new.n,'insert',changes(),last_insert_rowid()); END",
  "CREATE TRIGGER au AFTER UPDATE OF n ON t WHEN old.n IS NOT new.n BEGIN INSERT INTO audit(row_id,before_n,after_n,event) VALUES(new.id,old.n,new.n,'update'); END",
  "CREATE TRIGGER ad AFTER DELETE ON t BEGIN INSERT INTO audit(row_id,before_n,event) VALUES(old.id,old.n,'delete'); END",
  "CREATE TRIGGER valid BEFORE INSERT ON t WHEN new.n<0 BEGIN SELECT RAISE(ABORT,'negative'); END",
  "CREATE TRIGGER skip BEFORE UPDATE OF n ON t WHEN new.n=-99 BEGIN SELECT RAISE(IGNORE); END",
  "CREATE TRIGGER deny AFTER UPDATE ON t WHEN new.n=7 BEGIN INSERT INTO audit(row_id,event) VALUES(new.id,'trial'); SELECT RAISE(ABORT,'deny7'); END",
];
const queries = [
  { name: "add", sql: "INSERT INTO t VALUES(?,?) RETURNING id,n", write: true },
  {
    name: "update",
    sql: "UPDATE t SET n=? WHERE id=? RETURNING id,n",
    write: true,
  },
  { name: "many", sql: "UPDATE t SET n=? RETURNING id,n", write: true },
  {
    name: "upsert",
    sql: "INSERT INTO t VALUES(?,?) ON CONFLICT(id) DO UPDATE SET n=excluded.n RETURNING id,n",
    write: true,
  },
  {
    name: "erase",
    sql: "DELETE FROM t WHERE id=? RETURNING id,n",
    write: true,
  },
  { name: "all", sql: "SELECT id,n FROM t ORDER BY id" },
  {
    name: "log",
    sql: "SELECT id,row_id,before_n,after_n,event,direct_changes,parent_rowid FROM audit ORDER BY id",
  },
  { name: "meta", sql: "SELECT changes(),last_insert_rowid()" },
];
function parsed(text: string) {
  const r = JSON.parse(text);
  if (r.error) throw Error(r.error);
  return r;
}
test("row triggers, WHEN/UPDATE OF, RAISE and failed statements match SQLite on dynamic/AOT JS/Wasm", async () => {
  const built = buildCatalog({ schema, queries });
  const wasm = async (path: string) =>
    (
      await WebAssembly.instantiate(
        readFileSync(path),
        {},
        { builtins: ["js-string"], importedStringConstants: "_" },
      )
    ).instance.exports;
  const drivers = [];
  for (const r of [
    sql,
    (await wasm(
      "_build/wasm-gc/release/build/mizchi/sqlike/sqlike.wasm",
    )) as unknown as typeof sql,
  ]) {
    const db = r.database_open();
    for (const ddl of schema) parsed(r.database_exec(db, ddl, "[]", false));
    drivers.push({
      exec: (name: string, params: Value[] = []) => {
        const q = queries.find((q) => q.name === name)!;
        return parsed(
          q.write
            ? r.database_exec(db, q.sql, aotBindings(params), false)
            : r.database_query_values(db, q.sql, aotBindings(params)),
        ).rows.map((row: Cell[] | Record<string, Cell>) =>
          (Array.isArray(row) ? row : Object.values(row)).map(aotValue),
        );
      },
      dump: () => r.database_dump(db),
      restore: (s: string) => parsed(r.database_restore(db, s)),
    });
  }
  for (const r of [
    aot,
    (await wasm(
      "_build/wasm-gc/release/build/mizchi/litestream-example/runtime/runtime.wasm",
    )) as unknown as typeof aot,
  ]) {
    const db = r.aot_open(built.artifact, "");
    parsed(r.aot_info(db));
    drivers.push({
      exec: (name: string, params: Value[] = []) =>
        parsed(r.aot_execute(db, name, aotBindings(params))).rows.map(
          (row: Cell[]) => row.map(aotValue),
        ),
      dump: () => r.aot_dump(db),
      restore: (s: string) => parsed(r.aot_restore(db, s)),
    });
  }
  const native = new NodeDatabase(":memory:");
  try {
    for (const ddl of schema) native.raw.exec(ddl);
    for (const op of [
      { name: "add", params: [1n, 2n] },
      { name: "add", params: [2n, 3n] },
      { name: "add", params: [3n, -1n], error: true },
      { name: "update", params: [4n, 1n] },
      { name: "update", params: [4n, 1n] },
      { name: "update", params: [-99n, 2n] },
      { name: "upsert", params: [2n, 5n] },
      { name: "many", params: [7n], error: true },
      { name: "erase", params: [1n] },
    ]) {
      const q = queries.find((q) => q.name === op.name)!;
      if (op.error) {
        assert.throws(() => native.run(q.sql, op.params));
        for (const d of drivers) {
          const before = d.dump();
          assert.throws(() => d.exec(op.name, op.params));
          assert.equal(d.dump(), before);
        }
      } else {
        const expected = nativeValues(native, q.sql, op.params);
        for (const d of drivers)
          assert.deepEqual(d.exec(op.name, op.params), expected, q.name);
      }
      for (const name of ["all", "log", "meta"])
        for (const d of drivers)
          assert.deepEqual(
            d.exec(name),
            nativeValues(native, queries.find((q) => q.name === name)!.sql),
            `${name}/${op.name}/${op.params.join("/")}`,
          );
    }
    for (const d of drivers) {
      const before = d.dump();
      d.restore(before);
      assert.equal(d.dump(), before);
      assert.deepEqual(
        d.exec("log"),
        nativeValues(native, queries.find((q) => q.name === "log")!.sql),
      );
    }
  } finally {
    native.close();
  }
});

test("later rows in a multi-row write see earlier trigger effects", () => {
  for (const action of [
    "UPDATE t SET n=n+10 WHERE id=2",
    "DELETE FROM t WHERE id=2",
  ]) {
    const native = new NodeDatabase(":memory:"),
      db = new MoonDatabase();
    try {
      for (const ddl of [
        "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)",
        "INSERT INTO t VALUES(1,0),(2,1)",
        `CREATE TRIGGER au AFTER UPDATE ON t WHEN new.id=1 BEGIN ${action}; END`,
      ]) {
        native.run(ddl);
        db.run(ddl);
      }
      const query = "UPDATE t SET n=n+1 RETURNING id,n";
      assert.deepEqual(
        db.all(query).map(Object.values),
        nativeValues(native, query),
      );
      assert.deepEqual(
        db.queryValues("SELECT id,n FROM t ORDER BY id"),
        nativeValues(native, "SELECT id,n FROM t ORDER BY id"),
      );
    } finally {
      db.close();
      native.close();
    }
  }
});

test("outer INSERT OR policy also controls UPDATE constraints inside an AFTER trigger", () => {
  const native = new NodeDatabase(":memory:"),
    db = new MoonDatabase();
  try {
    for (const ddl of [
      "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)",
      "CREATE TABLE u(id INTEGER PRIMARY KEY,n INTEGER UNIQUE)",
      "INSERT INTO u VALUES(1,1),(2,2)",
      "CREATE TRIGGER ai AFTER INSERT ON t BEGIN UPDATE u SET n=new.n WHERE id=2; END",
    ]) {
      native.run(ddl);
      db.run(ddl);
    }
    for (const query of [
      "INSERT OR IGNORE INTO t VALUES(1,1)",
      "INSERT OR REPLACE INTO t VALUES(2,1)",
    ]) {
      native.run(query);
      db.run(query);
      for (const table of ["t", "u"])
        assert.deepEqual(
          db.queryValues(`SELECT id,n FROM ${table} ORDER BY id`),
          nativeValues(native, `SELECT id,n FROM ${table} ORDER BY id`),
        );
    }
  } finally {
    native.close();
    db.close();
  }
});
