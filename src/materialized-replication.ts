import type { Database } from "./contract.ts";
import { isInternalTable, quote } from "./protocol.ts";
import { failure } from "./errors.ts";
import { readSchemaEntries } from "./schema-entries.ts";

export interface MaterializedDatabase extends Database {
  replicaTransaction<T>(body: () => T): T;
  applyMaterialized(body: () => void): void;
}

/** Opt-in adapter for synchronous SQL drivers which can disable FK enforcement
 * outside a transaction and transactionally drop/recreate ordinary triggers.
 * The PRAGMA is checked before any write: drivers which ignore it fail closed.
 * Keep this entry separate from the ordinary SQL/binary runtime bundle. */
export function withMaterializedReplication<T extends Database>(
  db: T,
): T & MaterializedDatabase {
  let active = false;
  let applying = false;
  let failed = false;
  const replicaTransaction = <R>(body: () => R): R => {
    if (active) throw Error("nested materialized replication transaction");
    const scope = (): R => {
      active = true;
      failed = false;
      try {
        const result = body();
        if (result && typeof (result as { then?: unknown }).then === "function")
          throw Error("replica transaction must be synchronous");
        if (failed)
          throw Error("failed materialized apply cannot be committed");
        return result;
      } finally {
        active = false;
      }
    };
    if (db.transactionWithoutForeignKeys)
      return db.transactionWithoutForeignKeys(scope);
    const enabled = Number(db.all("PRAGMA foreign_keys")[0]?.foreign_keys);
    if (enabled !== 0 && enabled !== 1)
      throw failure(
        "materialized-backend",
        "materialized replication requires readable foreign_keys mode",
        "application",
        "reject",
      );
    try {
      db.run("PRAGMA foreign_keys=OFF");
    } catch {
      throw failure(
        "materialized-backend",
        "materialized replication cannot disable foreign keys on this backend",
        "application",
        "reject",
      );
    }
    try {
      if (Number(db.all("PRAGMA foreign_keys")[0]?.foreign_keys) !== 0) {
        throw failure(
          "materialized-backend",
          "materialized replication cannot disable foreign keys on this backend or inside an existing transaction",
          "application",
          "reject",
        );
      }
      return db.transaction(scope);
    } finally {
      active = false;
      db.run(`PRAGMA foreign_keys=${enabled ? "ON" : "OFF"}`);
      if (Number(db.all("PRAGMA foreign_keys")[0]?.foreign_keys) !== enabled)
        throw Error("failed to restore foreign key enforcement");
    }
  };
  const applyMaterialized = (body: () => void): void => {
    if (!active || applying)
      throw Error("materialized apply requires its replica transaction");
    applying = true;
    try {
      const triggers = readSchemaEntries(db).filter(entry => entry.type === "trigger");
      if (
        triggers.some(
          (t) =>
            isInternalTable(String(t.tbl_name)) || typeof t.sql !== "string",
        )
      )
        throw Error("unsupported internal trigger during materialized apply");
      for (const t of triggers) db.run(`DROP TRIGGER ${quote(String(t.name))}`);
      const result: unknown = body();
      if (result && typeof (result as { then?: unknown }).then === "function")
        throw Error("materialized apply must be synchronous");
      for (const t of triggers) db.run(String(t.sql));
      if (db.all("PRAGMA foreign_key_check").length)
        throw Error("FOREIGN KEY constraint failed: materialized changeset");
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      applying = false;
    }
    // On failure the enclosing replica transaction rolls back DDL and data.
  };
  return new Proxy(db, {
    get(target, key) {
      if (key === "replicaTransaction") return replicaTransaction;
      if (key === "applyMaterialized") return applyMaterialized;
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as T & MaterializedDatabase;
}
