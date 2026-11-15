import type { Database, Value } from "../src/contract.ts";
import { doBindings } from "./do-bindings.ts";
import { supportedDoPragma } from "./do-statement.ts";
import {
  doReturning,
  doTypedFields,
  quoteDoIdentifier,
} from "./do-returning.ts";
type DOValue = number | string | null | ArrayBuffer;
export interface SQLStorage {
  sql: {
    exec(
      sql: string,
      ...params: DOValue[]
    ): { columnNames: string[]; toArray(): Record<string, DOValue>[] };
  };
  transactionSync<T>(body: () => T): T;
  sync?(): Promise<void>;
}
export interface DOMigrationOptions {
  /** Bind to ctx.blockConcurrencyWhile. Required for FK-disabled rebuilds. */
  exclusive<T>(body: () => Promise<T>): Promise<T>;
}
const quoted = quoteDoIdentifier;
/** Cloudflare returns JS numbers for both SQL numeric classes. Ask SQLite for
 * each class and stringify INTEGER before crossing that lossy host boundary. */
export class DODatabase implements Database {
  private transactionDepth = 0;
  private applyingMigration = false;
  constructor(
    private storage: SQLStorage,
    private migrations?: DOMigrationOptions,
  ) {}
  private execute(
    sql: string,
    params: Value[],
  ): { names: string[]; rows: Value[][] } {
    const bound = doBindings(sql, params),
      kind = bound.statement.kind,
      query = kind === "select" || kind === "values";
    if (
      kind === "pragma" &&
      (!bound.statement.pragma || !supportedDoPragma(bound.statement.pragma))
    )
      throw Error("unsupported DO PRAGMA");
    // A host's Number binding must actually be REAL. Never use a decimal CAST
    // as a substitute: it introduces affinity and can change comparisons.
    for (const value of params) {
      if (
        typeof value === "number" &&
        this.storage.sql.exec("SELECT typeof(?) AS type", value).toArray()[0]
          ?.type !== "real"
      )
        throw Error(
          "unsupported DO REAL binding: host changes its storage class",
        );
    }
    return this.storage.transactionSync(() => {
      const returning = bound.returning
        ? doReturning(bound, (table, schema) =>
            this.storage.sql
              .exec(
                "SELECT name,hidden FROM pragma_table_xinfo(?,?)",
                table,
                schema,
              )
              .toArray()
              .filter((c) => c.hidden !== 1)
              .map((c) => String(c.name)),
          )
        : undefined;
      const cursor = this.storage.sql.exec(
        returning?.sql ?? (query ? bound.sourceBody : bound.body),
        ...bound.values,
      );
      const names = returning?.names ?? cursor.columnNames,
        rows = cursor.toArray();
      if (query || returning) {
        const columns = names.map((_, i) => `_bls_c${i}`),
          fields = doTypedFields(columns.map(quoted));
        const body = bound.body;
        const typed = returning
          ? rows
          : this.storage.sql
              .exec(
                `WITH _bls_result(${columns.map(quoted).join(",")}) AS MATERIALIZED (${body}\n) SELECT ${fields} FROM _bls_result`,
                ...bound.values,
              )
              .toArray();
        const decoder = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        });
        return {
          names,
          rows: typed.map((row) =>
            names.map((_name, i) => {
              const v = row[`v${i}`],
                type = row[`t${i}`];
              let value: Value;
              switch (type) {
                case "integer":
                  if (typeof v !== "string")
                    throw Error("unsupported DO integer result");
                  value = BigInt(v);
                  break;
                case "real":
                  if (typeof v !== "number" || Number.isNaN(v))
                    throw Error("unsupported DO REAL result");
                  value = v;
                  break;
                case "text": {
                  if (
                    typeof v !== "string" ||
                    v.length % 2 ||
                    !/^[0-9A-F]*$/i.test(v)
                  )
                    throw Error("unsupported DO TEXT result");
                  const bytes = Uint8Array.from(
                    { length: v.length / 2 },
                    (_, j) => parseInt(v.slice(j * 2, j * 2 + 2), 16),
                  );
                  try {
                    value = decoder.decode(bytes);
                  } catch {
                    throw Error("unsupported DO non-UTF-8 TEXT result");
                  }
                  break;
                }
                case "blob":
                  if (!(v instanceof ArrayBuffer))
                    throw Error("unsupported DO BLOB result");
                  value = new Uint8Array(v);
                  break;
                case "null":
                  value = null;
                  break;
                default:
                  throw Error("unsupported DO result storage class");
              }
              return value;
            }),
          ),
        };
      }
      if (kind === "pragma") {
        return {
          names,
          rows: rows.map((row) =>
            names.map((name) => {
              const v = row[name]!;
              if (typeof v === "number") {
                if (!Number.isSafeInteger(v))
                  throw Error("unsupported DO PRAGMA integer range");
                return BigInt(v);
              }
              return v instanceof ArrayBuffer ? new Uint8Array(v) : v;
            }),
          ),
        };
      }
      if (names.length) throw Error("unsupported DO result-bearing statement");
      return { names: [], rows: [] };
    });
  }
  all(sql: string, params: Value[] = []): Record<string, Value>[] {
    const { names, rows } = this.execute(sql, params);
    return rows.map((row) =>
      Object.fromEntries(names.map((name, i) => [name, row[i]!])),
    );
  }
  values(sql: string, params: Value[] = []): Value[][] {
    return this.execute(sql, params).rows;
  }
  run(sql: string, params: Value[] = []): void {
    this.all(sql, params);
  }
  transaction<T>(body: () => T): T {
    return this.storage.transactionSync(() => {
      this.transactionDepth++;
      try {
        const result = body();
        if (result && typeof (result as { then?: unknown }).then === "function")
          throw Error("DO transaction body must be synchronous");
        return result;
      } finally {
        this.transactionDepth--;
      }
    });
  }
  savepoint<T>(body: () => T): T {
    return this.transaction(body);
  }
  /** Only called by the owner-supplied, hash-verified migration runner. SQL
   * trigger bodies are permitted here, never via ordinary remote run/all. */
  runMigration(sql: string): void {
    if (!this.applyingMigration)
      throw Error("trusted migration SQL requires migrationScope");
    this.storage.sql.exec(sql).toArray();
  }
  async migrationScope<T>(body: () => T, foreignKeysOff: boolean): Promise<T> {
    if (this.transactionDepth || this.applyingMigration)
      throw Error("migration requires an idle DO connection");
    const apply = () =>
      this.transaction(() => {
        this.applyingMigration = true;
        try {
          return body();
        } finally {
          this.applyingMigration = false;
        }
      });
    if (!foreignKeysOff) return apply();
    if (!this.migrations || !this.storage.sync)
      throw Error(
        "backend cannot safely disable foreign keys without DO exclusive migration scope",
      );
    type Outcome = { ok: true; value: T } | { ok: false; error: unknown };
    const result = await this.migrations.exclusive(
      async (): Promise<Outcome> => {
        // FK PRAGMAs silently do nothing inside an existing SQLite transaction.
        // Drain workerd's implicit transaction before disabling and restoring.
        await this.storage.sync!();
        const mode = () =>
          this.storage.sql.exec("PRAGMA foreign_keys").toArray()[0]
            ?.foreign_keys;
        const enabled = mode();
        if (enabled !== 0 && enabled !== 1)
          throw Error("unsupported DO foreign key mode");
        try {
          this.storage.sql.exec("PRAGMA foreign_keys=OFF");
          if (mode() !== 0)
            throw Error("cannot safely disable foreign keys for DO migration");
          return { ok: true, value: apply() };
        } catch (error) {
          // blockConcurrencyWhile resets the object when its callback throws.
          // Restore a normal migration rejection before rethrowing outside it.
          return { ok: false, error };
        } finally {
          await this.storage.sync!();
          this.storage.sql.exec(
            `PRAGMA foreign_keys=${enabled ? "ON" : "OFF"}`,
          );
          if (mode() !== enabled)
            throw Error("cannot restore DO foreign key mode after migration");
        }
      },
    );
    if (!result.ok) throw result.error;
    return result.value;
  }
}
