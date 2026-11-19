import { test } from "node:test";
import assert from "node:assert/strict";
import { compareSixQueries, sixPaths } from "./compatibility/six-paths.ts";
import { MoonDatabase } from "../adapters/moon-database.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import { nativeValues } from "./compatibility/native-values.ts";

test("constant DEFAULT expressions retain scalar semantics, affinity and declaration metadata on six paths", async () => {
  await compareSixQueries(
    [
      "INSERT INTO t DEFAULT VALUES RETURNING *",
      "INSERT INTO t(id) VALUES(2),(3) RETURNING *",
      "SELECT *,typeof(n),typeof(r),typeof(v),typeof(b),typeof(z) FROM t ORDER BY id",
      "PRAGMA table_info(t)",
    ],
    [
      "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER DEFAULT ((1+2)*3),r REAL DEFAULT (CAST('2.5' AS REAL)),v TEXT DEFAULT (lower('HELLO')||'-'||hex(x'01')),b BLOB DEFAULT (CAST('ab' AS BLOB)),z DEFAULT (1/0),k DEFAULT (CASE WHEN 0 THEN abs(-9223372036854775808) ELSE 7 END))",
    ],
  );
});
test("DEFAULT evaluates per row with live connection counters and preserves explicit NULL", async () => {
  await compareSixQueries(
    [
      "INSERT INTO t(id) VALUES(1),(2),(3) RETURNING *",
      "INSERT INTO t VALUES(9,NULL,NULL) RETURNING *",
      "INSERT INTO t(id) SELECT id+10 FROM t WHERE id<4 RETURNING *",
      "SELECT * FROM t ORDER BY id",
    ],
    [
      "CREATE TABLE t(id INTEGER PRIMARY KEY,v DEFAULT(last_insert_rowid()),c DEFAULT(changes()))",
    ],
  );
});
test("unused failing DEFAULTs are not evaluated; required failures roll back without publishing rows", async () => {
  const schema = [
    "CREATE TABLE t(id INTEGER PRIMARY KEY,v DEFAULT(abs(-9223372036854775808)))",
  ];
  const queries = [
    { name: "seed", sql: "INSERT INTO t VALUES(1,7),(2,8)", write: true },
    { name: "bad", sql: "INSERT INTO t(id) VALUES(3),(4)", write: true },
    { name: "get", sql: "SELECT * FROM t ORDER BY id" },
  ];
  const paths = await sixPaths(schema, queries),
    native = new NodeDatabase(":memory:");
  try {
    schema.forEach((s) => native.raw.exec(s));
    native.raw.exec(queries[0]!.sql);
    for (const p of paths) await p.execute("seed");
    assert.throws(() => native.raw.exec(queries[1]!.sql), /overflow/);
    for (const p of paths) {
      await assert.rejects(p.execute("bad"), /overflow/);
      assert.deepEqual(
        await p.execute("get"),
        nativeValues(native, queries[2]!.sql),
      );
    }
  } finally {
    native.close();
    await Promise.all(paths.map((p) => p.close()));
  }
});
test("DEFAULT tokens preserve bare and quoted text and leave column COLLATE outside the expression", async () => {
  await compareSixQueries(
    [
      "INSERT INTO t DEFAULT VALUES RETURNING *",
      "PRAGMA table_info(t)",
      "SELECT v='ABC',q='q',b FROM t",
    ],
    [
      "CREATE TABLE t(v TEXT DEFAULT ('abc') COLLATE NOCASE,q TEXT DEFAULT \"Q\" COLLATE NOCASE,b DEFAULT bareword)",
    ],
  );
});
test("invalid default grammar and non-constant expressions reject before schema changes", () => {
  const native = new NodeDatabase(":memory:"),
    moon = new MoonDatabase();
  try {
    for (const sql of [
      "CREATE TABLE t(a INT,v DEFAULT(a))",
      "CREATE TABLE t(v DEFAULT(?))",
      "CREATE TABLE t(v DEFAULT((SELECT 1)))",
      'CREATE TABLE t(v DEFAULT("x"))',
      "CREATE TABLE t(v DEFAULT -TRUE)",
      "CREATE TABLE t(v DEFAULT ~1)",
      "CREATE TABLE t(v DEFAULT lower('A'))",
    ]) {
      assert.throws(() => native.raw.exec(sql), sql);
      assert.throws(() => moon.run(sql), sql);
      assert.deepEqual(
        moon.values("SELECT name FROM sqlite_schema WHERE name='t'"),
        [],
      );
    }
  } finally {
    native.close();
    moon.close();
  }
});
test("ALTER ADD accepts expression defaults on empty tables and refuses nonconstant backfill", () => {
  const native = new NodeDatabase(":memory:"),
    moon = new MoonDatabase();
  try {
    for (const sql of [
      "CREATE TABLE t(id INTEGER)",
      "ALTER TABLE t ADD COLUMN n DEFAULT (1+2)",
      "INSERT INTO t(id) VALUES(1)",
    ]) {
      native.raw.exec(sql);
      moon.run(sql);
    }
    assert.deepEqual(
      moon.values("SELECT * FROM t"),
      nativeValues(native, "SELECT * FROM t"),
    );
    for (const sql of [
      "ALTER TABLE t ADD COLUMN x DEFAULT (1+2)",
      "ALTER TABLE t ADD COLUMN x DEFAULT CURRENT_TIMESTAMP",
    ]) {
      assert.throws(() => native.raw.exec(sql));
      assert.throws(() => moon.run(sql));
      assert.deepEqual(
        moon.values("PRAGMA table_info(t)"),
        nativeValues(native, "PRAGMA table_info(t)"),
      );
    }
    assert.doesNotThrow(() =>
      buildCatalog({
        schema: ["CREATE TABLE r(v DEFAULT(lower('A')))"],
        queries: [
          { name: "q", sql: "INSERT INTO r DEFAULT VALUES RETURNING v" },
        ],
      }),
    );
  } finally {
    native.close();
    moon.close();
  }
});

