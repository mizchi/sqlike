import type { Cell, Change, Statement, Value } from "./contract.ts";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface SchemaStamp { epoch: string; generation: number; signature: string }
export interface StatementEffect { affected: number; changes: string; result: string; schema: string }
export interface ReadAssertion { name: string; query: Statement; exactly: number }
export interface ExecuteOptions { policy?: string; intent?: JsonValue; assertions?: ReadAssertion[] }
export interface OperationGuard {
  version: 2;
  schema: SchemaStamp;
  policy: string;
  intent: JsonValue;
  assertions: ReadAssertion[];
  proof?: StatementEffect[];
}
export interface SyncIssue {
  kind: "ambiguous" | "schema" | "integrity" | "application" | "transport" | "resource";
  code: string;
  message: string;
  disposition: "defer" | "reject";
  retryable: boolean;
  /** Set only by the authority after a rejected transaction has rolled back. */
  authoritative?: boolean;
  details?: JsonValue;
}
export interface PolicyContext {
  opId: string;
  mode: "sql" | "changeset";
  base: number;
  head: number;
  guard: OperationGuard;
  schema: SchemaStamp;
  statements?: Statement[];
  changes?: Change[];
  actual?: StatementEffect[];
  issue?: SyncIssue;
}
export type ReadonlyQuery = (statement: Statement) => Record<string, Value>[];
export type GateDecision = { action: "apply" } | { action: "defer" | "reject"; reason: string };
export type AmbiguousDecision = Exclude<GateDecision, { action: "apply" }> | {
  action: "resolve";
  reason: string;
  statements: Statement[];
  assertions: ReadAssertion[];
};
/** Trusted, synchronous application code installed on the authority. */
export interface ApplyPolicy {
  before?(context: Readonly<PolicyContext>, read: ReadonlyQuery): GateDecision;
  onAmbiguous?(context: Readonly<PolicyContext> & { issue: SyncIssue }, read: ReadonlyQuery): AmbiguousDecision;
  after?(context: Readonly<PolicyContext>, read: ReadonlyQuery): GateDecision;
}
export interface EngineOptions { policies?: Record<string, ApplyPolicy> }
export interface ReplacementOperation extends ExecuteOptions { mode: "sql" | "changeset"; statements: Statement[] }
export type ClientResolution = { action: "defer" | "reject"; reason: string } | {
  action: "replace"; reason: string; operations: ReplacementOperation[];
};
export interface ClientOptions {
  retry?: { attempts?: number; delayMs?: number };
  onIssue?(context: { issue: SyncIssue; pending: readonly import("./contract.ts").Pending[] }): ClientResolution | Promise<ClientResolution>;
  onReplicaIssue?(context: { issue: SyncIssue; replica?: import("./contract.ts").ReplicaState }): { action: "defer" | "retry" | "resnapshot"; reason: string } | Promise<{ action: "defer" | "retry" | "resnapshot"; reason: string }>;
}
export interface Execution { effects: StatementEffect[]; results: Record<string, Cell>[][]; schemaChanged: boolean }
