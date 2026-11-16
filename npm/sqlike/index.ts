import * as runtime from "../../_build/js/release/build/mizchi/sqlike/sqlike.js";
import { openSql } from "../../src/sqlike-runtime.ts";
export type { SqlConnection } from "../../src/sqlike-runtime.ts";
export type { Value } from "../../src/contract.ts";
/** An in-memory connection. Reopen a dump by passing its serialized image. */
export function openDatabase(image?: string) {
  return openSql(runtime, image);
}
