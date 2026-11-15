import { test } from "node:test";
import assert from "node:assert/strict";
import { compareQueries, sqlikePaths } from "./compatibility/sqlike-paths.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "./compatibility/native-values.ts";
test("compound SELECT preserves bag/set semantics, collation, names, NULL and final ordering on all four paths", async () => {
  await compareQueries(
    [
      "SELECT 2 AS n UNION ALL SELECT 1 UNION ALL SELECT 2 ORDER BY n LIMIT 2",
      "SELECT NULL AS n UNION SELECT NULL UNION SELECT 1",
      "SELECT 'a' COLLATE NOCASE AS n UNION SELECT 'A' UNION SELECT 'b' ORDER BY n",
      "SELECT 1 AS n UNION ALL SELECT 1 EXCEPT SELECT 2",
      "SELECT 1 AS n UNION SELECT 2 INTERSECT SELECT 2",
      "SELECT n FROM t UNION ALL SELECT n+10 FROM t ORDER BY n DESC LIMIT 3 OFFSET 1",
      "WITH x AS(SELECT n FROM t UNION ALL SELECT 8) SELECT n FROM x ORDER BY n",
      "SELECT (SELECT 1 UNION ALL SELECT 2)",
    ],
    ["CREATE TABLE t(n INTEGER)"],
  );
});
test("INSERT SELECT materializes its source before writing and rolls back a failed copy", async () => {
  const schema = ["CREATE TABLE t(id INTEGER PRIMARY KEY,n TEXT UNIQUE)"];
  const queries = [
    { name: "seed", sql: "INSERT INTO t VALUES(1,'a'),(2,'b')", write: true },
    {
      name: "copy",
      sql: "INSERT INTO t SELECT id+2,n||'x' FROM t RETURNING id,n",
      write: true,
    },
    { name: "fail", sql: "INSERT INTO t SELECT id+10,n FROM t", write: true },
    { name: "all", sql: "SELECT id,n FROM t ORDER BY id" },
  ];
  const paths = await sqlikePaths(schema, queries),
    native = new NodeDatabase(":memory:");
  try {
    for (const s of schema) native.raw.exec(s);
    for (const q of queries.slice(0, 2)) {
      const expected = nativeValues(native, q.sql);
      for (const p of paths) assert.deepEqual(p.exec(q.name), expected);
    }
    assert.throws(() => native.run(queries[2]!.sql));
    for (const p of paths) {
      const before = p.dump();
      assert.throws(() => p.exec("fail"));
      assert.equal(p.dump(), before);
      assert.deepEqual(p.exec("all"), nativeValues(native, queries[3]!.sql));
    }
  } finally {
    native.close();
  }
});
test("BEGIN, nested savepoints, duplicate names and failed statements keep SQLite transaction semantics", async () => {
  const schema = ["CREATE TABLE t(id INTEGER PRIMARY KEY,n TEXT UNIQUE)"];
  const commands = [
    "BEGIN",
    "SAVEPOINT outer_s",
    "INSERT INTO t VALUES(1,'a')",
    "SAVEPOINT inner_s",
    "INSERT INTO t VALUES(2,'b')",
    "ROLLBACK TO inner_s",
    "RELEASE inner_s",
    "COMMIT",
    "SAVEPOINT same",
    "INSERT INTO t VALUES(3,'c')",
    "SAVEPOINT same",
    "INSERT INTO t VALUES(4,'d')",
    "ROLLBACK TO same",
    "RELEASE same",
    "ROLLBACK TO same",
    "RELEASE same",
    "BEGIN",
    "INSERT INTO t VALUES(5,'e')",
    "ROLLBACK",
  ];
  const qs = commands
    .map((sql, i) => ({ name: `s${i}`, sql, write: true }))
    .concat([
      { name: "all", sql: "SELECT id,n FROM t ORDER BY id", write: false },
    ]);
  const paths = await sqlikePaths(schema, qs),
    native = new NodeDatabase(":memory:");
  try {
    for (const s of schema) native.raw.exec(s);
    for (const [i, s] of commands.entries()) {
      native.raw.exec(s);
      for (const p of paths) {
        p.exec(`s${i}`);
        assert.deepEqual(
          p.exec("all"),
          nativeValues(native, qs.at(-1)!.sql),
          s,
        );
      }
    }
  } finally {
    native.close();
  }
});
test("SQL transactions publish only after COMMIT and preserve the prior durable image on rollback", async () => {
  const { MoonDatabase } = await import("../adapters/moon-database.ts");
  let writes = 0;
  let image = "";
  const db = new MoonDatabase(undefined, (s) => {
    image = s;
    writes++;
  });
  db.run("CREATE TABLE t(id INTEGER PRIMARY KEY,n TEXT)");
  const baseline = writes;
  db.run("BEGIN");
  db.run("INSERT INTO t VALUES(1,'a')");
  db.run("SAVEPOINT s");
  db.run("INSERT INTO t VALUES(2,'b')");
  assert.equal(writes, baseline);
  const reopened = new MoonDatabase(image);
  assert.deepEqual(reopened.query("SELECT * FROM t"), []);
  reopened.close();
  db.run("ROLLBACK TO s");
  db.run("COMMIT");
  assert.equal(writes, baseline + 1);
  db.run("BEGIN");
  db.run("INSERT INTO t VALUES(3,'c')");
  db.run("ROLLBACK");
  const final = new MoonDatabase(image);
  assert.deepEqual(final.query("SELECT id FROM t"), [{ id: 1n }]);
  final.close();
  db.close();
});
test("recursive CTE uses a row queue, explicit column names, UNION deduplication and bounded LIMIT", async () => {
  await compareQueries([
    "WITH RECURSIVE r(n) AS(SELECT 1 UNION ALL SELECT n+1 FROM r WHERE n<5) SELECT n FROM r ORDER BY n",
    "WITH RECURSIVE r(n) AS(VALUES(1) UNION ALL SELECT n+1 FROM r LIMIT 5) SELECT sum(n),count(*) FROM r",
    "WITH RECURSIVE r(n) AS(VALUES(1) UNION SELECT n FROM r) SELECT n FROM r",
    "WITH x(a,b) AS(SELECT 1,2 UNION ALL SELECT 3,4) SELECT a,b FROM x ORDER BY a",
    "WITH RECURSIVE r(n) AS(VALUES(1) UNION ALL SELECT n+1 FROM r WHERE n<8 LIMIT 3 OFFSET 2) SELECT n FROM r",
  ]);
});
test("compound ORDER BY resolves aliases from either arm and rejects expressions absent from result columns", async () => {
  await compareQueries([
    "SELECT 2 AS a UNION ALL SELECT 1 AS b ORDER BY b",
    "SELECT 2 AS a UNION SELECT 1 AS b",
    "SELECT 2 AS a UNION SELECT 1 AS b ORDER BY a DESC",
  ]);
  const { MoonDatabase } = await import("../adapters/moon-database.ts");
  const native = new NodeDatabase(":memory:"),
    moon = new MoonDatabase();
  try {
    for (const s of [
      "SELECT 1 AS n UNION ALL SELECT 2 ORDER BY n+1",
      "SELECT 1 UNION SELECT 2,3",
    ]) {
      assert.throws(() => nativeValues(native, s));
      assert.throws(() => moon.query(s));
    }
  } finally {
    native.close();
    moon.close();
  }
});
