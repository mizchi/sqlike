import { test } from "node:test";
import assert from "node:assert/strict";
import { sixPaths } from "./compatibility/six-paths.ts";
import { MoonDatabase } from "../adapters/moon-database.ts";
import { compareSixQueries } from "./compatibility/six-paths.ts";

test("sqlite_schema TEXT affinity survives predicates and derived columns", async () => {
  await compareSixQueries(
    [
      "SELECT name,name=3,tbl_name=3,name IN(3) FROM sqlite_schema WHERE name=3",
      "SELECT name FROM sqlite_master WHERE name IN(3) AND tbl_name=3",
      "SELECT x,x=3 FROM (SELECT name AS x FROM sqlite_schema) WHERE x=3",
      "SELECT 3 IN(SELECT name FROM sqlite_schema),3 IN(SELECT tbl_name FROM sqlite_master)",
      "SELECT name,name='3',sql='3' FROM sqlite_schema WHERE type='table' ORDER BY name",
    ],
    ['CREATE TABLE "3"(a)', 'CREATE VIEW v AS SELECT a FROM "3"'],
  );
});

test("untracked physical schema rootpage and rowid are explicitly rejected including stars and empty inputs", async () => {
  const moon = new MoonDatabase();
  try {
    moon.run("CREATE TABLE t(a)");
    for (const query of [
      "SELECT rootpage FROM sqlite_schema",
      "SELECT rowid FROM sqlite_master",
      "SELECT * FROM sqlite_schema",
      "SELECT s.* FROM sqlite_master s WHERE 0",
      "SELECT rootpage FROM sqlite_schema WHERE 0",
      "SELECT 1 FROM sqlite_schema WHERE rowid=1",
    ]) {
      assert.throws(
        () => moon.values(query),
        /unsupported.*schema.*(rootpage|rowid)/,
        query,
      );
      await assert.rejects(
        sixPaths(["CREATE TABLE t(a)"], [{ name: "q", sql: query }]),
        /unsupported.*schema.*(rootpage|rowid)/,
      );
    }
  } finally {
    moon.close();
  }
});
