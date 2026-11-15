import { test } from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { NodeDatabase } from "../adapters/node-database.ts";
import { MoonDatabase } from "../adapters/moon-database.ts";
import { floatTextCorpus } from "./compatibility/expression-corpus.ts";
import { nativeValues as query } from "./compatibility/native-values.ts";
test("REAL-to-TEXT rendering matches native SQLite at precision/exponent boundaries and fixed random doubles", () => {
  const native = new NodeDatabase(":memory:"),
    moon = new MoonDatabase();
  const failures: string[] = [];
  try {
    for (const sql of floatTextCorpus()) {
      const expected = query(native, sql),
        actual = moon.queryValues(sql);
      if (!isDeepStrictEqual(actual, expected))
        failures.push(
          `${sql}: ${JSON.stringify(expected)} != ${JSON.stringify(actual)}`,
        );
    }
    assert.equal(failures.length, 0, failures.slice(0, 12).join("\n"));
  } finally {
    native.close();
  }
});

test("boolean identifier shadowing, nested bindings and IN subquery null semantics match SQLite", () => {
  const native = new NodeDatabase(":memory:"),
    moon = new MoonDatabase();
  try {
    for (const db of [native, moon]) {
      db.run('CREATE TABLE flags("true" INTEGER,"false" INTEGER,n INTEGER)');
      db.run("INSERT INTO flags VALUES(0,1,1)");
      db.run("CREATE TABLE t(id INTEGER PRIMARY KEY,n NUMERIC)");
      db.run("INSERT INTO t VALUES(1,1),(2,NULL),(3,3)");
    }
    for (const sql of [
      "SELECT true,false,n IS TRUE,n IS FALSE FROM flags",
      "SELECT 1 IN(SELECT n FROM t),2 NOT IN(SELECT n FROM t),NULL IN(SELECT n FROM t WHERE 0)",
      "SELECT id,id IN(SELECT x.id FROM t AS x WHERE x.id<t.id) FROM t ORDER BY id",
      "WITH a AS(SELECT id,n FROM t),b AS(SELECT id FROM a WHERE n IS NOT NULL) SELECT * FROM b ORDER BY id",
    ])
      assert.deepEqual(moon.queryValues(sql), query(native, sql), sql);
    const s = native.raw.prepare(
      "SELECT ?,(SELECT ?+?),CASE ? WHEN 4 THEN ? ELSE 0 END",
    );
    s.setReadBigInts(true);
    s.setReturnArrays(true);
    assert.deepEqual(
      moon.queryValues(
        "SELECT ?,(SELECT ?+?),CASE ? WHEN 4 THEN ? ELSE 0 END",
        [1n, 2n, 3n, 4n, 5n],
      ),
      s.all(1n, 2n, 3n, 4n, 5n),
    );
  } finally {
    native.close();
  }
});
