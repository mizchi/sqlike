import type { ResultCell, Value } from "./contract.ts";
import type { BrowserDatabase } from "./backend-contract.ts";
import { aotBindings, aotValue } from "./aot-values.ts";
/** Opaque handles belong to the injected generated runtime, including Wasm GC. */
export interface CompiledRuntime<Handle = unknown> {
  aot_open(artifact: string, image: string): Handle;
  aot_info(db: Handle): string;
  aot_execute(db: Handle, name: string, bindings: string): string;
  aot_dump(db: Handle): string;
  aot_restore(db: Handle, image: string): string;
  aot_clone(db: Handle): Handle;
  aot_copy_connection_state(target: Handle, source: Handle): string;
  aot_set_clock(db: Handle, milliseconds: string): string;
}
function checked<T>(json: string): T {
  const value = JSON.parse(json);
  if (value.error)
    throw Object.assign(Error(value.error), { code: value.code });
  return value as T;
}
/** No default runtime import. The selected ESM/Wasm module is the entire engine.
 * Publication/persistence is an independent host responsibility. */
export function openCompiled<Handle>(
  runtime: CompiledRuntime<Handle>,
  artifact: string,
  image = "",
) {
  let db = runtime.aot_open(artifact, image);
  checked(runtime.aot_info(db));
  return {
    execute(
      name: string,
      params: Value[] = [],
    ): {
      names: string[];
      rows: Value[][];
      readonly: boolean;
      changes: number;
    } {
      checked(runtime.aot_set_clock(db, String(Date.now())));
      const r = checked<{
        names: string[];
        rows: ResultCell[][];
        readonly: boolean;
        changes: number;
      }>(runtime.aot_execute(db, name, aotBindings(params)));
      return { ...r, rows: r.rows.map((row) => row.map(aotValue)) };
    },
    dump: () => runtime.aot_dump(db),
    restore: (image: string) => {
      checked(runtime.aot_restore(db, image));
    },
    transaction<T>(body: () => T): T {
      const before = runtime.aot_clone(db);
      try {
        const value = body();
        if (value && typeof (value as { then?: unknown }).then === "function")
          throw Error("transaction must be synchronous");
        checked(runtime.aot_info(db));
        return value;
      } catch (e) {
        checked(runtime.aot_copy_connection_state(before, db));
        db = before;
        throw e;
      }
    },
  };
}

export interface SqlRuntime<Handle = unknown> {
  database_open(): Handle;
  database_exec(
    db: Handle,
    sql: string,
    bindings: string,
    readonly: boolean,
  ): string;
  database_dump(db: Handle): string;
  database_restore(db: Handle, image: string): string;
  database_clone(db: Handle): Handle;
  database_copy_connection_state(target: Handle, source: Handle): void;
  database_version(db: Handle): number;
  database_changeset?(db: Handle, before: Handle): string;
  database_exec_values?(db: Handle, sql: string, bindings: string): string;
  database_set_clock(db: Handle, milliseconds: string): string;
}
export interface SqlConnection extends BrowserDatabase {
  values(sql: string, params?: Value[]): Value[][];
  savepoint<T>(body: () => T): T;
  runMigration(sql: string): void;
  dump(): string;
  close(): void;
}
/** Synchronous SQL driver with an injected feature-selected runtime. No default
 * engine, sync protocol, persistence worker, FTS or LSM import is reachable here. */
export function openSql<Handle>(
  runtime: SqlRuntime<Handle>,
  image?: string,
): SqlConnection {
  let db = runtime.database_open(),
    active = false,
    closed = false;
  if (image !== undefined) checked(runtime.database_restore(db, image));
  const execute = (
    sql: string,
    params: Value[] = [],
    readonly = false,
  ): Record<string, Value>[] => {
    if (closed) throw Error("Sqlike connection is closed");
    checked(runtime.database_set_clock(db, String(Date.now())));
    const result = checked<{ rows: Record<string, ResultCell>[] }>(
      runtime.database_exec(db, sql, aotBindings(params), readonly),
    );
    return result.rows.map((row) =>
      Object.fromEntries(Object.entries(row).map(([k, v]) => [k, aotValue(v)])),
    );
  };
  const connection = {
    all: (sql: string, params?: Value[]) => execute(sql, params),
    query: (sql: string, params?: Value[]) => execute(sql, params, true),
    run: (sql: string, params?: Value[]) => {
      execute(sql, params);
    },
    runMigration: (sql: string) => { execute(sql); },
    values(sql: string, params: Value[] = []): Value[][] {
      if (closed) throw Error("Sqlike connection is closed");
      if (!runtime.database_exec_values)
        throw Error("runtime does not support positional results");
      checked(runtime.database_set_clock(db, String(Date.now())));
      const result = checked<{ rows: ResultCell[][] }>(
        runtime.database_exec_values(db, sql, aotBindings(params)),
      );
      return result.rows.map((row) => row.map(aotValue));
    },
    schemaVersion: () => runtime.database_version(db),
    dump: () => {
      if (closed) throw Error("Sqlike connection is closed");
      return runtime.database_dump(db);
    },
    close: () => {
      if (active) throw Error("cannot close an active transaction");
      closed = true;
    },
    transaction<T>(body: () => T): T {
      if (closed || active) throw Error("closed or nested Sqlike transaction");
      const before = runtime.database_clone(db);
      active = true;
      try {
        const result = body();
        if (result && typeof (result as { then?: unknown }).then === "function")
          throw Error("transaction must be synchronous");
        if (
          execute("PRAGMA foreign_keys")[0]?.foreign_keys === 1n &&
          execute("PRAGMA foreign_key_check").length
        )
          throw Error("FOREIGN KEY constraint failed");
        return result;
      } catch (e) {
        runtime.database_copy_connection_state(before, db);
        db = before;
        throw e;
      } finally {
        active = false;
      }
    },
    transactionWithoutForeignKeys<T>(body: () => T): T {
      return this.transaction(() => {
        const enabled = execute("PRAGMA foreign_keys")[0]!.foreign_keys;
        execute("PRAGMA foreign_keys=OFF");
        try {
          return body();
        } finally {
          execute(`PRAGMA foreign_keys=${enabled === 1n ? "ON" : "OFF"}`);
        }
      });
    },
    savepoint<T>(body: () => T): T {
      if (closed || !active) throw Error("savepoint requires an active transaction");
      if (body.constructor.name === "AsyncFunction")
        throw Error("savepoint must be synchronous");
      const before = runtime.database_clone(db);
      try {
        const result = body();
        if (result && typeof (result as { then?: unknown }).then === "function")
          throw Error("savepoint must be synchronous");
        return result;
      } catch (error) {
        runtime.database_copy_connection_state(before, db);
        db = before;
        throw error;
      }
    },
    ...(runtime.database_changeset
      ? {
          capture(body: () => void): Uint8Array {
            const capture = () => {
              const before = runtime.database_clone(db);
              checked(runtime.database_changeset!(db, before));
              body();
              return Uint8Array.from(
                checked<{ data: number[] }>(
                  runtime.database_changeset!(db, before),
                ).data,
              );
            };
            // A nested capture still owns rollback even if its caller catches the error.
            const before = runtime.database_clone(db);
            try {
              return active ? capture() : connection.transaction(capture);
            } catch (e) {
              runtime.database_copy_connection_state(before, db);
              db = before;
              throw e;
            }
          },
        }
      : {}),
  };
  return connection;
}
