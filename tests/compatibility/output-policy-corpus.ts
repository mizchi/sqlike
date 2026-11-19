import type { Value } from "../../src/contract.ts";
import {
  generatedOutputPolicyCases,
  outputPolicySeeds,
} from "./output-generated-corpus.ts";
export interface OutputPolicyCase {
  schema: string[];
  seed: string[];
  sql: string;
  params?: Value[];
  mustReject: boolean;
  mustSucceed?: boolean;
  nativeError?: string;
  observe?: string[];
}
export function outputPolicyCases(): OutputPolicyCase[] {
  const cases: OutputPolicyCase[] = [];
  const add = (
    sql: string,
    mustReject = false,
    params?: Value[],
    schema = ["CREATE TABLE t(id INTEGER PRIMARY KEY,v INT)"],
    seed = ["INSERT INTO t VALUES(1,10),(2,20)"],
  ) => cases.push({ sql, mustReject, params, schema, seed });
  for (const sql of [
    "SELECT id,sum(v) FROM t",
    "SELECT count(*) FROM t HAVING id>1",
    "PRAGMA integrity_check",
    "PRAGMA integrity_check(t)",
    "PRAGMA quick_check",
    "SELECT hex(CAST(x'80' AS TEXT))",
    "SELECT CAST(x'00ff' AS TEXT)",
    "SELECT hex(lower(x'80'))",
    "SELECT hex(x'80'||'a')",
  ])
    add(sql, true);
  for (const [text, pattern] of [
    ["a\0b", "a"],
    ["a\0b", "a%"],
    ["ab", "a\0%"],
    ["é😀", "_😀"],
    ["AbC", "a_c"],
  ])
    add("SELECT ? LIKE ?", false, [text!, pattern!]);
  for (const sql of [
    "SELECT id,max(v) FROM t",
    "SELECT id,min(v) FROM t",
    "SELECT max(v),min(v),sum(v) FROM t",
    "SELECT sum(sum(v)) OVER() FROM t",
    "SELECT v,count(*) FROM t GROUP BY v ORDER BY v",
    "SELECT hex(x'80'),length(x'80'),typeof(x'80')",
    "SELECT hex(CAST(x'efbbbf61' AS TEXT))",
    "PRAGMA foreign_key_check(t)",
  ])
    add(sql);
  add("PRAGMA foreign_key_check(missing)");
  add(
    "UPDATE t SET v=CASE WHEN id=1 THEN 'ok' ELSE CAST(x'80' AS TEXT) END",
    true,
  );
  for (const pragma of ["table_info", "table_xinfo"])
    add(
      `PRAGMA ${pragma}(defaults)`,
      false,
      undefined,
      [
        "CREATE TABLE defaults(a REAL DEFAULT 1e2,b BLOB DEFAULT x'80',c TEXT DEFAULT NULL,d INT DEFAULT(+2),e TEXT DEFAULT('a''b'),f TEXT)",
      ],
      [],
    );
  return [
    ...cases,
    ...outputPolicySeeds.flatMap((seed) => generatedOutputPolicyCases(seed)),
  ];
}
