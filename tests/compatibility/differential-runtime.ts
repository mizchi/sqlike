import type * as SQL from "../../_build/js/release/build/mizchi/sqlike/sqlike.js";
import type * as AOT from "../../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import { aotBindings, aotValue } from "../../src/aot-values.ts";
import { createSqlStatementCache } from "../../src/sql-statement-cache.ts";
import {
  datum,
  value,
  sqlError,
  runTrace,
  compareTraces,
} from "./differential-core.ts";
import type {
  DifferentialCase,
  DifferentialDriver,
  DifferentialTrace,
  DifferentialResult,
  SqlOutcome,
  DifferentialOperation,
} from "./differential-contract.ts";
export interface DifferentialRuntime {
  sql: typeof SQL;
  aot: typeof AOT;
  compile: (source: string) => string;
}
const check = (s: string) => {
  const r = JSON.parse(s);
  if (r.error) throw Object.assign(Error(r.error), { code: r.code });
  return r;
};
export function dynamicDriver(runtime: typeof SQL, prepared = false): DifferentialDriver {
  const db = runtime.database_open();
  const cache = createSqlStatementCache(prepared ? { capacity: 32 } : undefined, sql => runtime.database_prepare(db, sql));
  return {
    close() { cache?.clear(); },
    execute(op) {
      try {
        const bindings = aotBindings((op.params ?? []).map(value));
        const entry = cache?.get(op.sql);
        const readonly = runtime.database_is_readonly(op.sql);
        const r = check(
          entry ? runtime.database_prepared_exec(entry.handle, bindings, readonly, readonly) : readonly
            ? runtime.database_query_values(db, op.sql, bindings)
            : runtime.database_exec(db, op.sql, bindings, false),
        );
        return {
          kind: "rows",
          rows: r.rows.map((r: any) =>
            (Array.isArray(r) ? r : Object.values(r)).map(aotValue).map(datum),
          ),
        };
      } catch (e) {
        return sqlError(e);
      }
    },
  };
}
export function compiledDriver(
  runtime: typeof AOT,
  c: DifferentialCase,
  compile: DifferentialRuntime["compile"],
): DifferentialDriver {
  const operations = [...(c.seed ?? []), ...c.steps, ...(c.observe ?? [])];
  const unique = [...new Set(operations.map((op) => op.sql))];
  const names = new Map(unique.map((sql, i) => [sql, `q${i}`]));
  const artifact = compile(
    JSON.stringify({
      schema: c.schema,
      queries: unique.map((sql) => ({ name: names.get(sql)!, sql })),
    }),
  );
  check(artifact);
  const db = runtime.aot_open(artifact, "");
  check(runtime.aot_info(db));
  return {
    close() {},
    execute(op) {
      try {
        const r = check(
          runtime.aot_execute(
            db,
            names.get(op.sql)!,
            aotBindings((op.params ?? []).map(value)),
          ),
        );
        return {
          kind: "rows",
          rows: r.rows.map((r: any[]) => r.map(aotValue).map(datum)),
          columns: r.names,
        };
      } catch (e) {
        return sqlError(e);
      }
    },
  };
}
export function auditTarget(
  cases: DifferentialCase[],
  oracles: Record<string, DifferentialTrace>,
  runtime: DifferentialRuntime,
  target: string,
  compiled: boolean,
  oracleCompileErrors: Record<string, SqlOutcome | undefined> = {},
  prepared = false,
): DifferentialResult[] {
  return cases.map((c) => {
    const base = {
      id: c.id,
      family: c.family,
      scope: c.scope,
      target,
      differences: [],
    };
    if (compiled && c.dynamicOnly) return { ...base, status: "not-applicable" };
    let driver: DifferentialDriver;
    try {
      driver = compiled
        ? compiledDriver(runtime.aot, c, runtime.compile)
        : dynamicDriver(runtime.sql, prepared);
    } catch (e) {
      return {
        ...base,
        status:
          oracleCompileErrors[c.id]?.kind === "error"
            ? "compile-rejection"
            : "unsupported",
        compileError: e instanceof Error ? e.message : String(e),
      };
    }
    try {
      const actual = runTrace(c, driver, { schema: !compiled });
      const expected = oracles[c.id]!;
      // Compiled schema has already run during artifact construction.
      const comparable = compiled
        ? { ...expected, setup: expected.setup.slice(c.schema.length) }
        : expected;
      const differences = compareTraces(comparable, actual);
      const unsupported = differences.some(
        (d) =>
          d.expected.kind === "rows" &&
          d.actual.kind === "error" &&
          /unsupported|SQL syntax|no such table/i.test(d.actual.message),
      );
      return {
        ...base,
        status: unsupported
          ? "unsupported"
          : differences.length
            ? "mismatch"
            : "matched",
        differences,
      };
    } finally {
      driver.close();
    }
  });
}
