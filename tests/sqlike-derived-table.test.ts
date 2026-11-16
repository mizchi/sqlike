import { test } from "node:test";
import { compareQueries } from "./compatibility/sqlike-paths.ts";
import { sqlikePaths } from "./compatibility/sqlike-paths.ts";
import assert from "node:assert/strict";

test("derived tables compose with joins, CTEs, bindings, limits, aggregates and outer scopes", async () => {
  await compareQueries(
    [
      "SELECT * FROM (SELECT 1 AS x,2 AS y)",
      "SELECT d.id,d.v FROM (SELECT id,v FROM t ORDER BY id DESC LIMIT 2) AS d ORDER BY d.id",
      "SELECT a.id,b.v FROM t AS a LEFT JOIN (SELECT id,v FROM t WHERE id=2) AS b ON a.id=b.id ORDER BY a.id",
      "WITH x AS (SELECT 7 AS v) SELECT d.v FROM (SELECT v FROM x) d",
      "SELECT sum(d.id) FROM (SELECT id FROM t WHERE id>1) d",
      "SELECT id,(SELECT d.x FROM (SELECT t.id+1 AS x) d) FROM t ORDER BY id",
      "SELECT d.x FROM (SELECT x FROM (SELECT 1 AS x UNION ALL SELECT 2) a) d ORDER BY 1 DESC",
      "SELECT a.x,b.y FROM (SELECT 1 AS x) a CROSS JOIN (SELECT 2 AS y) b",
    ],
    ["CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT)"],
    ["INSERT INTO t VALUES(1,'a'),(2,'b'),(3,'c')"],
  );
});

test("derived view identities survive declaration normalization and reopen", async () => {
  const paths = await sqlikePaths(
    ["  CREATE VIEW v AS SELECT x FROM (SELECT 1 AS x) d"],
    [{ name: "q", sql: "SELECT x FROM v" }],
  );
  for (const path of paths) {
    const image = path.dump();
    path.restore(image);
    assert.deepEqual(path.exec("q"), [[1n]]);
  }
});
