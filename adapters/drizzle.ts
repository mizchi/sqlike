import {
  Column,
  SQL,
  entityKind,
  fillPlaceholders,
  is,
  DefaultLogger,
  NoopLogger,
} from "drizzle-orm";
import type {
  Logger,
  Query,
  ExtractTablesWithRelations,
  RelationalSchemaConfig,
  TablesRelationalConfig,
} from "drizzle-orm";
import {
  createTableRelationsHelpers,
  extractTablesRelationalConfig,
} from "drizzle-orm/relations";
import {
  BaseSQLiteDatabase,
  SQLiteSyncDialect,
  SQLiteTransaction,
  customType,
} from "drizzle-orm/sqlite-core";
import {
  SQLiteSession,
  SQLitePreparedQuery,
} from "drizzle-orm/sqlite-core/session";
import type {
  PreparedQueryConfig,
  SQLiteExecuteMethod,
  SQLiteTransactionConfig,
} from "drizzle-orm/sqlite-core/session";
import type { SelectedFieldsOrdered } from "drizzle-orm/sqlite-core/query-builders/select.types";
import type { DrizzleConfig } from "drizzle-orm/utils";
import * as utils from "drizzle-orm/utils";
import type {
  DrizzleClient,
  DrizzleRunResult,
} from "../src/drizzle-contract.ts";
import type { Value } from "../src/contract.ts";

/** Drizzle 0.45.4 exports this runtime mapper but omits @internal declarations.
 * Keep the version-dependent contract here rather than recreating JOIN mapping. */
const mapper = (
  utils as unknown as {
    mapResultRow(
      fields: SelectedFieldsOrdered,
      row: unknown[],
      joins?: Record<string, boolean>,
    ): unknown;
  }
).mapResultRow;
function safeNumber(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number))
    throw RangeError(
      "Drizzle number column exceeds safe integer range; use sqliteInt64",
    );
  return number;
}
function params(values: unknown[]): Value[] {
  return values.map((value) => {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "bigint"
    )
      return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (value instanceof Uint8Array) return value.slice();
    throw TypeError(
      "unsupported Drizzle binding; encode values with a column type",
    );
  });
}
function syncCallback(callback: Function) {
  if (callback.constructor.name === "AsyncFunction")
    throw Error("Drizzle transaction callback must be synchronous");
}
function synchronous<T>(result: T): T {
  if (result && typeof (result as { then?: unknown }).then === "function")
    throw Error("Drizzle transaction callback must be synchronous");
  return result;
}

export const sqliteBytes = customType<{
  data: Uint8Array;
  driverData: Uint8Array;
}>({
  dataType: () => "blob",
  toDriver: (value) => value.slice(),
  fromDriver: (value) => Uint8Array.from(value),
});
export const sqliteInt64 = customType<{ data: bigint; driverData: bigint }>({
  dataType: () => "integer",
  toDriver: (value) => value,
  fromDriver: (value) => {
    if (typeof value !== "bigint")
      throw TypeError("expected int64 driver value");
    return value;
  },
});

type Schema = TablesRelationalConfig;
type Config<T extends Record<string, unknown>> = Pick<
  DrizzleConfig<T>,
  "schema" | "logger" | "casing"
>;
export class SqlikeDrizzleDatabase<
  T extends Record<string, unknown> = Record<string, never>,
> extends BaseSQLiteDatabase<"sync", DrizzleRunResult, T> {
  static override readonly [entityKind]: string = "SqlikeDrizzleDatabase";
  declare readonly $client: DrizzleClient;
}
export class DrizzleSession<
  TFull extends Record<string, unknown>,
  TSchema extends Schema,
> extends SQLiteSession<"sync", DrizzleRunResult, TFull, TSchema> {
  static override readonly [entityKind]: string = "SqlikeDrizzleSession";
  private depth = 0;
  get active() {
    return this.depth !== 0;
  }
  private savepointId = 0;
  constructor(
    readonly client: DrizzleClient,
    private dialectValue: SQLiteSyncDialect,
    private schemaValue: RelationalSchemaConfig<TSchema> | undefined,
    readonly logger: Logger,
  ) {
    super(dialectValue);
  }
  atomic<T>(body: () => T): T {
    if (this.depth) return this.nested(body);
    return this.client.transaction(() => {
      this.depth++;
      try {
        return synchronous(body());
      } finally {
        this.depth--;
      }
    });
  }
  prepareQuery<T extends PreparedQueryConfig>(
    query: Query,
    fields: SelectedFieldsOrdered | undefined,
    method: SQLiteExecuteMethod,
    arrayMode: boolean,
    customResultMapper?: (rows: unknown[][]) => unknown,
  ): DrizzlePrepared<T> {
    return new DrizzlePrepared<T>(
      this,
      query,
      fields,
      method,
      arrayMode,
      customResultMapper,
    );
  }
  transaction<T>(
    callback: (
      tx: SQLiteTransaction<"sync", DrizzleRunResult, TFull, TSchema>,
    ) => T,
    config?: SQLiteTransactionConfig,
  ): T {
    syncCallback(callback);
    if (config?.behavior)
      throw Error(
        "explicit Drizzle transaction behavior is unsupported by the portable driver",
      );
    const run = () =>
      synchronous(
        callback(
          new DrizzleTransaction(
            "sync",
            this.dialectValue,
            this,
            this.schemaValue,
          ),
        ),
      );
    if (!this.depth) return this.atomic(run);
    return this.nested(run);
  }
  private nested<T>(run: () => T): T {
    if (this.client.savepoint) return this.client.savepoint(run);
    const name = `__drizzle_sp_${this.savepointId++}`;
    this.client.run(`SAVEPOINT ${name}`);
    try {
      const result = run();
      this.client.run(`RELEASE ${name}`);
      return result;
    } catch (error) {
      this.client.run(`ROLLBACK TO ${name}`);
      this.client.run(`RELEASE ${name}`);
      throw error;
    }
  }
}
class DrizzleTransaction<
  TFull extends Record<string, unknown>,
  TSchema extends Schema,
