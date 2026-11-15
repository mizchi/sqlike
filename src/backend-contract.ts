import type { Database, Snapshot, Value } from "./contract.ts";
/** All drivers provide guarded read-only queries and atomic data/outbox commits.
 * Session capture and physical SQLite images are optional, separate contracts. */
export interface BrowserDatabase extends Database {
  query(sql: string, params?: Value[]): Record<string, Value>[];
  snapshotOf?(image: Uint8Array): Snapshot;
}
