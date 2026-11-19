import { test } from "node:test";
import assert from "node:assert/strict";
import { MoonDatabase } from "../adapters/moon-database.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "./compatibility/native-values.ts";
import { schemaSignature } from "../src/safety.ts";
import { readFileSync } from "node:fs";
import type { MoonSqlRuntime } from "../adapters/moon-database.ts";
test("qualified CHECK columns rename after a Kit-style temporary-table rebuild", () => {
  const native = new NodeDatabase(":memory:"),
    moon = new MoonDatabase();
  try {
    for (const sql of [
      'CREATE TABLE "__new_users"(id INTEGER PRIMARY KEY,"name" TEXT,CONSTRAINT valid_name CHECK(length("__new_users"."name")>0))',
      "INSERT INTO \"__new_users\" VALUES(1,'one')",
      'ALTER TABLE "__new_users" RENAME TO "users"',
      'ALTER TABLE "users" RENAME TO "members"',
      'ALTER TABLE "members" RENAME COLUMN "name" TO "display_name"',
    ]) {
      native.run(sql);
      moon.run(sql);
    }
    const reopened = new MoonDatabase(moon.dump());
    try {
      assert.equal(schemaSignature(reopened), schemaSignature(native));
      assert.deepEqual(reopened.values("SELECT id,display_name FROM members"), [
        [1n, "one"],
      ]);
      assert.throws(
        () => reopened.run("INSERT INTO members VALUES(2,'')"),
        /CHECK/,
      );
    } finally {
      reopened.close();
    }
  } finally {
    native.close();
    moon.close();
  }
});
test("rename separates ON UPDATE reference actions and uppercase trigger INSERT columns from table scope", async () => {
  const wasm = (
    await WebAssembly.instantiate(
      readFileSync("_build/wasm-gc/release/build/mizchi/sqlike/full/full.wasm"),
      {},
      { builtins: ["js-string"], importedStringConstants: "_" },
    )
  ).instance.exports as unknown as MoonSqlRuntime;
  for (const runtime of [undefined, wasm]) {
    const n = new NodeDatabase(":memory:"),
      m = new MoonDatabase(undefined, undefined, runtime);
    try {
      for (const sql of [
        "CREATE TABLE p(id INTEGER PRIMARY KEY)",
        "CREATE TABLE t(id INTEGER PRIMARY KEY,n TEXT,owner INTEGER REFERENCES p(id) ON UPDATE CASCADE)",
        "CREATE TABLE audit(n TEXT)",
        "CREATE TRIGGER tr AFTER INSERT ON t BEGIN INSERT INTO audit(n) VALUES(new.n); END",
        "ALTER TABLE t RENAME COLUMN n TO label",
        "INSERT INTO p VALUES(1)",
        "INSERT INTO t VALUES(1,'kept',1)",
      ]) {
        n.run(sql);
        m.run(sql);
      }
      assert.deepEqual(
        m.queryValues("SELECT label,owner FROM t"),
        nativeValues(n, "SELECT label,owner FROM t"),
      );
      assert.deepEqual(m.queryValues("SELECT n FROM audit"), [["kept"]]);
      const reopened = new MoonDatabase(m.dump(), undefined, runtime);
      try {
        assert.deepEqual(reopened.queryValues("SELECT n FROM audit"), [
          ["kept"],
        ]);
      } finally {
        reopened.close();
      }
    } finally {
      n.close();
      m.close();
    }
  }
});
test("table/column renames preserve dependent indexes, views, triggers and foreign keys through reopen", async () => {
  const wasm = (
    await WebAssembly.instantiate(
      readFileSync("_build/wasm-gc/release/build/mizchi/sqlike/full/full.wasm"),
      {},
      { builtins: ["js-string"], importedStringConstants: "_" },
    )
  ).instance.exports as unknown as MoonSqlRuntime;
  for (const runtime of [undefined, wasm]) {
    const schema = [
      "CREATE TABLE items(id INTEGER PRIMARY KEY,n TEXT CHECK(length(n)>0),extra INTEGER)",
      "CREATE UNIQUE INDEX ix ON items(lower(n)) WHERE n IS NOT NULL",
      "CREATE TABLE audit(id INTEGER PRIMARY KEY,item_id INTEGER,title TEXT)",
      "CREATE TRIGGER ai AFTER INSERT ON items BEGIN INSERT INTO audit(item_id,title) VALUES(new.id,new.n); END",
      "CREATE VIEW titles AS SELECT id,n FROM items",
      "CREATE TABLE child(id INTEGER PRIMARY KEY,owner INTEGER REFERENCES items(id) ON UPDATE CASCADE)",
    ];
    const native = new NodeDatabase(":memory:");
    let moon = new MoonDatabase(undefined, undefined, runtime);
    try {
      native.raw.exec("PRAGMA foreign_keys=ON");
      for (const s of schema) {
        native.raw.exec(s);
        moon.run(s);
      }
      for (const s of [
        "INSERT INTO items VALUES(1,'one',7)",
        "INSERT INTO child VALUES(1,1)",
        "ALTER TABLE items RENAME TO things",
        "ALTER TABLE things RENAME COLUMN n TO title",
        "INSERT INTO things VALUES(2,'two',8)",
        "ALTER TABLE things DROP COLUMN extra",
        "UPDATE things SET id=3 WHERE id=1",
      ]) {
        native.raw.exec(s);
        moon.run(s);
        assert.equal(schemaSignature(moon), schemaSignature(native), s);
        const next = new MoonDatabase(moon.dump(), undefined, runtime);
        moon.close();
        moon = next;
      }
      for (const q of [
        "SELECT id,title FROM things ORDER BY id",
        "SELECT * FROM titles ORDER BY id",
        "SELECT * FROM audit ORDER BY id",
        "SELECT * FROM child",
        "PRAGMA foreign_key_list(child)",
      ])
        assert.deepEqual(moon.queryValues(q), nativeValues(native, q), q);
      const before = moon.dump();
      assert.throws(() => moon.run("ALTER TABLE things DROP COLUMN title"));
      assert.equal(moon.dump(), before);
    } finally {
      native.close();
      moon.close();
    }
  }
});
