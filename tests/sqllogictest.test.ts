import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { NodeDatabase } from "../adapters/node-database.ts";
import { MoonDatabase } from "../adapters/moon-database.ts";
import {
  parseLogicTest,
  runLogicTest,
  verifyLogicResult,
  differentialLogicTest,
} from "./compatibility/sqllogictest.ts";
import { nativeValues } from "./compatibility/native-values.ts";
const source = readFileSync("tests/fixtures/sqllogictest/select1.test", "utf8");
const records = parseLogicTest(source);
const provenance = JSON.parse(
  readFileSync("tests/fixtures/sqllogictest/upstream.json", "utf8"),
);
assert.equal(
  createHash("sha256").update(source).digest("hex"),
  provenance.sha256,
);
test("the original sqllogictest select1 fixture is complete and its expected results match native SQLite", () => {
  const db = new NodeDatabase(":memory:");
  try {
    const result = runLogicTest(records, {
      execute: (sql) => db.run(sql),
      query: (sql) => nativeValues(db, sql),
    });
    assert.deepEqual(result, { statements: 31, queries: 1000 });
  } finally {
    db.close();
  }
});
test("sqllogictest detects altered expected hashes and never accepts missing directives", () => {
  assert.throws(
    () => parseLogicTest("skipif moonbit\nquery I nosort\nSELECT 1\n----\n1\n"),
    /unsupported/,
  );
  assert.throws(
    () =>
      verifyLogicResult(
        {
          kind: "query",
          line: 1,
          sql: "SELECT 1",
          types: "I",
          sort: "nosort",
          expected: [],
          hash: { count: 1, md5: "0".repeat(32) },
        },
        [[1n]],
      ),
    /received/,
  );
});
test("MoonBit returns positional columns without losing duplicate result names", () => {
  assert.deepEqual(
    new MoonDatabase().queryValues("SELECT 1 AS same,2 AS same"),
    [[1n, 2n]],
  );
});
test("MoonBit passes all 1000 original upstream select1 queries without exclusions", () => {
  const db = new MoonDatabase();
  const native = new NodeDatabase(":memory:");
  try {
    assert.deepEqual(
      differentialLogicTest(
        records,
        {
          execute: (sql) => native.run(sql),
          query: (sql) => nativeValues(native, sql),
        },
        { execute: (sql) => db.run(sql), query: (sql) => db.queryValues(sql) },
      ),
      { statements: 31, queries: 1000 },
    );
  } finally {
    native.close();
  }
});
