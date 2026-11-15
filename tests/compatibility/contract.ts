import type { ResultCell, Statement } from "../../src/contract.ts";
import type { StatementEffect } from "../../src/safety-contract.ts";

export type CompatibilityStep =
  | { kind: "execute"; statements: Statement[]; error?: string }
  | { kind: "query"; statement: Statement; ordered?: boolean; error?: string };
export interface CompatibilityCase {
  id: string;
  features: string[];
  steps: CompatibilityStep[];
}
export type CompatibilityResult =
  | { ok: true; effects?: StatementEffect[]; rows?: Record<string, ResultCell>[] }
  | { ok: false; error: string };
export interface CompatibilityDriver {
  execute(statements: Statement[]): Promise<CompatibilityResult>;
  query(statement: Statement): Promise<CompatibilityResult>;
}

/** Match stable failure classes, never hide an unknown failure as generic success. */
export function compatibilityError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  for (const [pattern, code] of [
    [/UNIQUE constraint failed/i, "constraint-unique"],
    [/NOT NULL constraint failed/i, "constraint-not-null"],
    [/CHECK constraint failed/i, "constraint-check"],
    [/FOREIGN KEY constraint failed/i, "constraint-foreign-key"],
    [/no such table/i, "missing-table"],
    [/SQL policy rejected/i, "sql-policy"],
  ] as const)
    if (pattern.test(message)) return code;
  return `unclassified:${message}`;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}
function comparable(
  result: CompatibilityResult,
  step: CompatibilityStep,
): string {
  if (result.ok && step.kind === "query" && !step.ordered && result.rows)
    return canonical({
      ...result,
      rows: [...result.rows].sort((a, b) =>
        canonical(a).localeCompare(canonical(b)),
      ),
    });
  return canonical(result);
}
export async function differentialCase(
  test: CompatibilityCase,
  oracle: CompatibilityDriver,
  candidate: CompatibilityDriver,
): Promise<number> {
  for (const [index, step] of test.steps.entries()) {
    const reference = await (step.kind === "execute"
      ? oracle.execute(step.statements)
      : oracle.query(step.statement));
    if (
      step.error
        ? reference.ok || reference.error !== step.error
        : !reference.ok
    )
      throw new Error(
        `${test.id} step ${index}: invalid oracle expectation: ${canonical(reference)}`,
      );
    const actual = await (step.kind === "execute"
      ? candidate.execute(step.statements)
      : candidate.query(step.statement));
    const expected = comparable(reference, step);
    const received = comparable(actual, step);
    if (expected !== received)
      throw new Error(
        `${test.id} step ${index}: differential mismatch\nSQL: ${canonical(step)}\nexpected: ${expected}\nreceived: ${received}`,
      );
  }
  return test.steps.length;
}
