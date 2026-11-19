import { test } from "node:test";
import assert from "node:assert/strict";
import { compareSixQueries, sixPaths } from "./compatibility/six-paths.ts";
import { MoonDatabase } from "../adapters/moon-database.ts";

test("single MIN/MAX selects a unique representative with bare columns and live binds", async () => {
  await compareSixQueries(
    [
      "SELECT g,id,s,max(n),sum(n),count(*) FROM t GROUP BY g ORDER BY g",
      "SELECT id,s,min(n),sum(n)+0 FROM t WHERE id=1",
      "SELECT id,s,max(n) FROM t HAVING s='high'",
      "SELECT id,s,max(n),max(n) FROM t",
      "SELECT id FROM t GROUP BY g ORDER BY max(n)",
      "SELECT rowid,id,s,max(n) FROM t WHERE 0",
      "SELECT id,s,min(n) FROM t WHERE g='b'",
      "SELECT s,max(s COLLATE NOCASE) FROM t WHERE g='a'",
      "SELECT id,CASE WHEN max(n)>0 THEN upper(s) ELSE 'x' END,max(n) FROM t",
      "SELECT g,id,max(n),row_number() OVER (ORDER BY max(n)) FROM t GROUP BY g ORDER BY g",
      "SELECT TRUE,FALSE,max(n) FROM t",
    ],
    [
      "CREATE TABLE t(id INTEGER PRIMARY KEY,g TEXT COLLATE NOCASE,n INTEGER,s TEXT)",
    ],
    [
      "INSERT INTO t VALUES(1,'a',2,'low'),(2,'A',9,'high'),(3,'b',NULL,'only')",
    ],
  );
});

test("ties are accepted only when every observed bare input has the same storage value", async () => {
  await compareSixQueries(
    [
      "SELECT g,s,max(n) FROM t GROUP BY g ORDER BY g",
      "SELECT g,max(n) FROM t GROUP BY g ORDER BY g",
      "SELECT s,max(n) FROM t WHERE g='null'",
      "SELECT true,false,max(n) FROM flags",
    ],
    [
      "CREATE TABLE t(id INTEGER,g TEXT,n INTEGER,s TEXT)",
      'CREATE TABLE flags("true" TEXT,"false" INTEGER,n INTEGER)',
    ],
    [
      "INSERT INTO t VALUES(1,'tie',9,'same'),(2,'tie',9,'same'),(3,'null',NULL,'same'),(4,'null',NULL,'same')",
      "INSERT INTO flags VALUES('low',0,2),('high',7,9)",
    ],
  );
});

test("representative changes with the current parameter and supports repeated prepared executions", async () => {
  const schema = ["CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER,s TEXT)"];
  const queries = [
    {
      name: "seed",
      sql: "INSERT INTO t VALUES(1,2,'low'),(2,9,'high')",
      write: true,
    },
    { name: "q", sql: "SELECT id,s,max(n*?1) FROM t" },
  ];
  const paths = await sixPaths(schema, queries);
  try {
    for (const db of paths) {
      await db.execute("seed");
      assert.deepEqual(await db.execute("q", [1n]), [[2n, "high", 9n]]);
      assert.deepEqual(await db.execute("q", [-1n]), [[1n, "low", -2n]]);
    }
  } finally {
    await Promise.all(paths.map((p) => p.close()));
  }
});

test("ambiguous extrema and unsupported representative rules reject without publishing writes", () => {
  const db = new MoonDatabase();
  try {
    db.run("CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER,s TEXT)");
    db.run("INSERT INTO t VALUES(1,9,'a'),(2,9,'b')");
    db.run("CREATE TABLE out(id INTEGER,s TEXT,n INTEGER)");
    for (const query of [
      "SELECT id,s,max(n) FROM t",
      "SELECT id,max(n),min(n) FROM t",
      "SELECT id,count(*) FROM t",
      "SELECT id,max(n) FILTER(WHERE n>0) FROM t",
      "SELECT id,max(DISTINCT n) FROM t",
    ]) {
      const before = db.dump();
      assert.throws(() => db.values(query), /unsupported/, query);
      assert.equal(db.dump(), before);
    }
    assert.throws(
      () => db.run("INSERT INTO out SELECT id,s,max(n) FROM t"),
      /ambiguous/,
    );
    assert.deepEqual(db.values("SELECT * FROM out"), []);
    db.run('CREATE TABLE flags("true" TEXT,n INTEGER)');
    db.run("INSERT INTO flags VALUES('a',9),('b',9)");
    assert.throws(
      () => db.values("SELECT true,count(*) FROM flags"),
      /bare column/,
    );
    assert.throws(
      () => db.values("SELECT true,max(n) FROM flags"),
      /ambiguous/,
    );
    db.run("CREATE TABLE cases(s TEXT COLLATE NOCASE,n INTEGER)");
    db.run("INSERT INTO cases VALUES('a',9),('A',9)");
    assert.throws(
      () => db.values("SELECT s,max(n) FROM cases GROUP BY s"),
      /ambiguous/,
    );
    assert.throws(
      () => db.values("SELECT id,max(random()) FROM t"),
      /bare column/,
    );
  } finally {
    db.close();
  }
});
