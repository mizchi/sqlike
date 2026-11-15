import { test } from "node:test";
import { compareQueries } from "./compatibility/sqlike-paths.ts";
const schema = [
  "CREATE TABLE t(id INTEGER PRIMARY KEY,g TEXT,n INTEGER,s TEXT)",
];
const seed = [
  "INSERT INTO t VALUES(1,'a',2,'x'),(2,'a',2,NULL),(3,'a',5,'z'),(4,'b',1,'q'),(5,'b',NULL,''),(6,'b',3,'r')",
];
test("group_concat/string_agg and DISTINCT aggregates match SQLite including NULL and separators", async () => {
  await compareQueries(
    [
      "SELECT g,group_concat(s),group_concat(s,'|'),string_agg(s,':'),count(DISTINCT n),sum(DISTINCT n) FROM t GROUP BY g ORDER BY g",
      "SELECT group_concat(DISTINCT g) FROM t",
      "SELECT group_concat(s) FROM t WHERE id<0",
    ],
    schema,
    seed,
  );
});
test("partitioned window offsets, ranking and cumulative/rolling aggregates match SQLite on four paths", async () => {
  await compareQueries(
    [
      "SELECT id,lag(n) OVER(PARTITION BY g ORDER BY id),lead(n,2,-1) OVER(PARTITION BY g ORDER BY id) FROM t ORDER BY id",
      "SELECT id,sum(n) OVER(PARTITION BY g ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW),avg(n) OVER(ORDER BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) FROM t ORDER BY id",
      "SELECT id,sum(n) OVER(PARTITION BY g ORDER BY n),row_number() OVER(PARTITION BY g ORDER BY n,id),rank() OVER(PARTITION BY g ORDER BY n),dense_rank() OVER(PARTITION BY g ORDER BY n) FROM t ORDER BY id",
      "SELECT id,first_value(n) OVER(PARTITION BY g ORDER BY id),last_value(n) OVER(PARTITION BY g ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING),nth_value(n,2) OVER(PARTITION BY g ORDER BY id) FROM t ORDER BY id",
      "SELECT id,lag(n,0) OVER(ORDER BY id)+coalesce(lead(n) OVER(ORDER BY id),0) FROM t ORDER BY id",
      "SELECT id,count(*) OVER(PARTITION BY g),group_concat(s,'|') OVER(PARTITION BY g ORDER BY id),min(n) OVER(PARTITION BY g ORDER BY id),max(n) OVER(PARTITION BY g ORDER BY id) FROM t ORDER BY id",
    ],
    schema,
    seed,
  );
});

test("window aggregates consume grouped values rather than the representative source row", async () => {
  await compareQueries(
    [
      "SELECT g,sum(n),sum(sum(n)) OVER(ORDER BY g ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW),lag(sum(n)) OVER(ORDER BY g) FROM t GROUP BY g ORDER BY g",
      "SELECT g,count(*),sum(count(*)) OVER() FROM t GROUP BY g ORDER BY g",
    ],
    schema,
    seed,
  );
});
