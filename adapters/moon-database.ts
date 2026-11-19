import { aotBindings } from "../src/aot-values.ts";
import type { BrowserDatabase } from "../src/backend-contract.ts";
import type { SyncPersistenceFactory } from "../src/persistence-contract.ts";
import * as jsRuntime from "../_build/js/release/build/mizchi/sqlike/full/full.js";
export type MoonSqlRuntime = typeof jsRuntime;
import { SyncEngine, validateChanges } from "../src/engine.ts";
import type { ResultCell, Database, Snapshot, Value } from "../src/contract.ts";
import { unpack, decodeChangeset } from "../src/protocol.ts";
import { decodeSchemaEntries } from "../src/schema-entries.ts";

/** SQL parsing, storage classes, execution and constraints are all implemented in
 * MoonBit. This boundary only marshals values and owns transaction publication. */
export class MoonDatabase implements BrowserDatabase {
  private connection: ReturnType<MoonSqlRuntime["database_open"]>;
  private inTransaction = false;
  private poisoned = false;
  private closed = false;
  private release?: () => void;
  constructor(
    image?: string,
    private persist?: (image: string, delta?: boolean) => void,
    private runtime: MoonSqlRuntime = jsRuntime,
    private checkpointNeeded?: () => boolean,
  ) {
    this.connection = runtime.database_open();
    if (image !== undefined) this.restore(image);
  }
  static async open(
    name: string,
    provider?: SyncPersistenceFactory,
  ): Promise<MoonDatabase> {
    const persistence = await (
      provider ?? (await import("./moon-persistence.ts")).MoonPersistence.open
    )(name);
    try {
      if (persistence.initial.snapshot)
        throw Error("unsupported SQL host chunk snapshot");
      const db = new MoonDatabase(
        persistence.initial.image,
        (image, delta) => persistence.commit(image, delta),
        jsRuntime,
        () => persistence.checkpointNeeded(),
      );
      for (const delta of persistence.initial.deltas ?? []) {
        const response = JSON.parse(
          db.runtime.database_apply_delta(db.connection, delta.text),
        ) as { error?: string };
        if (response.error) throw Error(response.error);
      }
      const ack = JSON.parse(
        db.runtime.database_ack_delta(
          db.connection,
          db.runtime.database_serial(db.connection),
        ),
      ) as { error?: string };
      if (ack.error) throw Error(ack.error);
      persistence.releaseInitial?.();
      db.release = () => persistence.close();
      return db;
    } catch (error) {
      persistence.close();
      throw error;
    }
  }
  static fromSQLite(
    image: Uint8Array,
    runtime: MoonSqlRuntime = jsRuntime,
  ): MoonDatabase {
    const db = new MoonDatabase(undefined, undefined, runtime);
    const response = JSON.parse(
      runtime.database_import_sqlite(db.connection, image),
    ) as { error?: string };
    if (response.error) throw new Error(`SQLite image: ${response.error}`);
    return db;
  }
  snapshotOf(image: Uint8Array): Snapshot {
    return new SyncEngine(
      MoonDatabase.fromSQLite(image, this.runtime),
      false,
    ).snapshot();
  }
  private healthy(): void {
    if (this.closed) throw Error("Moon database connection is closed");
    if (this.poisoned)
      throw new Error(
        "Moon database connection requires reload after an uncertain commit",
      );
  }
  close(): void {
    if (this.inTransaction) throw Error("cannot close an active transaction");
    if (!this.closed) {
      this.closed = true;
      this.release?.();
    }
  }
  private restore(image: string): void {
    const format = (JSON.parse(image) as { format?: string }).format;
    const response = JSON.parse(
      format === "sqlike-flush@1"
        ? this.runtime.database_apply_delta(this.connection, image)
        : this.runtime.database_restore(this.connection, image),
    ) as { error?: string };
    if (response.error) throw new Error(response.error);
  }
  dump(): string {
    this.healthy();
    return this.runtime.database_dump(this.connection);
  }
  schemaEntries() {
    return decodeSchemaEntries(
      this.all(
        "SELECT name,type,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL",
      ),
    );
  }
  schemaVersion(): number {
    this.healthy();
    return this.runtime.database_version(this.connection);
  }
  private execute(
    sql: string,
    params: Value[],
    readOnly: boolean,
  ): Record<string, Value>[] {
    this.healthy();
    this.runtime.database_set_clock(this.connection, String(Date.now()));
    const result = JSON.parse(
      this.runtime.database_exec(
        this.connection,
        sql,
        aotBindings(params),
        readOnly,
      ),
    ) as { error?: string; code?: string; rows: Record<string, ResultCell>[] };
    if (result.error)
      throw Object.assign(new Error(result.error), { code: result.code });
    return result.rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key, unpack(value)]),
      ),
    );
  }
  all(sql: string, params: Value[] = []): Record<string, Value>[] {
    if (
      this.inTransaction ||
      !this.persist ||
      this.runtime.database_is_readonly(sql)
    )
      return this.execute(sql, params, false);
    return this.transaction(() => this.execute(sql, params, false));
  }
  query(sql: string, params: Value[] = []): Record<string, Value>[] {
    return this.execute(sql, params, true);
  }
  queryValues(sql: string, params: Value[] = []): Value[][] {
    this.healthy();
    this.runtime.database_set_clock(this.connection, String(Date.now()));
    const result = JSON.parse(
      this.runtime.database_query_values(
        this.connection,
        sql,
        aotBindings(params),
      ),
    ) as { error?: string; rows: ResultCell[][] };
    if (result.error) throw new Error(result.error);
    return result.rows.map((row) => row.map(unpack));
  }
  values(sql: string, params: Value[] = []): Value[][] {
    const execute = () => {
      this.healthy();
      this.runtime.database_set_clock(this.connection, String(Date.now()));
      const result = JSON.parse(
        this.runtime.database_exec_values(
          this.connection,
          sql,
          aotBindings(params),
        ),
      ) as { error?: string; code?: string; rows: ResultCell[][] };
      if (result.error)
        throw Object.assign(Error(result.error), { code: result.code });
      return result.rows.map((row) => row.map(unpack));
    };
    if (
      this.inTransaction ||
      !this.persist ||
      this.runtime.database_is_readonly(sql)
    )
      return execute();
    return this.transaction(execute);
  }
  run(sql: string, params: Value[] = []): void {
    this.all(sql, params);
  }
  transaction<T>(body: () => T): T {
    this.healthy();
    if (this.inTransaction)
      throw new Error("nested transactions are not supported");
    const previous = this.runtime.database_clone(this.connection);
    const serial = this.runtime.database_serial(this.connection);
    this.inTransaction = true;
    let publishing = false;
    try {
      const result = body();
      if (result && typeof (result as { then?: unknown }).then === "function")
        throw new Error("database transaction body must be synchronous");
      if (!this.runtime.database_autocommit(this.connection)) return result;
      // Deferred foreign keys must hold before the complete image is published.
      if (
        this.execute("PRAGMA foreign_keys", [], true)[0]?.foreign_keys === 1n &&
        this.execute("PRAGMA foreign_key_check", [], true).length
      )
        throw new Error("FOREIGN KEY constraint failed");
      if (
        this.execute("PRAGMA defer_foreign_keys", [], true)[0]
          ?.defer_foreign_keys === 1n
      )
        this.execute("PRAGMA defer_foreign_keys=OFF", [], false);
      if (
        this.runtime.database_serial(this.connection) !== serial &&
        this.persist
      ) {
        publishing = true;
        if (this.checkpointNeeded) {
          const flush = this.runtime.database_delta(
            this.connection,
            this.checkpointNeeded(),
          );
          const decoded = JSON.parse(flush) as {
            error?: string;
            full: boolean;
            serial: number;
          };
          if (decoded.error) throw Error(decoded.error);
          this.persist(flush, !decoded.full);
          const ack = JSON.parse(
            this.runtime.database_ack_delta(this.connection, decoded.serial),
          ) as { error?: string };
          if (ack.error) throw Error(ack.error);
        } else this.persist(this.dump());
      }
      return result;
    } catch (error) {
      // A persistence error may mean the write committed but its ACK was lost.
      // Preserve that uncertainty and require reopen; never authorize a rewrite.
      this.runtime.database_copy_connection_state(previous, this.connection);
      this.connection = previous;
      if (publishing) this.poisoned = true;
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }
  transactionWithoutForeignKeys<T>(body: () => T): T {
    return this.transaction(() => {
      const enabled = this.query("PRAGMA foreign_keys")[0]!.foreign_keys;
      this.run("PRAGMA foreign_keys=OFF");
      try {
        return body();
      } finally {
        this.run(`PRAGMA foreign_keys=${enabled === 1n ? "ON" : "OFF"}`);
      }
    });
  }
  capture(body: () => void): Uint8Array {
    const capture = () => {
      const previous = this.runtime.database_clone(this.connection);
      try {
        // Validate the schema even if the body produces no net changes.
        const schema = JSON.parse(
          this.runtime.database_changeset(this.connection, previous),
        ) as { error?: string };
        if (schema.error) throw new Error(schema.error);
        body();
        const result = JSON.parse(
          this.runtime.database_changeset(this.connection, previous),
        ) as { error?: string; data: number[] };
        if (result.error) throw new Error(result.error);
        const bytes = Uint8Array.from(result.data);
        validateChanges(this, decodeChangeset(bytes), true);
        return bytes;
      } catch (error) {
        this.runtime.database_copy_connection_state(previous, this.connection);
        this.connection = previous;
        throw error;
      }
    };
    return this.inTransaction ? capture() : this.transaction(capture);
  }
}
