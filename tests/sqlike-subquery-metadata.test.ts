import { test } from "node:test";
import { compareSixQueries } from "./compatibility/six-paths.ts";

test("compound scalar subqueries use rightmost affinity without inheriting source collation", async () => {
  await compareSixQueries(
    [
      "SELECT (SELECT '1' UNION ALL SELECT CAST('2' AS TEXT))=1,(SELECT CAST('1' AS TEXT) UNION ALL SELECT '2')=1",
      "SELECT (WITH c(v) AS(SELECT CAST('2' AS TEXT)) SELECT '1' UNION ALL SELECT v FROM c)=1",
      "SELECT (SELECT s FROM t)='A','A'=(SELECT s FROM t)",
      "SELECT (SELECT 'A')=s,s=(SELECT 'A'),(SELECT s FROM t) COLLATE NOCASE='A' FROM t",
      "SELECT CAST(s COLLATE NOCASE AS TEXT)='A' COLLATE BINARY,CAST(s COLLATE BINARY AS TEXT)='A' COLLATE NOCASE FROM t WHERE id=1",
      "SELECT v='A' FROM(SELECT ('a' COLLATE NOCASE)||'' AS v)q",
    ],
    ["CREATE TABLE t(id INTEGER PRIMARY KEY,s TEXT COLLATE NOCASE)"],
    ["INSERT INTO t VALUES(1,'a')"],
  );
});

test("compound affinity type combinations match SQLite across six paths", async () => {
  const expressions = [
    "NULL",
    "1",
    "'1'",
    "x'31'",
    "n",
    "r",
    "s",
    "CAST(1 AS INTEGER)",
    "CAST(1 AS REAL)",
    "CAST('1' AS TEXT)",
    "+r",
    "CASE WHEN 1 THEN r ELSE s END",
  ];
  const queries = expressions.flatMap((a) =>
    expressions.map(
      (b) =>
        `SELECT typeof(v),v=1,v='1',v IN(SELECT CAST(1 AS REAL)),(v,0) IN((1,0)) FROM(SELECT ${a} AS v FROM t UNION ALL SELECT ${b} FROM t)q`,
    ),
  );
  for (let offset = 0; offset < queries.length; offset += 16)
    await compareSixQueries(
      queries.slice(offset, offset + 16),
      ["CREATE TABLE t(n NUMERIC,r REAL,s TEXT,b BLOB)"],
      ["INSERT INTO t VALUES(1,1,'1',x'31')"],
    );
});

test("compound derived columns combine affinities without forcing REAL comparisons", async () => {
  await compareSixQueries(
    [
      "SELECT (q.v,0) IN((9007199254740993,0)) FROM(SELECT CAST(9007199254740993 AS REAL) AS v UNION ALL SELECT CAST(9007199254740993 AS REAL))q",
      "SELECT v='1',v=1,(v,0) IN((1,0)) FROM(SELECT 1 AS v UNION ALL SELECT CAST(2 AS INTEGER))q",
      "SELECT v=1,v='1' FROM(SELECT CAST('1' AS TEXT) AS v UNION ALL SELECT 2)q",
      "SELECT CAST(9007199254740993 AS REAL) IN(SELECT v) FROM(SELECT abs(9007199254740993) AS v UNION ALL SELECT CAST(2 AS INTEGER))q",
      "SELECT (v,0) IN((9007199254740993,0)) FROM(SELECT +r AS v FROM t UNION ALL SELECT CAST(2 AS REAL))q",
      "SELECT v,typeof(v),typeof(+v) FROM(SELECT 1 AS v UNION ALL SELECT CAST(2 AS REAL))q",
    ],
    ["CREATE TABLE t(r REAL)"],
    ["INSERT INTO t VALUES(9007199254740993)"],
  );
});
