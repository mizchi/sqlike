import type { SyncIssue } from "./safety-contract.ts";

export class SyncFailure extends Error {
  constructor(readonly issue: SyncIssue) { super(issue.message); this.name = "SyncFailure"; }
}
export function failure(code: string, message: string, kind: SyncIssue["kind"] = "ambiguous", disposition: SyncIssue["disposition"] = "defer"): SyncFailure {
  return new SyncFailure({ code, message, kind, disposition, retryable: false });
}
export function issueOf(error: unknown): SyncIssue {
  if (error instanceof SyncFailure) return error.issue;
  if (error && typeof error === "object" && "issue" in error && (error as { issue?: SyncIssue }).issue) return (error as { issue: SyncIssue }).issue;
  return { kind: "transport", code: "unavailable", message: error instanceof Error ? error.message : String(error), disposition: "defer", retryable: true };
}
export function wireError(error: unknown): { status: number; body: { error: string; issue: SyncIssue } } {
  const issue = error instanceof SyncFailure ? error.issue : { kind: "application", code: "execution", message: error instanceof Error ? error.message : String(error), disposition: "reject", retryable: false } as SyncIssue;
  return { status: issue.retryable ? 503 : issue.disposition === "reject" ? 422 : 409, body: { error: issue.message, issue } };
}
