import type { DifferentialResult } from "./differential-contract.ts";
export interface DifferentialReport {
  cases: { id: string; dynamicOnly?: boolean }[];
  results: DifferentialResult[];
  exportIntegrity?: { id: string; ok: boolean }[];
  oracleDrift?: unknown[];
  oracleSetupErrors?: string[];
}
/** Missing or duplicate cases must never silently turn a partial run green. */
export function differentialGate(
  report: DifferentialReport,
  targets: readonly string[],
): string[] {
  const problems: string[] = [];
  if (!report.cases.length) problems.push("empty corpus");
  const ids = new Set(report.cases.map((c) => c.id));
  if (ids.size !== report.cases.length) problems.push("duplicate case ids");
  for (const target of targets)
    for (const id of ids) {
      const rows = report.results.filter(
        (r) => r.target === target && r.id === id,
      );
      if (rows.length !== 1)
        problems.push(`${target} ${id}: missing or duplicate result`);
    }
  for (const r of report.results) {
    if (!ids.has(r.id) || !targets.includes(r.target))
      problems.push(`${r.target} ${r.id}: unexpected result`);
    if (r.status === "matched" && r.differences.length)
      problems.push(`${r.target} ${r.id}: matched result contains differences`);
    if (
      r.status === "not-applicable" &&
      (!r.target.endsWith("/aot") ||
        !report.cases.find((c) => c.id === r.id)?.dynamicOnly)
    )
      problems.push(`${r.target} ${r.id}: invalid exclusion`);
    if (r.status === "mismatch" || r.status === "unsupported")
      problems.push(`${r.target} ${r.id}: ${r.status}`);
    else if (
      !["matched", "compile-rejection", "not-applicable"].includes(r.status)
    )
      problems.push(`${r.target} ${r.id}: invalid status`);
  }
  for (const r of report.exportIntegrity ?? [])
    if (!r.ok) problems.push(`${r.id}: exported SQLite failed integrity_check`);
  if (report.oracleDrift?.length)
    problems.push(
      `Node/WASM oracles diverged: ${report.oracleDrift.length} observations`,
    );
  if (report.oracleSetupErrors?.length)
    problems.push(
      `invalid oracle setup: ${report.oracleSetupErrors.join(",")}`,
    );
  return problems;
}
