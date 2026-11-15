import * as runtime from "../_build/js/release/build/mizchi/sqlike/defined/defined.js";
import { createDefinedDatabase } from "./defined-database-core.ts";
export type {
  DefinedRuntime,
  DefinedExecution,
} from "./defined-database-core.ts";
export {
  createDefinedDatabase,
  DefinedStatement,
} from "./defined-database-core.ts";
/** Convenience entry with all built-in execution features. */
export const DefinedDatabase = createDefinedDatabase(runtime);
export type DefinedDatabase = Awaited<
  ReturnType<typeof DefinedDatabase.memory>
>;
