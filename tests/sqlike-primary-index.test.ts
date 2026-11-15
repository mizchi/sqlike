import { test } from "node:test";
import { compareQueries } from "./compatibility/sqlike-paths.ts";
test("primary lookup tracks composite affinity/collation keys, rowid replacement, delete and rollback", async () => {
  await compareQueries(
    [
      "SELECT v FROM t WHERE a='ABC' AND b=1",
      "SELECT v FROM t WHERE b='1' AND a='abc' AND v='x'",
      "UPDATE t SET a='DEF',v='y' WHERE a='abc' AND b=1 RETURNING v",
      "SELECT v FROM t WHERE a='def' AND b=1",
      "SELECT v FROM t WHERE a='abc' AND b=1",
      "DELETE FROM t WHERE a='def' AND b=1 RETURNING v",
      "SELECT v FROM t WHERE a='def' AND b=1",
    ],
    [
      "CREATE TABLE t(a TEXT COLLATE NOCASE NOT NULL,b INTEGER NOT NULL,v TEXT,PRIMARY KEY(a,b))",
    ],
    ["INSERT INTO t VALUES('abc',1,'x'),('other',2,'z')"],
  );
  await compareQueries(
    [
      "SELECT v FROM t WHERE id=1",
      "UPDATE t SET id=3 WHERE id=1 RETURNING v",
      "SELECT v FROM t WHERE id=1",
      "SELECT v FROM t WHERE id=3",
      "DELETE FROM t WHERE id=3",
      "SELECT v FROM t WHERE id=3",
    ],
    ["CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT)"],
    ["INSERT INTO t VALUES(1,'x'),(2,'y')"],
  );
});
test("WITHOUT ROWID and RTRIM/blob primary keys retain lookup and rollback semantics", async () => {
  await compareQueries(
    [
      "SELECT v FROM t WHERE a='abc ' AND b=x'01'",
      "UPDATE t SET v='new' WHERE a='abc' AND b=x'01' RETURNING v",
      "SELECT v FROM t WHERE a='abc' AND b=x'01'",
      "SELECT * FROM t ORDER BY a,b",
    ],
    [
      "CREATE TABLE t(a TEXT COLLATE RTRIM,b BLOB,v TEXT,PRIMARY KEY(a,b)) WITHOUT ROWID",
    ],
    ["INSERT INTO t VALUES('abc',x'01','old'),('other',x'02','two')"],
  );
});