test("DEFAULT has no row scope in triggers or FK SET DEFAULT and REPLACE uses it only for NULL", async () => {
  const schema = [
    "CREATE TABLE p(id INTEGER PRIMARY KEY)",
    "CREATE TABLE c(id INTEGER PRIMARY KEY,true INT,parent INT DEFAULT(TRUE+0) REFERENCES p(id) ON DELETE SET DEFAULT)",
    "CREATE TABLE source(id INTEGER PRIMARY KEY,true INT)",
    "CREATE TABLE log(id INTEGER,v DEFAULT(TRUE+0))",
    "CREATE TRIGGER ins AFTER INSERT ON source BEGIN INSERT INTO log(id) VALUES(new.id); END",
  ];
  const steps = [
    "INSERT INTO p VALUES(1),(2)",
    "INSERT INTO c VALUES(1,0,2)",
    "DELETE FROM p WHERE id=2",
    "INSERT INTO source VALUES(7,0)",
    "SELECT * FROM c",
    "SELECT * FROM log",
  ];
  const queries = steps.map((sql, i) => ({
    name: `q${i}`,
    sql,
    write: !sql.startsWith("SELECT"),
  }));
  const paths = await sixPaths(schema, queries),
    native = new NodeDatabase(":memory:");
  try {
    native.raw.exec("PRAGMA foreign_keys=ON");
    schema.forEach((s) => native.raw.exec(s));
    for (const step of queries) {
      const expected = nativeValues(native, step.sql);
      for (const path of paths)
        assert.deepEqual(await path.execute(step.name), expected);
    }
  } finally {
    native.close();
    await Promise.all(paths.map((p) => p.close()));
  }
  await compareSixQueries(
    [
      "INSERT INTO r VALUES(1,5) RETURNING *",
      "INSERT OR REPLACE INTO r VALUES(2,NULL),(3,8) RETURNING *",
      "SELECT * FROM r ORDER BY id",
    ],
    ["CREATE TABLE r(id INTEGER PRIMARY KEY,v INTEGER NOT NULL DEFAULT (1+2))"],
  );
});
