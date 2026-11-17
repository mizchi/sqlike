import type * as AotRuntime from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import type * as SqlRuntime from "../_build/js/release/build/mizchi/sqlike/sqlike.js";
import type {
  Sqlite3Static,
  Database,
  PreparedStatement,
} from "@sqlite.org/sqlite-wasm";
import type { Cell } from "../src/contract.ts";
import { aotValue } from "../src/aot-values.ts";
import { createSqlStatementCache } from "../src/sql-statement-cache.ts";

export interface ComparisonQuery {
  name: string;
  sql: string;
  bindings: string;
  expected: Cell[][];
  iterations: number;
  warmup: number;
  write?: boolean;
  check?: { name: string; sql: string; bindings: string; expected: Cell[][] };
}
export interface ComparisonInput {
  artifact: string;
  schema: string[];
  rows: number;
  coldRows: number;
  runs: number;
  prepared?: boolean;
  retentionQuery?: { sql: string; bindings: string; expected: Cell[][] };
  batches: { name: string; sql: string; bindings: string }[];
  queries: ComparisonQuery[];
}
interface Driver {
  name: string;
  call(q: {
    name: string;
    sql: string;
    bindings: string;
    write?: boolean;
  }): Cell[][];
  raw?(q: {
    name: string;
    sql: string;
    bindings: string;
    write?: boolean;
  }): string;
  close(): void;
}
function response(text: string): { rows: Cell[][] } {
  const value = JSON.parse(text);
  if (value.error) throw Error(value.error);
  return value;
}
function equal(actual: unknown, expected: unknown, label: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw Error(`result mismatch: ${label}`);
}
function sqliteDriver(
  sqlite: Sqlite3Static,
  db: Database,
  cached: boolean,
): Driver {
  const statements = new Map<string, PreparedStatement>();
  const bindings = new Map<string, ReturnType<typeof aotValue>[]>();
  return {
    name: cached ? "sqlite/prepared" : "sqlite/dynamic",
    call(q) {
      if (!bindings.has(q.bindings))
        bindings.set(
          q.bindings,
          (JSON.parse(q.bindings) as Cell[]).map(aotValue),
        );
      let stmt = cached ? statements.get(q.sql) : undefined;
      if (!stmt) {
        stmt = db.prepare(q.sql);
        if (cached) statements.set(q.sql, stmt);
      }
      try {
        const values = bindings.get(q.bindings)!;
        if (values.length) stmt.bind(values);
        const rows: Cell[][] = [];
        while (stmt.step()) {
          const row: Cell[] = [];
          for (let i = 0; i < stmt.columnCount; i++) {
            const kind = sqlite.capi.sqlite3_column_type(stmt.pointer!, i);
            switch (kind) {
              case sqlite.capi.SQLITE_INTEGER:
                row.push({
                  t: "integer",
                  v: String(sqlite.capi.sqlite3_column_int64(stmt.pointer!, i)),
                });
                break;
              case sqlite.capi.SQLITE_FLOAT:
                row.push({ t: "real", v: stmt.getFloat(i)! });
                break;
              case sqlite.capi.SQLITE_TEXT:
                row.push({ t: "text", v: stmt.getString(i)! });
                break;
              case sqlite.capi.SQLITE_BLOB:
                row.push({ t: "blob", v: Array.from(stmt.getBlob(i)!) });
                break;
              default:
                row.push({ t: "null" });
            }
          }
          rows.push(row);
        }
        return rows;
      } finally {
        if (cached) stmt.reset();
        else stmt.finalize();
      }
    },
    close() {
      for (const stmt of statements.values()) stmt.finalize();
    },
  };
}
export async function createComparison(input: ComparisonInput) {
  const jsAot = (await import(
    /* @vite-ignore */ `${location.origin}/aotJS`
  )) as typeof AotRuntime;
  const jsSql = (await import(
    /* @vite-ignore */ `${location.origin}/sqlJS`
  )) as typeof SqlRuntime;
  const load = async (path: string) =>
    (
      await WebAssembly.instantiate(
        await (await fetch(path)).arrayBuffer(),
        {},
        { builtins: ["js-string"], importedStringConstants: "_" },
      )
    ).instance.exports;
  const wasmAot = (await load("/aotWasm")) as unknown as typeof AotRuntime;
  const wasmSql = (await load("/sqlWasm")) as unknown as typeof SqlRuntime;
  const sqlite = (await (
    await import(/* @vite-ignore */ `${location.origin}/sqliteSDK`)
  ).default()) as Sqlite3Static;
  const db = new sqlite.oo1.DB(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const sql of input.schema) db.exec(sql);
  const drivers: Driver[] = [];
  const cacheMemory: { engine: string; clear(): void; fill(): { entries: number; sqlBytes: number } }[] = [];
  for (const [name, aot, sql] of [
    ["js", jsAot, jsSql],
    ["wasm", wasmAot, wasmSql],
  ] as const) {
    const a = aot.aot_open(input.artifact, ""),
      d = sql.database_open();
    const info = JSON.parse(aot.aot_info(a));
    if (info.error) throw Error(info.error);
    for (const statement of input.schema)
      response(sql.database_exec(d, statement, "[]", false));
    const rawAot = (q: { name: string; bindings: string }) =>
      aot.aot_execute(a, q.name, q.bindings);
    const rawDynamic = (q: {
      sql: string;
      bindings: string;
      write?: boolean;
    }) =>
      q.write
        ? sql.database_exec(d, q.sql, q.bindings, false)
        : sql.database_query_values(d, q.sql, q.bindings);
    for (const batch of input.batches) {
      response(rawAot(batch));
      response(rawDynamic({ ...batch, write: true }));
    }
    drivers.push(
      {
        name: `sqlike-${name}/aot`,
        call: (q) => response(rawAot(q)).rows,
        raw: rawAot,
        close() {},
      },
      {
        name: `sqlike-${name}/dynamic`,
        call: (q) => response(rawDynamic(q)).rows,
        raw: rawDynamic,
        close() {},
      },
    );
    if (input.prepared) {
      const cached = sql.database_open();
      for (const statement of input.schema)
        response(sql.database_exec(cached, statement, "[]", false));
      for (const batch of input.batches)
        response(sql.database_exec(cached, batch.sql, batch.bindings, false));
      const cache = createSqlStatementCache({ capacity: 32 }, (text) => sql.database_prepare(cached, text))!;
      const raw = (q: { sql: string; bindings: string; write?: boolean }) => {
        const entry = cache.get(q.sql);
        return entry
          ? sql.database_prepared_exec(entry.handle, q.bindings, !q.write, !q.write)
          : q.write ? sql.database_exec(cached, q.sql, q.bindings, false)
          : sql.database_query_values(cached, q.sql, q.bindings);
      };
      drivers.push({ name: `sqlike-${name}/prepared`, call: q => response(raw(q)).rows, raw,
        close() { cache.clear(); } });
      cacheMemory.push({ engine: `sqlike-${name}/prepared`, clear: () => cache.clear(), fill() {
        cache.clear();
        const query = input.retentionQuery!;
        let sqlBytes = 0;
        for (let i = 0; i < 32; i++) {
          const item = { ...query, sql: query.sql + ` /*retained ${i}*/` };
          equal(response(raw(item)).rows, query.expected, "retained cache result");
          sqlBytes += item.sql.length * 2;
        }
        return { entries: 32, sqlBytes };
      } });
    }
  }
  const seed = sqliteDriver(sqlite, db, true);
  for (const batch of input.batches) seed.call(batch);
  seed.close();
  drivers.push(sqliteDriver(sqlite, db, true), sqliteDriver(sqlite, db, false));
  const plans = input.queries.map((q) => ({
    name: q.name,
    rows: db.selectArrays(
      `EXPLAIN QUERY PLAN ${q.sql}`,
      (JSON.parse(q.bindings) as Cell[]).map(aotValue),
    ),
  }));
  const samples: {
    name: string;
    engine: string;
    run: number;
    iterations: number;
    milliseconds: number;
  }[] = [];
  function verify(driver: Driver, q: ComparisonQuery) {
    equal(driver.call(q), q.expected, `${q.name}/${driver.name}`);
    if (q.check)
      equal(
        driver.call(q.check),
        q.check.expected,
        `${q.name}/side effect/${driver.name}`,
      );
  }
  return {
    sqliteVersion: sqlite.capi.sqlite3_libversion(),
    plans,
    measure() {
      const rangeQuery = input.queries.find((q) => q.name === "range");
      const firstRangeRead = rangeQuery
        ? drivers.map((driver) => {
            const start = performance.now();
            const actual = driver.call(rangeQuery);
            const milliseconds = performance.now() - start;
            equal(
              actual,
              rangeQuery.expected,
              `${driver.name}/first range read`,
            );
            return { engine: driver.name, milliseconds };
          })
        : [];
      for (const query of input.queries) {
        for (const driver of drivers) verify(driver, query);
        for (const driver of drivers)
          for (let i = 0; i < query.warmup; i++) driver.call(query);
        const iterations = new Map<Driver, number>();
        for (const driver of drivers) {
          let loops = query.iterations;
          if (input.runs > 1)
            for (let round = 0; round < 2; round++) {
              const start = performance.now();
              for (let i = 0; i < loops; i++) driver.call(query);
              const elapsed = Math.max(0.05, performance.now() - start);
              loops = Math.max(
                5,
                Math.min(1000000, Math.ceil((loops * 50) / elapsed)),
              );
            }
          iterations.set(driver, loops);
        }
        for (let run = 0; run < input.runs; run++) {
          const order = drivers.map(
            (_, i) => drivers[(run + i) % drivers.length]!,
          );
          if (run % 2) order.reverse();
          for (const driver of order) {
            const loops = iterations.get(driver)!;
            let count = 0;
            const start = performance.now();
            for (let i = 0; i < loops; i++) count += driver.call(query).length;
            const milliseconds = performance.now() - start;
            equal(
              count,
              loops * query.expected.length,
              `${query.name}/row count`,
            );
            samples.push({
              name: query.name,
              engine: driver.name,
              run,
              iterations: loops,
              milliseconds,
            });
          }
        }
        for (const driver of drivers) verify(driver, query);
      }
      // Diagnostic: host JSON.parse of a cached result, without DB execution.
      const decode = input.queries
        .filter((q) => ["constant", "scan"].includes(q.name))
        .map((q) => {
          const text = drivers[0]!.raw!(q),
            loops = Math.max(50, q.iterations),
            samples = [];
          for (let i = 0; i < 100; i++) response(text);
          for (let run = 0; run < input.runs; run++) {
            let count = 0;
            const start = performance.now();
            for (let i = 0; i < loops; i++) count += response(text).rows.length;
            const milliseconds = performance.now() - start;
            equal(count, loops * q.expected.length, "cached decode count");
            samples.push({ run, milliseconds, iterations: loops });
          }
          return { name: q.name, characters: text.length, samples };
        });
      const updateQuery = input.queries.find((q) => q.name === "update");
      const measureIndexWrites = (values: string[]) =>
        rangeQuery && updateQuery
          ? drivers.map((driver) => {
              const original = JSON.parse(updateQuery.bindings) as Cell[];
              const writes = values.map((value) => ({
                ...updateQuery,
                bindings: JSON.stringify([
                  { t: "integer", v: value },
                  ...original.slice(1),
                ]),
              }));
              let turn = 0;
              const cycle = () => {
                driver.call(writes[turn++ % writes.length]!);
                return driver.call(rangeQuery).length;
              };
              let loops = input.runs === 1 ? 5 : 10;
              if (input.runs > 1)
                for (let round = 0; round < 2; round++) {
                  const start = performance.now();
                  for (let i = 0; i < loops; i++) cycle();
                  loops = Math.max(
                    5,
                    Math.min(
                      1000000,
                      Math.ceil(
                        (loops * 50) /
                          Math.max(0.05, performance.now() - start),
                      ),
                    ),
                  );
                }
              const samples = [];
              for (let run = 0; run < input.runs; run++) {
                let count = 0;
                const start = performance.now();
                for (let i = 0; i < loops; i++) count += cycle();
                const milliseconds = performance.now() - start;
                equal(
                  count,
                  loops * rangeQuery.expected.length,
                  `${driver.name}/write then range row count`,
                );
                samples.push({ run, iterations: loops, milliseconds });
              }
              equal(
                driver.call(rangeQuery),
                rangeQuery.expected,
                `${driver.name}/write then range values`,
              );
              return { engine: driver.name, samples };
            })
          : [];
      const indexLifecycle = measureIndexWrites(["-7", "-8"]);
      // Also move the changed key across the entire index. Both values remain
      // outside the returned range, so the same native-verified rows apply.
      const indexMovement = measureIndexWrites([
        "-7",
        String(input.rows * 3 + 7),
      ]);
      return {
        samples,
        decode,
        firstRangeRead,
        indexLifecycle,
        indexMovement,
        verified: input.queries.length * drivers.length,
      };
    },
    profile(name: string, engine: string, durationMs: number) {
      const driver = drivers.find((d) => d.name === engine),
        query = input.queries.find((q) => q.name === name);
      if (!driver || !query) throw Error("unknown profile workload");
      let calls = 0,
        returnedRows = 0;
      const start = performance.now();
      while (performance.now() - start < durationMs) {
        returnedRows += driver.call(query).length;
        calls++;
      }
      return { calls, returnedRows, elapsedMs: performance.now() - start };
    },
    cacheMemory(engine: string, fill: boolean) {
      if (!fill) { cacheMemory.forEach(cache => cache.clear()); return undefined; }
      return cacheMemory.find(cache => cache.engine === engine)!.fill();
    },
    close() {
      for (const driver of drivers) driver.close();
      db.close();
    },
  };
}
declare global {
  interface Window {
    sqliteBench: Awaited<ReturnType<typeof createComparison>>;
  }
}
export async function installComparison(input: ComparisonInput) {
  window.sqliteBench = await createComparison(input);
  return {
    sqliteVersion: window.sqliteBench.sqliteVersion,
    plans: window.sqliteBench.plans,
  };
}