> extends SQLiteTransaction<"sync", DrizzleRunResult, TFull, TSchema> {
  static override readonly [entityKind]: string = "SqlikeDrizzleTransaction";
  override transaction<T>(
    callback: (tx: DrizzleTransaction<TFull, TSchema>) => T,
  ): T {
    return (
      this as unknown as { session: DrizzleSession<TFull, TSchema> }
    ).session.transaction(callback);
  }
}
class DrizzlePrepared<
  T extends PreparedQueryConfig,
> extends SQLitePreparedQuery<T & { type: "sync"; run: DrizzleRunResult }> {
  static override readonly [entityKind]: string = "SqlikeDrizzlePreparedQuery";
  declare joinsNotNullableMap?: Record<string, boolean>;
  constructor(
    private owner: DrizzleSession<Record<string, unknown>, Schema>,
    query: Query,
    private fields: SelectedFieldsOrdered | undefined,
    method: SQLiteExecuteMethod,
    private arrayMode: boolean,
    private customMapper?: (rows: unknown[][]) => unknown,
  ) {
    super("sync", method, query);
  }
  private bound(values: Record<string, unknown> = {}) {
    const bound = params(fillPlaceholders(this.query.params, values));
    this.owner.logger.logQuery(this.query.sql, bound);
    return bound;
  }
  private mapped(rows: Value[][]): unknown {
    if (this.customMapper)
      throw Error(
        "Drizzle relational custom result mappers are not supported; use select/JOIN",
      );
    return rows.map((row) =>
      mapper(
        this.fields!,
        row.map((value, i) => {
          const field = this.fields![i]!.field;
          if (
            typeof value === "bigint" &&
            is(field, Column) &&
            (field.dataType === "number" || field.dataType === "date")
          )
            return safeNumber(value);
          return value;
        }),
        this.joinsNotNullableMap,
      ),
    );
  }
  run(values?: Record<string, unknown>): DrizzleRunResult {
    const bound = this.bound(values);
    return this.owner.atomic(() => {
      this.owner.client.run(this.query.sql, bound);
      const row = this.owner.client.values(
        "SELECT changes(),last_insert_rowid()",
      )[0]!;
      if (typeof row[0] !== "bigint" || typeof row[1] !== "bigint")
        throw Error("invalid SQLite mutation counters");
      return { changes: safeNumber(row[0]), lastInsertRowid: row[1] };
    });
  }
  all(values?: Record<string, unknown>): T["all"] {
    const bound = this.bound(values);
    return this.owner.atomic(() => {
      if (!this.fields && !this.customMapper)
        return this.owner.client.all(this.query.sql, bound) as T["all"];
      return this.mapped(
        this.owner.client.values(this.query.sql, bound),
      ) as T["all"];
    });
  }
  get(values?: Record<string, unknown>): T["get"] {
    const result = this.all(values) as unknown[];
    return result[0] as T["get"];
  }
  values(values?: Record<string, unknown>): T["values"] {
    const bound = this.bound(values);
    return this.owner.atomic(() =>
      this.owner.client.values(this.query.sql, bound),
    ) as T["values"];
  }
  isResponseInArrayMode() {
    return this.arrayMode;
  }
}
const sessions = new WeakMap<
  object,
  DrizzleSession<Record<string, unknown>, Schema>
>();
/** @internal Migration preflight must fail before scheduling async hashing. */
export function assertDrizzleMigrationIdle(db: object): void {
  const session = sessions.get(db);
  if (!session || session.active)
    throw Error("migration requires an idle Drizzle connection");
}
export function drizzle<
  T extends Record<string, unknown> = Record<string, never>,
>(client: DrizzleClient, config: Config<T> = {}): SqlikeDrizzleDatabase<T> {
  if (typeof client.values !== "function" || typeof mapper !== "function")
    throw Error(
      "Drizzle requires positional execution and compatible drizzle-orm 0.45.4",
    );
  const dialect = new SQLiteSyncDialect({ casing: config.casing });
  const tables = config.schema
    ? extractTablesRelationalConfig(config.schema, createTableRelationsHelpers)
    : undefined;
  const schema = tables
    ? {
        fullSchema: config.schema!,
        schema: tables.tables as ExtractTablesWithRelations<T>,
        tableNamesMap: tables.tableNamesMap,
      }
    : undefined;
  const logger =
    config.logger === true
      ? new DefaultLogger()
      : config.logger || new NoopLogger();
  const session = new DrizzleSession<T, ExtractTablesWithRelations<T>>(
    client,
    dialect,
    schema,
    logger,
  );
  const db = new SqlikeDrizzleDatabase<T>("sync", dialect, session, schema);
  Object.defineProperty(db, "$client", { value: client });
  sessions.set(
    db,
    session as unknown as DrizzleSession<Record<string, unknown>, Schema>,
  );
  return db;
}
