/** Errors must be found even in empty/unselected branches. A failed write must
 * also restore rows that were visited before the error occurred. */
export const preparationSetup = [
  "CREATE TABLE _conformance_guard(id INTEGER PRIMARY KEY,n INTEGER)",
  "INSERT INTO _conformance_guard VALUES(1,1),(2,2)",
];
export const preparationState =
  "SELECT id,n FROM _conformance_guard ORDER BY id";
export const preparationCases = [
  {
    sql: "SELECT CASE WHEN 1 THEN 1 ELSE missing END FROM _conformance_guard WHERE 0",
    error: "no such column",
  },
  { sql: "SELECT (SELECT 1,2)", error: "sub-select|subquery" },
  { sql: "SELECT 1 IN(SELECT 1,2)", error: "sub-select|subquery" },
  {
    sql: "SELECT EXISTS(SELECT missing FROM _conformance_guard WHERE 0)",
    error: "no such column",
  },
  {
    sql: "SELECT CASE WHEN 1 THEN abs(-9223372036854775808) ELSE 0 END",
    error: "integer overflow",
  },
  {
    sql: "UPDATE _conformance_guard SET n=CASE WHEN id=1 THEN 9 ELSE abs(-9223372036854775808) END",
    error: "integer overflow",
  },
  {
    sql: "INSERT INTO _conformance_guard VALUES(3,3),(4,abs(-9223372036854775808))",
    error: "integer overflow",
  },
  {
    sql: "UPDATE _conformance_guard SET n=(SELECT 1,2)",
    error: "sub-select|subquery",
  },
  {
    sql: "DELETE FROM _conformance_guard WHERE CASE WHEN id=1 THEN 1 ELSE abs(-9223372036854775808) END",
    error: "integer overflow",
  },
  {
    sql: "INSERT INTO _conformance_guard VALUES(3,3),(1,4)",
    error: "UNIQUE constraint failed",
  },
  {
    sql: "SELECT n FROM _conformance_guard WHERE CASE WHEN 1 THEN sum(n) ELSE 0 END",
    error: "misuse of aggregate",
  },
];
