import type { Value } from "../../src/contract.ts";

export type AuditStep = {
  kind: "exec" | "query" | "returning";
  sql: string;
  params?: Value[];
  error?: string;
  unordered?: boolean;
};
export type OracleRequirement = {
  kind: "function" | "pragma" | "module";
  name: string;
};
export interface AuditFeature {
  id: string;
  category: string;
  title: string;
  source: string;
  steps?: AuditStep[];
  reason?: string;
  exportName?: string;
  oracleRequirement?: OracleRequirement;
}
export interface AuditDriver {
  execute(step: AuditStep): Value[][];
  hasExport(name: string): boolean;
  /** Persisted data/schema/settings only; excludes SQLite connection counters. */
  dataState?(): string;
  close?(): void;
}
export interface OracleCapabilities {
  functions: string[];
  pragmas: string[];
  modules: string[];
}
export type AuditStatus =
  | "matched-probe"
  | "value-mismatch"
  | "candidate-error"
  | "oracle-error"
  | "oracle-unavailable"
  | "not-tested"
  | "missing-api";
export interface AuditResult {
  id: string;
  category: string;
  title: string;
  source: string;
  status: AuditStatus;
  rejectionsVerified?: boolean;
  witness?: {
    step: number;
    sql: string;
    expected?: string;
    actual?: string;
    error?: string;
    candidateRejected?: boolean;
    rejectionAtomic?: boolean;
    internalFailure?: boolean;
  };
  reason?: string;
}
// Preserve INTEGER/REAL, -0 and BLOB distinctions across JSON report boundaries.
export function typedValue(value: Value): unknown {
  if (value === null) return ["null"];
  if (typeof value === "bigint") return ["integer", String(value)];
  if (typeof value === "number")
    return ["real", Object.is(value, -0) ? "-0" : String(value)];
  if (typeof value === "string") return ["text", value];
  return ["blob", Array.from(value)];
}
export function typedRows(rows: Value[][], unordered = false): string {
  const result = rows.map((row) => JSON.stringify(row.map(typedValue)));
  if (unordered) result.sort();
  return "[" + result.join(",") + "]";
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
const bound = (s: string) => (s.length > 1200 ? s.slice(0, 1200) + "…" : s);
export function auditFeature(
  feature: AuditFeature,
  oracle: AuditDriver,
  candidate: AuditDriver,
  capabilities?: OracleCapabilities,
): AuditResult {
  const base = {
    id: feature.id,
    category: feature.category,
    title: feature.title,
    source: feature.source,
  };
  if (feature.exportName) {
    return {
      ...base,
      status: candidate.hasExport(feature.exportName)
        ? "not-tested"
        : "missing-api",
      reason: candidate.hasExport(feature.exportName)
        ? "Export exists; ABI/behavior not verified"
        : `Public interface does not export ${feature.exportName}`,
    };
  }
  if (!feature.steps?.length)
    return {
      ...base,
      status: "not-tested",
      reason: feature.reason ?? "No executable probe",
    };
  if (feature.oracleRequirement && capabilities) {
    const { kind, name } = feature.oracleRequirement;
    const available =
      capabilities[
        kind === "function"
          ? "functions"
          : kind === "pragma"
            ? "pragmas"
            : "modules"
      ];
    if (!available.includes(name))
      return {
        ...base,
        status: "oracle-unavailable",
        reason: `Native SQLite build has no ${kind} ${name}`,
      };
  }
  let rejectionsVerified = true;
  for (const [index, step] of feature.steps.entries()) {
    let expected: Value[][] = [],
      actual: Value[][] = [],
      referenceError: string | undefined,
      candidateError: string | undefined;
    let internalFailure = false;
    try {
      expected = oracle.execute(step);
    } catch (error) {
      referenceError = message(error);
    }
    if (
      step.error
        ? !referenceError || !new RegExp(step.error, "i").test(referenceError)
        : referenceError
    ) {
      return {
        ...base,
        status: "oracle-error",
        witness: {
          step: index,
          sql: step.sql,
          error: referenceError ?? `Expected oracle error ${step.error}`,
        },
      };
    }
    const before = candidate.dataState?.();
    try {
      actual = candidate.execute(step);
    } catch (error) {
      candidateError = message(error);
      internalFailure =
        (error instanceof Error &&
          [
            "TypeError",
            "ReferenceError",
            "RangeError",
            "InternalError",
          ].includes(error.name)) ||
        /TypeError|ReferenceError|InternalError|panic|unreachable|out of bounds|maximum call stack|is not a function/i.test(
          candidateError,
        );
    }
    const rejectionAtomic =
      candidateError && before !== undefined
        ? candidate.dataState?.() === before
        : undefined;
    if (candidateError && internalFailure)
      return {
        ...base,
        status: "candidate-error",
        witness: {
          step: index,
          sql: step.sql,
          error: candidateError,
          candidateRejected: true,
          rejectionAtomic,
          internalFailure: true,
        },
      };
    if (candidateError && rejectionAtomic === undefined)
      rejectionsVerified = false;
    if (candidateError && rejectionAtomic === false)
      return {
        ...base,
        status: "value-mismatch",
        reason: "Rejected statement changed data/schema/settings",
        witness: {
          step: index,
          sql: step.sql,
          error: candidateError,
          candidateRejected: true,
          rejectionAtomic: false,
        },
      };
    if (step.error) {
      if (!candidateError || !new RegExp(step.error, "i").test(candidateError))
        return {
          ...base,
          status: "candidate-error",
          witness: {
            step: index,
            sql: step.sql,
            expected: step.error,
            error: candidateError ?? "Candidate accepted rejected SQL",
            candidateRejected: !!candidateError,
            rejectionAtomic,
          },
        };
    } else {
      if (candidateError)
        return {
          ...base,
          status: "candidate-error",
          witness: {
            step: index,
            sql: step.sql,
            error: candidateError,
            candidateRejected: true,
            rejectionAtomic,
          },
        };
      const a = typedRows(actual, step.unordered),
        e = typedRows(expected, step.unordered);
      if (a !== e)
        return {
          ...base,
          status: "value-mismatch",
          witness: {
            step: index,
            sql: step.sql,
            expected: bound(e),
            actual: bound(a),
          },
        };
    }
  }
  return { ...base, status: "matched-probe", rejectionsVerified };
}
export function summarizeAudit(results: AuditResult[]) {
  const counts = Object.fromEntries(
    (
      [
        "matched-probe",
        "value-mismatch",
        "candidate-error",
        "oracle-error",
        "oracle-unavailable",
        "not-tested",
        "missing-api",
      ] as const
    ).map((status) => [
      status,
      results.filter((r) => r.status === status).length,
    ]),
  );
  return {
    total: results.length,
    counts,
    verdict: results.some((r) =>
      ["value-mismatch", "candidate-error", "missing-api"].includes(r.status),
    )
      ? "incompatible"
      : results.some((r) => r.status !== "matched-probe") || !results.length
        ? "incomplete-evidence"
        : "all-probes-matched",
    allCatalogProbesMatched:
      results.length > 0 && results.every((r) => r.status === "matched-probe"),
    universalEquivalenceProven: false,
  };
}
export function assertFullCompatibility(
  results: AuditResult[],
  requiredIds: string[],
): void {
  const ids = results.map((r) => r.id);
  if (new Set(ids).size !== ids.length)
    throw Error("Duplicate feature results");
  const missing = requiredIds.filter((id) => !ids.includes(id)),
    extra = ids.filter((id) => !requiredIds.includes(id));
  if (missing.length || extra.length)
    throw Error(
      `Feature report missing ${missing.length} entries; unexpected ${extra.length} entries`,
    );
  const failed = results.filter((r) => r.status !== "matched-probe");
  if (!requiredIds.length || failed.length)
    throw Error(
      `SQLite full compatibility not verified: ${failed.length}/${results.length} catalog entries lack a matching probe`,
    );
}

/** Unsupported features may reject, but no successful wrong result is allowed.
 * Unverified inventory items remain visible and are never counted as matches. */
export function assertOutputCompatibility(
  results: AuditResult[],
  requiredIds: string[],
): void {
  const ids = results.map((r) => r.id);
  if (
    !requiredIds.length ||
    new Set(ids).size !== ids.length ||
    new Set(requiredIds).size !== requiredIds.length ||
    ids.length !== requiredIds.length ||
    requiredIds.some((id) => !ids.includes(id))
  )
    throw Error("Output report is empty, duplicated or incomplete");
  const failed = results.filter(
    (r) =>
      r.status === "value-mismatch" ||
      r.status === "oracle-error" ||
      (r.status === "matched-probe" && r.rejectionsVerified !== true) ||
      (r.status === "candidate-error" &&
        (r.witness?.candidateRejected !== true ||
          r.witness.rejectionAtomic !== true ||
          r.witness.internalFailure === true)) ||
      ![
        "matched-probe",
        "candidate-error",
        "not-tested",
        "missing-api",
        "oracle-unavailable",
        "value-mismatch",
        "oracle-error",
      ].includes(r.status),
  );
  if (failed.length)
    throw Error(
      `SQLite output compatibility failed: ${failed.map((r) => r.id).join(", ")}`,
    );
  if (!results.some((r) => r.status === "matched-probe"))
    throw Error("Output report has no successful positive control");
}

/** Logical images include ephemeral last_rowid/changes for historical reasons. */
export function outputDataState(image: string): string {
  const parsed = JSON.parse(image);
  if (!parsed.state || parsed.format !== "moon-sql@1")
    throw Error("Invalid rejection state evidence");
  delete parsed.state.last_rowid;
  delete parsed.state.changes;
  return JSON.stringify(parsed.state);
}
