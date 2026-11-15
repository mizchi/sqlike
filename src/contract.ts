/** BLS1 is our transport envelope; its kind=2 payload is native SQLite Session. */
export type Mode = "sql" | "changeset";
export type Cell =
  | { t: "null" | "undefined" }
  | { t: "integer"; v: string }
  | { t: "real"; v: number }
  | { t: "text"; v: string }
  | { t: "blob"; v: number[] };
/** SQL result representation; non-finite REAL never becomes JSON null. */
export type ResultCell =
  | Exclude<Cell, { t: "real" }>
  | { t: "real"; v: number | "Infinity" | "-Infinity" | "-0" };
export type Value = null | number | bigint | string | Uint8Array;
export interface Statement {
  sql: string;
  params: Cell[];
}
export interface Frame {
  kind: 1 | 2;
  base: number;
  opId: string;
  payload: Uint8Array;
}
export interface Change {
  table: string;
  pk: number[];
  op: 9 | 18 | 23;
  old: Cell[];
  new: Cell[];
}
export interface TableSnapshot {
  name: string;
  sql: string;
  columns: string[];
  rows: Cell[][];
}
export interface Snapshot {
  revision: number;
  tables: TableSnapshot[];
  schema: string[];
  schemaStamp: import("./safety-contract.ts").SchemaStamp;
}
export interface Ack {
  revision: number;
  duplicate: boolean;
  outcome: "applied" | "resolved";
  reason?: string;
  results?: Record<string, Cell>[][];
}
export interface Pending {
  id: string;
  mode: Mode;
  base: number;
  frame: number[];
  statements: Statement[];
  status: "pending" | "accepted" | "deferred" | "rejected";
  options?: import("./safety-contract.ts").ExecuteOptions;
  issue?: import("./safety-contract.ts").SyncIssue;
  receipt?: Ack;
}
export interface ReplicaState {
  txid: string;
  imageBytes: number;
  filesApplied: number;
  pagesApplied: number;
  bytesDownloaded: number;
}
export interface ClientState {
  revision: number;
  pending: Pending[];
  rows: Record<string, Cell>[];
  replica?: ReplicaState;
}
/** Platform boundary. Transactions must roll back data and journal together. */
export interface Database {
  /** Optional SQLite Session capture. SQL-only drivers omit it. */
  capture?(body: () => void): Uint8Array;
  /** INTEGER uses bigint, REAL uses number (including integral values).
   * TEXT must preserve NUL/BOM; reject byte text that cannot be represented. */
  all(sql: string, params?: Value[]): Record<string, Value>[];
  run(sql: string, params?: Value[]): void;
  transaction<T>(body: () => T): T;
  applyNativeChangeset?(bytes: Uint8Array): void;
  /** Optional materialized after-image scope. Both hooks must be provided. */
  replicaTransaction?<T>(body: () => T): T;
  /** Driver-owned scope for hosts whose FK mode is part of their saved image. */
  transactionWithoutForeignKeys?<T>(body: () => T): T;
  applyMaterialized?(body: () => void): void;
  /** Native SQLite/WASM support this; Durable Objects do not expose it. */
  schemaVersion?(): number;
}
