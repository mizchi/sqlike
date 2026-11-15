import type { Database, Value } from "./contract.ts";
/** Positional results are required: Object.values(all()) loses duplicate names
 * in JOINs/RETURNING. Transactions must include ORM decoding before commit. */
export interface DrizzleClient extends Database {
  values(sql: string, params?: Value[]): Value[][];
  /** Nested rollback without committing the containing transaction. */
  savepoint?<T>(body: () => T): T;
  /** Owner-controlled, already verified migration SQL (e.g. trigger bodies). */
  runMigration?(sql: string): void;
  /** Optional exclusive async platform scope; the body itself is synchronous. */
  migrationScope?<T>(body: () => T, foreignKeysOff: boolean): Promise<T>;
}
export interface DrizzleRunResult {
  changes: number;
  lastInsertRowid: bigint;
}
