import * as runtime from "./full-engine.ts";
import {
  openSql,
  type SqlConnectionOptions,
} from "../../src/sqlike-runtime.ts";
export type {
  SqlConnection,
  SqlConnectionOptions,
} from "../../src/sqlike-runtime.ts";
export type { Value } from "../../src/contract.ts";
export function openDatabase(image?: string, options?: SqlConnectionOptions) {
  return openSql(runtime, image, options);
}
