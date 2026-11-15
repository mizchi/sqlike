import { test } from "node:test";
import assert from "node:assert/strict";
import { NodeDatabase } from "../adapters/node-database.ts";
import { SyncEngine, importSnapshot } from "../src/engine.ts";

test("snapshot replacement preserves immediate FK enforcement and supports child-before-parent schemas", () => {
  const source = new NodeDatabase(":memory:");
  const engine = new SyncEngine(source);
  const target = new NodeDatabase(":memory:");
  try {
    source.run(
      "CREATE TABLE child(id INTEGER PRIMARY KEY,pid INTEGER REFERENCES parent(id))",
    );
    source.run("CREATE TABLE parent(id INTEGER PRIMARY KEY)");
    source.run("INSERT INTO parent VALUES(2)");
    source.run("INSERT INTO child VALUES(2,2)");
    target.run("CREATE TABLE parent(id INTEGER PRIMARY KEY)");
    target.run(
      "CREATE TABLE child(id INTEGER PRIMARY KEY,pid INTEGER REFERENCES parent(id))",
    );
    target.run("INSERT INTO parent VALUES(1)");
    target.run("INSERT INTO child VALUES(1,1)");
    target.transaction(() => importSnapshot(target, engine.snapshot()));
    assert.equal(target.all("SELECT pid FROM child")[0]!.pid, 2n);
    assert.throws(
      () => target.run("INSERT INTO child VALUES(3,999)"),
      /FOREIGN KEY/,
    );
    const invalid = engine.snapshot();
    invalid.tables.find((t) => t.name === "child")!.rows[0]![1] = {
      t: "integer",
      v: "999",
    };
    assert.throws(
      () => target.transaction(() => importSnapshot(target, invalid)),
      /snapshot.*foreign key/i,
    );
    assert.equal(target.all("SELECT pid FROM child")[0]!.pid, 2n);
  } finally {
    source.close();
    target.close();
  }
});

test("snapshot creates a referenced parent unique index before inserting child rows", () => {
  const source = new NodeDatabase(":memory:");
  const engine = new SyncEngine(source);
  const target = new NodeDatabase(":memory:");
  try {
    source.run("CREATE TABLE child(value TEXT REFERENCES parent(value))");
    source.run("CREATE TABLE parent(value TEXT)");
    source.run("CREATE UNIQUE INDEX parent_value ON parent(value)");
    source.run("INSERT INTO parent VALUES('key')");
    source.run("INSERT INTO child VALUES('key')");
    target.transaction(() => importSnapshot(target, engine.snapshot()));
    assert.equal(target.all("SELECT value FROM child")[0]!.value, "key");
    assert.deepEqual(target.all("PRAGMA foreign_key_check"), []);
  } finally {
    source.close();
    target.close();
  }
});
