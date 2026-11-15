import { test } from "node:test";
import assert from "node:assert/strict";
import { compareQueries, sqlikePaths } from "./compatibility/sqlike-paths.ts";
test("RIGHT/FULL joins preserve unmatched rows, NULL keys, ON/WHERE order and empty inputs on all four paths", async () => {
  await compareQueries(
    [
      "SELECT a.id,b.id,a.v,b.v FROM a RIGHT JOIN b ON a.k=b.k ORDER BY b.id,a.id",
      "SELECT a.id,b.id FROM a FULL OUTER JOIN b ON a.k=b.k ORDER BY a.id,b.id",
      "SELECT a.id,b.id FROM a FULL JOIN b ON a.k=b.k AND a.id<>2 WHERE b.id IS NOT NULL ORDER BY b.id,a.id",
      "SELECT a.id,b.id,c.id FROM a FULL JOIN b ON a.k=b.k RIGHT JOIN c ON b.k=c.k ORDER BY c.id,a.id,b.id",
      "SELECT a.id,b.id FROM a RIGHT JOIN b ON 0 WHERE a.id IS NULL ORDER BY b.id",
    ],
    [
      "CREATE TABLE a(id INTEGER PRIMARY KEY,k INTEGER,v TEXT)",
      "CREATE TABLE b(id INTEGER PRIMARY KEY,k INTEGER,v TEXT)",
      "CREATE TABLE c(id INTEGER PRIMARY KEY,k INTEGER)",
    ],
    [
      "INSERT INTO a VALUES(1,1,'a'),(2,2,'b'),(3,2,'c'),(4,NULL,'n')",
      "INSERT INTO b VALUES(10,2,'x'),(11,3,'y'),(12,NULL,'z')",
      "INSERT INTO c VALUES(20,3),(21,5)",
    ],
  );
  await compareQueries(
    [
      "SELECT a.id,b.id FROM a FULL JOIN b ON a.id=b.id ORDER BY b.id",
      "SELECT a.id,b.id FROM a RIGHT JOIN b ON a.id=b.id ORDER BY b.id",
    ],
    ["CREATE TABLE a(id INTEGER)", "CREATE TABLE b(id INTEGER)"],
    ["INSERT INTO b VALUES(1),(2)"],
  );
});
test("STRICT preserves ANY, coerces permitted values and rejects bad types atomically on four paths", async () => {
  const paths = await sqlikePaths(
    [
      "CREATE TABLE s(id INTEGER PRIMARY KEY,n INT,r REAL,t TEXT,b BLOB,a ANY) STRICT",
    ],
    [
      {
        name: "add",
        sql: "INSERT INTO s VALUES(?,?,?,?,?,?) RETURNING id,n,r,t,hex(b),a,typeof(a)",
        write: true,
      },
      { name: "change", sql: "UPDATE s SET n=? WHERE id=1", write: true },
      {
        name: "all",
        sql: "SELECT id,n,r,t,hex(b),a,typeof(a) FROM s ORDER BY id",
      },
    ],
  );
  for (const p of paths) {
    assert.deepEqual(
      p.exec("add", [1n, "123", 2n, 4n, new Uint8Array([255]), "000123"]),
      [[1n, 123n, 2, "4", "FF", "000123", "text"]],
    );
    for (const values of [
      [2n, "bad", null, null, null, null],
      [2n, 1n, 1n, 1n, "text", null],
    ]) {
      const before = p.dump();
      assert.throws(() => p.exec("add", values));
      assert.equal(p.dump(), before);
    }
    const before = p.dump();
    assert.throws(() => p.exec("change", ["1.5"]));
    assert.equal(p.dump(), before);
    p.restore(p.dump());
    assert.equal(p.exec("all").length, 1);
  }
});
test("RIGHT/FULL USING and NATURAL merge keys while retaining qualified stars and mixed affinities", async () => {
  await compareQueries(
    [
      "SELECT * FROM a RIGHT JOIN b USING(k) ORDER BY k",
      "SELECT k,a.k,b.k,typeof(k),k=3,k='1' FROM a FULL JOIN b USING(k) ORDER BY k",
      "SELECT a.*,b.* FROM a FULL JOIN b USING(k) ORDER BY a.k,b.k",
      "SELECT * FROM a NATURAL FULL JOIN b ORDER BY k",
    ],
    ["CREATE TABLE a(k INTEGER,av TEXT)", "CREATE TABLE b(k TEXT,bv TEXT)"],
    [
      "INSERT INTO a VALUES(1,'a'),(2,'b')",
      "INSERT INTO b VALUES('1','x'),('3','y')",
    ],
  );
});
test("STRICT implicit non-null metadata and ANY primary keys agree with SQLite", async () => {
  await compareQueries(
    [
      "PRAGMA table_info(s)",
      "PRAGMA table_info(w)",
      "SELECT k,typeof(k) FROM s ORDER BY k",
    ],
    [
      "CREATE TABLE s(k ANY PRIMARY KEY) STRICT",
      "CREATE TABLE w(a TEXT,b INT,PRIMARY KEY(a,b)) STRICT, WITHOUT ROWID",
    ],
    ["INSERT INTO s VALUES('001'),(1)"],
  );
});
test("STRICT datatype violations cannot be swallowed by OR IGNORE or a trigger conflict override", async () => {
  const paths = await sqlikePaths(
    [
      "CREATE TABLE s(id INTEGER PRIMARY KEY,v INT) STRICT",
      "CREATE TABLE events(id INTEGER PRIMARY KEY)",
      "CREATE TRIGGER tr AFTER INSERT ON events BEGIN INSERT INTO s VALUES(new.id,'bad'); END",
    ],
    [
      {
        name: "ignore",
        sql: "INSERT OR IGNORE INTO s VALUES(1,2),(2,'bad')",
        write: true,
      },
      {
        name: "trigger",
        sql: "INSERT OR IGNORE INTO events VALUES(3)",
        write: true,
      },
      {
        name: "upsert",
        sql: "INSERT INTO s VALUES(1,'bad') ON CONFLICT DO NOTHING",
        write: true,
      },
      { name: "all", sql: "SELECT * FROM s" },
    ],
  );
  for (const p of paths)
    for (const name of ["ignore", "trigger", "upsert"]) {
      const before = p.dump();
      assert.throws(() => p.exec(name), /datatype/);
      const expected = JSON.parse(before);
      expected.state.last_rowid = name === "ignore" ? "1" : "3";
      assert.deepEqual(JSON.parse(p.dump()), expected);
      assert.equal(p.exec("all").length, 0);
    }
});
