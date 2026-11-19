import * as runtime from "./engine.ts";
import { openSql } from "../../src/sqlike-runtime.ts";
import type { SqlConnectionOptions } from "../../src/sqlike-runtime.ts";
export type { SqlConnection, SqlConnectionOptions } from "../../src/sqlike-runtime.ts";
export type { Value } from "../../src/contract.ts";
/** An in-memory connection. Reopen a dump by passing its serialized image. */
export function openDatabase(image?: string, options?: SqlConnectionOptions) {
  return openSql(runtime, image, options);
}
