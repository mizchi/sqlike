import { DatabaseSync } from "node:sqlite";
import { datum, value, sqlError, runTrace } from "./differential-core.ts";
import type {
  DifferentialCase,
  DifferentialDriver,
  DifferentialOperation,
  SqlOutcome,
  DifferentialTrace,
} from "./differential-contract.ts";
export function oracleDriver(): DifferentialDriver & {
  compile(op: DifferentialOperation): SqlOutcome;
} {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  return {
    close: () => db.close(),
    execute(op) {
      try {
        const s = db.prepare(op.sql);
        s.setReadBigInts(true);
        s.setReturnArrays(true);
        const rows = s.all(
          ...(op.params ?? []).map(value),
        ) as unknown as import("../../src/contract.ts").Value[][];
        return {
          kind: "rows",
          rows: rows.map((row) => row.map(datum)),
          columns: s.columns().map((c) => c.name),
        };
      } catch (e) {
        return sqlError(e);
      }
    },
    compile(op) {
      try {
        db.prepare(op.sql);
        return { kind: "rows", rows: [] };
      } catch (e) {
        return sqlError(e);
      }
    },
  };
}
export function oracleTraces(cases: DifferentialCase[]) {
  const traces: Record<string, DifferentialTrace> = {},
    compileErrors: Record<string, SqlOutcome | undefined> = {};
  for (const c of cases) {
    const db = oracleDriver();
    try {
      traces[c.id] = runTrace(c, db);
      const compile = oracleDriver();
      try {
        for (const sql of c.schema) compile.execute({ sql });
        for (const op of [
          ...(c.seed ?? []),
          ...c.steps,
          ...(c.observe ?? []),
        ]) {
          const r = compile.compile(op);
          if (r.kind === "error") {
            compileErrors[c.id] = r;
            break;
          }
        }
      } finally {
        compile.close();
      }
    } finally {
      db.close();
    }
  }
  return { traces, compileErrors };
}
