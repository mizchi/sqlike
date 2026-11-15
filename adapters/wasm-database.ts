import sqlite3InitModule, { type Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import type { Database as WasmDB } from "@sqlite.org/sqlite-wasm";
import type { Snapshot, Value } from "../src/contract.ts";
import type { BrowserDatabase } from "../src/backend-contract.ts";
import { SyncEngine, validateChanges } from "../src/engine.ts";
import { decodeChangeset, isInternalTable } from "../src/protocol.ts";

export class WasmDatabase implements BrowserDatabase {
  constructor(
    readonly sqlite: Sqlite3Static,
    readonly raw: WasmDB,
    private readOnly = false,
  ) {}
  static async open(name: string): Promise<WasmDatabase> {
    const sqlite = await sqlite3InitModule();
    const pool = await sqlite.installOpfsSAHPoolVfs({
      directory: `/browser-litestream-${name}`,
    });
    const raw = new pool.OpfsSAHPoolDb("/local.sqlite");
    raw.exec("PRAGMA foreign_keys=ON");
    return new WasmDatabase(sqlite, raw);
  }
  private execute(
    sql: string,
    params: Value[],
    readonly: boolean,
  ): { names: string[]; rows: Value[][] } {
    // Some PRAGMAs change settings during prepare itself. Reject them before
    // preparing a read-only query, rather than relying on stmt_readonly alone.
    if (readonly && !/^\s*(select|with)\b/i.test(sql))
      throw Error("unsupported read-only SQL: SELECT/WITH required");
    const statement = this.raw.prepare(sql),
      c = this.sqlite.capi;
    let savepoint = false;
    try {
      const writes = !c.sqlite3_stmt_readonly(statement.pointer!);
      if (readonly && writes)
        throw Error("query() accepts read-only statements");
      if (params.length) statement.bind(params);
      // OO1 guesses INTEGER for integral JS numbers. Our Value contract uses
      // bigint for INTEGER and number for REAL, matching Node and AOT.
      for (const [i, value] of params.entries())
        if (typeof value === "number")
          this.raw.checkRc(
            c.sqlite3_bind_double(statement.pointer!, i + 1, value),
          );
      if (writes && statement.columnCount) {
        this.raw.exec("SAVEPOINT _bls_result_read");
        savepoint = true;
      }
      const names = statement.columnCount ? statement.getColumnNames() : [];
      const rows: Value[][] = [];
      const decoder = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      });
      while (statement.step()) {
        const row: Value[] = [];
        for (const [i, name] of names.entries()) {
          let value: Value;
          switch (c.sqlite3_column_type(statement.pointer!, i)) {
            case c.SQLITE_INTEGER:
              value = c.sqlite3_column_int64(statement.pointer!, i);
              break;
            case c.SQLITE_FLOAT:
              value = statement.getFloat(i)!;
              break;
            case c.SQLITE_TEXT:
              // Force UTF-8 before reading its exact byte length; do not use a
              // NUL-terminated string or silently replace malformed sequences.
              c.sqlite3_column_text(statement.pointer!, i);
              try {
                value = decoder.decode(statement.getBlob(i)!);
              } catch {
                throw Error("unsupported SQL: non-UTF-8 TEXT result");
              }
              break;
            case c.SQLITE_BLOB:
              value = statement.getBlob(i)!;
              break;
            default:
              value = null;
          }
          row.push(value);
        }
        rows.push(row);
      }
      if (savepoint) {
        this.raw.exec("RELEASE _bls_result_read");
        savepoint = false;
      }
      return { names, rows };
    } catch (error) {
      // A RETURNING statement is still active when decoding a row fails.
      // Finalize it before rolling back and releasing its savepoint.
      if (statement.pointer) statement.finalize();
      if (savepoint) {
        this.raw.exec("ROLLBACK TO _bls_result_read");
        this.raw.exec("RELEASE _bls_result_read");
      }
      throw error;
    } finally {
      if (statement.pointer) statement.finalize();
    }
  }
  all(sql: string, params: Value[] = []): Record<string, Value>[] {
    const { names, rows } = this.execute(sql, params, false);
    return rows.map((row) =>
      Object.fromEntries(names.map((name, i) => [name, row[i]!])),
    );
  }
  values(sql: string, params: Value[] = []): Value[][] {
    return this.execute(sql, params, false).rows;
  }
  run(sql: string, params: Value[] = []): void {
    this.execute(sql, params, false);
  }
  query(sql: string, params: Value[] = []): Record<string, Value>[] {
    const { names, rows } = this.execute(sql, params, true);
    return rows.map((row) =>
      Object.fromEntries(names.map((name, i) => [name, row[i]!])),
    );
  }
  schemaVersion(): number {
    return Number(Object.values(this.all("PRAGMA schema_version")[0]!)[0]);
  }
  transaction<T>(body: () => T): T {
    this.raw.exec(this.readOnly ? "BEGIN" : "BEGIN IMMEDIATE");
    try {
      const result = body();
      this.raw.exec("COMMIT");
      return result;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    }
  }
  transactionWithoutForeignKeys<T>(body: () => T): T {
    if (!this.sqlite.capi.sqlite3_get_autocommit(this.raw.pointer!))
      throw Error("migration requires an idle SQLite connection");
    const enabled = this.values("PRAGMA foreign_keys")[0]![0];
    this.run("PRAGMA foreign_keys=OFF");
    if (this.values("PRAGMA foreign_keys")[0]![0] !== 0n)
      throw Error("cannot disable foreign keys for migration");
    try {
      return this.transaction(body);
    } finally {
      this.run(`PRAGMA foreign_keys=${enabled === 1n ? "ON" : "OFF"}`);
    }
  }
  snapshotOf(image: Uint8Array): Snapshot {
    // Preserve the replicated WAL-mode header in OPFS. Only the private SQLite
    // inspection copy is normalized, since it has no separate WAL/SHM files.
    const normalized = image.slice();
    normalized[18] = 1;
    normalized[19] = 1;
    const { capi: c, wasm: w } = this.sqlite;
    const ptr = w.allocFromTypedArray(normalized);
    const raw = new this.sqlite.oo1.DB(":memory:");
    try {
      raw.checkRc(
        c.sqlite3_deserialize(
          raw.pointer!,
          "main",
          ptr,
          normalized.length,
          normalized.length,
          c.SQLITE_DESERIALIZE_READONLY,
        ),
      );
      const db = new WasmDatabase(this.sqlite, raw, true);
      const check = db.all("PRAGMA quick_check");
      if (check.length !== 1 || Object.values(check[0]!)[0] !== "ok")
        throw new Error("restored LTX database failed SQLite quick_check");
      return new SyncEngine(db, false).snapshot();
    } finally {
      raw.close();
      w.dealloc(ptr);
    }
  }
  capture(body: () => void): Uint8Array {
    const tables = this.all(
      "SELECT name,sql FROM sqlite_schema WHERE type='table'",
    ).filter((r) => !isInternalTable(String(r.name)));
    for (const t of tables) {
      const keys = this.all(
        `PRAGMA table_info("${String(t.name).replaceAll('"', '""')}")`,
      ).filter((c) => Number(c.pk) > 0);
      if (
        !keys.length ||
        keys.some(
          (c) =>
            !Number(c.notnull) &&
            !(keys.length === 1 && String(c.type).toUpperCase() === "INTEGER"),
        )
      )
        throw new Error(
          "binary mode requires declared non-null primary keys on every table",
        );
    }
    const schemaSql = "SELECT name,type,sql FROM sqlite_schema ORDER BY rowid";
    const schema = JSON.stringify(this.all(schemaSql));
    const { capi: c, wasm: w } = this.sqlite;
    const stack = w.pstack.pointer;
    const pp = w.pstack.allocPtr();
    let session = 0;
    try {
      this.raw.checkRc(c.sqlite3session_create(this.raw.pointer!, "main", pp));
      session = w.peekPtr(pp);
      c.sqlite3session_table_filter(
        session,
        (_ctx, table) => (isInternalTable(table) ? 0 : 1),
        0,
      );
      this.raw.checkRc(c.sqlite3session_attach(session, 0));
      body();
      if (JSON.stringify(this.all(schemaSql)) !== schema)
        throw new Error("DDL must use SQL mode");
      const [pn, pdata] = w.pstack.allocPtr(2);
      this.raw.checkRc(c.sqlite3session_changeset(session, pn!, pdata!));
      const data = w.peekPtr(pdata!);
      const length = Number(w.peek(pn!, "i32"));
      try {
        const bytes = w.heap8u().slice(data, data + length);
        validateChanges(this, decodeChangeset(bytes), true);
        return bytes;
      } finally {
        c.sqlite3_free(data);
      }
    } finally {
      if (session) c.sqlite3session_delete(session);
      w.pstack.restore(stack);
    }
  }
  applyNativeChangeset(bytes: Uint8Array): void {
    if (!bytes.length) return;
    const { capi: c, wasm: w } = this.sqlite;
    const ptr = w.allocFromTypedArray(bytes);
    try {
      this.raw.checkRc(
        c.sqlite3changeset_apply(
          this.raw.pointer!,
          bytes.length,
          ptr,
          0,
          () => c.SQLITE_CHANGESET_ABORT,
          0,
        ),
      );
    } finally {
      w.dealloc(ptr);
    }
  }
}
