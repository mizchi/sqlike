import type { NodeDatabase } from "../../adapters/node-database.ts";
import type { Value } from "../../src/contract.ts";
/** Read by column position; object rows lose duplicate output column names. */
export function nativeValues(
  db: NodeDatabase,
  sql: string,
  params: Value[] = [],
): Value[][] {
  // Node 24's typings retain object rows after setReturnArrays(true).
  const stmt = db.raw.prepare(sql);
  stmt.setReadBigInts(true);
  stmt.setReturnArrays(true);
  return stmt.all(...params) as unknown as Value[][];
}
