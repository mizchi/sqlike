/** Portable values preserve SQLite storage classes, signed zero and int64. */
export type SqlDatum =
  | { type: "null" }
  | { type: "integer" | "real" | "text"; value: string }
  | { type: "blob"; value: number[] };
export interface DifferentialOperation {
  sql: string;
  params?: SqlDatum[];
}
export interface DifferentialCase {
  id: string;
  family: string;
  scope: "supported" | "exploratory";
  schema: string[];
  seed?: DifferentialOperation[];
  steps: DifferentialOperation[];
  observe?: DifferentialOperation[];
  dynamicOnly?: boolean;
}
export type SqlOutcome =
  | { kind: "rows"; rows: SqlDatum[][]; columns?: string[] }
  | { kind: "error"; message: string; code?: string; category: string };
export interface DifferentialDriver {
  execute(operation: DifferentialOperation): SqlOutcome;
  close(): void;
}
export interface DifferentialTrace {
  setup: SqlOutcome[];
  steps: { outcome: SqlOutcome; observations: SqlOutcome[] }[];
  setupFailed: boolean;
}
export interface DifferentialDifference {
  phase: string;
  expected: SqlOutcome;
  actual: SqlOutcome;
}
export interface DifferentialResult {
  id: string;
  family: string;
  scope: DifferentialCase["scope"];
  target: string;
  status:
    | "matched"
    | "mismatch"
    | "unsupported"
    | "compile-rejection"
    | "not-applicable";
  differences: DifferentialDifference[];
  compileError?: string;
}
