import { test } from "node:test";
import { compareQueries } from "./compatibility/sqlike-paths.ts";

test("aggregate FILTER preserves empty groups, DISTINCT, NULL and lazy argument evaluation", async () => {
  await compareQueries(
    [
      "SELECT count(*) FILTER(WHERE n>1),sum(n) FILTER(WHERE n>1),avg(n) FILTER(WHERE n>1),total(n) FILTER(WHERE n>1) FROM t",
      "SELECT min(n) FILTER(WHERE n>1),max(n) FILTER(WHERE n>1),group_concat(n,':') FILTER(WHERE n>1) FROM t",
      "SELECT count(DISTINCT g) FILTER(WHERE n>1),sum(DISTINCT n) FILTER(WHERE g='a') FROM t",
      "SELECT g,sum(n) FILTER(WHERE n>2),count(*) FILTER(WHERE NULL),total(n) FILTER(WHERE 0) FROM t GROUP BY g ORDER BY g",
      "SELECT sum(abs(n)) FILTER(WHERE n<>-9223372036854775808) FROM t",
      "SELECT sum(n) FILTER(WHERE 0),count(*) FILTER(WHERE 0),group_concat(n) FILTER(WHERE 0) FROM t WHERE 0",
    ],
    ["CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER,g TEXT)"],
    ["INSERT INTO t VALUES(1,1,'a'),(2,2,'a'),(3,3,'b'),(4,NULL,'b'),(5,-9223372036854775808,'c')"],
  );
});

test("window FILTER applies inside each frame and preserves grouped inputs", async () => {
  await compareQueries(
    [
      "SELECT id,sum(n) FILTER(WHERE n>1) OVER(ORDER BY id ROWS 1 PRECEDING),count(*) FILTER(WHERE n>1) OVER(ORDER BY id ROWS 1 PRECEDING) FROM t ORDER BY id",
      "SELECT id,group_concat(n,':') FILTER(WHERE n>1) OVER(ORDER BY id),min(n) FILTER(WHERE n>1) OVER() FROM t ORDER BY id",
      "SELECT g,sum(sum(n)) FILTER(WHERE sum(n)>3) OVER() FROM t GROUP BY g ORDER BY g",
    ],
    ["CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER,g TEXT)"],
    ["INSERT INTO t VALUES(1,1,'a'),(2,2,'a'),(3,3,'b'),(4,NULL,'b'),(5,4,'c')"],
  );
});
