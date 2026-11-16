import { test } from "node:test";
import { compareQueries } from "./compatibility/sqlike-paths.ts";

test("bitwise operations preserve SQLite int64 conversion, NULLs and operator precedence on four paths", async () => {
  const values = ["NULL", "0", "1", "-1", "9223372036854775807", "-9223372036854775808", "3.75", "'12.9'", "'1e3'", "'no'", "x'3132'"];
  const queries = values.flatMap((v) => [`SELECT ~(${v})`, ...values.flatMap((w) => [`SELECT (${v}) & (${w}), (${v}) | (${w})`])]);
  queries.push("SELECT 1 | 2 & 4, 1 << 2 | 3, 7 & 3 << 1, ~1 + 2, ~-9223372036854775808");
  await compareQueries(queries);
});

test("IS DISTINCT FROM aliases retain SQLite affinity, collation and boolean-literal semantics", async () => {
  const values = ["NULL", "0", "1", "2", "1.0", "'1'", "'a'", "'A'", "TRUE", "FALSE", "x'31'"];
  const queries = values.flatMap((a) => values.map((b) => `SELECT (${a}) IS DISTINCT FROM ${b}, (${a}) IS NOT DISTINCT FROM ${b}`));
  queries.push("SELECT s IS DISTINCT FROM 'a', i IS NOT DISTINCT FROM '1', i IS NOT DISTINCT FROM TRUE FROM t");
  await compareQueries(queries, ["CREATE TABLE t(i INTEGER,s TEXT COLLATE NOCASE)"], ["INSERT INTO t VALUES(1,'A')"]);
});

test("sign rejects nonnumeric values and matches SQLite storage classes", async () => {
  await compareQueries(["NULL", "0", "-0.0", "1", "-9223372036854775808", "1e999", "-1e999", "'12'", "' -2.5e2 '", "'1e2x'", "'no'", "x'31'"].map((v) => `SELECT sign(${v}),typeof(sign(${v}))`));
});
