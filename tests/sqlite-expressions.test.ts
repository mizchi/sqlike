import { test } from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual, inspect } from "node:util";
import { NodeDatabase } from "../adapters/node-database.ts";
import { MoonDatabase } from "../adapters/moon-database.ts";
import { expressionCorpus } from "./compatibility/expression-corpus.ts";
import type { Value } from "../src/contract.ts";
import { nativeValues } from "./compatibility/native-values.ts";

test("generated expressions match native SQLite values and storage classes without skipped failures", () => {
  const native = new NodeDatabase(":memory:");
  const moon = new MoonDatabase();
  let failures = 0;
  const examples: string[] = [];
  const queries = expressionCorpus();
  try {
    for (const sql of queries) {
      let expected: Value[][];
      try {
        expected = nativeValues(native, sql);
      } catch (e) {
        throw Error(`invalid native oracle expectation: ${sql}`, { cause: e });
      }
      let actual: unknown;
      try {
        actual = moon.queryValues(sql);
      } catch (e) {
        actual = { error: (e as Error).message };
      }
      if (!isDeepStrictEqual(actual, expected)) {
        failures++;
        if (examples.length < 24)
          examples.push(
            `${sql}\nexpected ${inspect(expected, { depth: 3, maxStringLength: 80 })}\nreceived ${inspect(actual, { depth: 3, maxStringLength: 80 })}`,
          );
      }
    }
    assert.equal(
      failures,
      0,
      `${failures}/${queries.length} differential failures:\n${examples.join("\n\n")}`,
    );
  } finally {
    native.close();
  }
});
test("collation, DISTINCT, aliases and correlated selection match native SQLite", () => {
  const native = new NodeDatabase(":memory:");
  const moon = new MoonDatabase();
  try {
    for (const db of [native, moon]) {
      db.run("CREATE TABLE texts(v TEXT COLLATE NOCASE)");
      db.run("INSERT INTO texts VALUES('Z'),('b'),('A'),('a')");
      db.run("CREATE TABLE numbers(v BLOB)");
      db.run("INSERT INTO numbers VALUES(1),(1.0),(2),(NULL),(NULL)");
      db.run("CREATE TABLE correlations(id INTEGER PRIMARY KEY,n INTEGER)");
      db.run("INSERT INTO correlations VALUES(1,1),(2,2),(3,NULL)");
    }
    for (const sql of [
      "SELECT v FROM texts ORDER BY 1",
      "SELECT DISTINCT v FROM texts ORDER BY 1",
      "SELECT DISTINCT v FROM numbers ORDER BY v",
      "SELECT id,CASE WHEN n BETWEEN 1 AND 2 THEN (SELECT count(*) FROM correlations AS x WHERE x.n<correlations.n) ELSE -1 END FROM correlations ORDER BY id",
      "SELECT (SELECT 7 WHERE 0) AS empty,EXISTS(SELECT 1 WHERE 0) AS absent",
    ])
      assert.deepEqual(moon.queryValues(sql), nativeValues(native, sql), sql);
  } finally {
    native.close();
  }
});
