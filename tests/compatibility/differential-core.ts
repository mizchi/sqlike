import type { Value } from "../../src/contract.ts";
import type {
  DifferentialCase,
  DifferentialDriver,
  DifferentialTrace,
  DifferentialDifference,
  SqlOutcome,
  SqlDatum,
} from "./differential-contract.ts";
export function datum(value: Value): SqlDatum {
  if (value === null) return { type: "null" };
  if (typeof value === "bigint")
    return { type: "integer", value: String(value) };
  if (typeof value === "number")
    return { type: "real", value: Object.is(value, -0) ? "-0" : String(value) };
  if (typeof value === "string") return { type: "text", value };
  return { type: "blob", value: Array.from(value) };
}
export function value(cell: SqlDatum): Value {
  switch (cell.type) {
    case "null":
      return null;
    case "integer":
      return BigInt(cell.value);
    case "real":
      return Number(cell.value);
    case "text":
      return cell.value;
    case "blob":
      return Uint8Array.from(cell.value);
  }
}
export function sqlError(
  error: unknown,
): Extract<SqlOutcome, { kind: "error" }> {
  const message = error instanceof Error ? error.message : String(error);
  const item = error as { code?: string; errcode?: number };
  const category = /datatype|cannot store|type mismatch/i.test(message)
    ? "datatype"
    : /not null/i.test(message)
      ? "not-null"
      : /unique|primary key constraint/i.test(message)
        ? "unique"
        : /foreign key/i.test(message)
          ? "foreign-key"
          : /check constraint/i.test(message)
            ? "check"
            : /overflow/i.test(message)
              ? "overflow"
              : /ambiguous/i.test(message)
                ? "ambiguous"
                : /json/i.test(message)
                  ? "json"
                  : /no such|unknown column|cannot drop referenced column/i.test(
                        message,
                      )
                    ? "name"
                    : /syntax|expected|unsupported|trailing|USING|NATURAL/i.test(
                          message,
                        )
                      ? "syntax"
                      : "other";
  return {
    kind: "error",
    category,
    message,
    ...(item?.code || item?.errcode
      ? { code: String(item.errcode ?? item.code) }
      : {}),
  };
}
export function runTrace(
  c: DifferentialCase,
  driver: DifferentialDriver,
  { schema = true }: { schema?: boolean } = {},
): DifferentialTrace {
  const setup: SqlOutcome[] = [];
  for (const op of [
    ...(schema ? c.schema.map((sql) => ({ sql })) : []),
    ...(c.seed ?? []),
  ]) {
    const result = driver.execute(op);
    setup.push(result);
    if (result.kind === "error") return { setup, steps: [], setupFailed: true };
  }
  const steps = c.steps.map((op) => ({
    outcome: driver.execute(op),
    observations: (c.observe ?? []).map((q) => driver.execute(q)),
  }));
  return { setup, steps, setupFailed: false };
}
function equivalent(a: SqlOutcome, b: SqlOutcome): boolean {
  if (a.kind === "error" && b.kind === "error")
    return a.category === b.category;
  if (a.kind !== "rows" || b.kind !== "rows") return false;
  // Compare names only when both ABIs expose positional metadata.
  return (
    JSON.stringify(a.rows) === JSON.stringify(b.rows) &&
    (!a.columns ||
      !b.columns ||
      JSON.stringify(a.columns) === JSON.stringify(b.columns))
  );
}
export function compareTraces(
  a: DifferentialTrace,
  b: DifferentialTrace,
): DifferentialDifference[] {
  const out: DifferentialDifference[] = [];
  const missing: SqlOutcome = {
    kind: "error",
    category: "not-executed",
    message: "not executed after setup failure",
  };
  const compare = (
    phase: string,
    x: SqlOutcome = missing,
    y: SqlOutcome = missing,
  ) => {
    if (!equivalent(x, y)) out.push({ phase, expected: x, actual: y });
  };
  for (let i = 0; i < Math.max(a.setup.length, b.setup.length); i++)
    compare(`setup[${i}]`, a.setup[i], b.setup[i]);
  for (let i = 0; i < Math.max(a.steps.length, b.steps.length); i++) {
    compare(`step[${i}]`, a.steps[i]?.outcome, b.steps[i]?.outcome);
    for (
      let j = 0;
      j <
      Math.max(
        a.steps[i]?.observations.length ?? 0,
        b.steps[i]?.observations.length ?? 0,
      );
      j++
    )
      compare(
        `step[${i}].observe[${j}]`,
        a.steps[i]?.observations[j],
        b.steps[i]?.observations[j],
      );
  }
  return out;
}
