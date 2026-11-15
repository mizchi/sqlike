import { test } from "node:test";
import assert from "node:assert/strict";
import { sqlikePaths } from "./compatibility/sqlike-paths.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "./compatibility/native-values.ts";
test("composite foreign keys cascade updates, SET NULL, deferred COMMIT and savepoint rollback match SQLite", async () => {
  const schema = [
    "CREATE TABLE p(a INTEGER,b TEXT COLLATE NOCASE,PRIMARY KEY(a,b))",
    "CREATE TABLE c(id INTEGER PRIMARY KEY,x INTEGER,y TEXT,FOREIGN KEY(x,y) REFERENCES p(a,b) ON UPDATE CASCADE ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED)",
  ];
  const operations = [
    "INSERT INTO p VALUES(1,'A')",
    "INSERT INTO c VALUES(1,1,'a'),(2,NULL,'missing')",
    "UPDATE p SET a=3,b='B' WHERE a=1",
    "DELETE FROM p",
    "BEGIN",
    "INSERT INTO c VALUES(3,7,'C')",
    "COMMIT",
    "INSERT INTO p VALUES(7,'c')",
    "COMMIT",
    "BEGIN",
    "INSERT INTO c VALUES(4,8,'d')",
    "SAVEPOINT s",
    "INSERT INTO p VALUES(8,'D')",
    "ROLLBACK TO s",
    "COMMIT",
    "ROLLBACK",
  ];
  const queries = [
    ...operations.map((sql, i) => ({ name: `s${i}`, sql, write: true })),
    { name: "all", sql: "SELECT id,x,y FROM c ORDER BY id" },
    { name: "fk", sql: "PRAGMA foreign_key_list(c)" },
    { name: "errors", sql: "PRAGMA foreign_key_check" },
  ];
  const paths = await sqlikePaths(schema, queries),
    native = new NodeDatabase(":memory:");
  try {
    native.raw.exec("PRAGMA foreign_keys=ON");
    for (const s of schema) native.raw.exec(s);
    for (const [i, s] of operations.entries()) {
      if (i === 6 || i === 14) {
        assert.throws(() => native.raw.exec(s));
        for (const p of paths) assert.throws(() => p.exec(`s${i}`));
      } else {
        native.raw.exec(s);
        for (const p of paths) p.exec(`s${i}`);
      }
      for (const name of ["all", "fk", "errors"]) {
        const q = queries.find((q) => q.name === name)!;
        for (const p of paths)
          assert.deepEqual(
            p.exec(name),
            nativeValues(native, q.sql),
            `${s}/${name}`,
          );
      }
    }
  } finally {
    native.close();
  }
});

test("all foreign-key delete actions fire the appropriate child triggers and retain direct changes()", async () => {
  for (const action of ["CASCADE", "SET NULL", "SET DEFAULT", "RESTRICT"]) {
    const schema = [
      "CREATE TABLE p(id INTEGER PRIMARY KEY)",
      `CREATE TABLE c(id INTEGER PRIMARY KEY,parent INTEGER DEFAULT 99 REFERENCES p(id) ON DELETE ${action})`,
      "CREATE TABLE audit(id INTEGER PRIMARY KEY,n INTEGER)",
      "CREATE TRIGGER cu AFTER UPDATE ON c BEGIN INSERT INTO audit(n) VALUES(new.parent); END",
      "CREATE TRIGGER cd AFTER DELETE ON c BEGIN INSERT INTO audit(n) VALUES(old.parent); END",
    ];
    const qs = [
      { name: "parents", sql: "INSERT INTO p VALUES(1),(99)", write: true },
      { name: "child", sql: "INSERT INTO c VALUES(1,1)", write: true },
      { name: "delete", sql: "DELETE FROM p WHERE id=1", write: true },
      { name: "all", sql: "SELECT id,parent FROM c" },
      { name: "audit", sql: "SELECT n FROM audit ORDER BY id" },
      { name: "changes", sql: "SELECT changes()" },
    ];
    const paths = await sqlikePaths(schema, qs),
      native = new NodeDatabase(":memory:");
    try {
      native.raw.exec("PRAGMA foreign_keys=ON");
      for (const s of schema) native.raw.exec(s);
      for (const name of ["parents", "child"]) {
        native.raw.exec(qs.find((q) => q.name === name)!.sql);
        for (const p of paths) p.exec(name);
      }
      if (action === "RESTRICT") {
        assert.throws(() => native.raw.exec(qs[2]!.sql));
        for (const p of paths) assert.throws(() => p.exec("delete"));
      } else {
        native.raw.exec(qs[2]!.sql);
        for (const p of paths) p.exec("delete");
      }
      for (const name of ["all", "audit", "changes"])
        for (const p of paths)
          assert.deepEqual(
            p.exec(name),
            nativeValues(native, qs.find((q) => q.name === name)!.sql),
            `${action}/${name}`,
          );
    } finally {
      native.close();
    }
  }
});
