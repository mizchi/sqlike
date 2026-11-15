import { DatabaseSync, constants } from "node:sqlite";
import type { Database, Value } from "../src/contract.ts";

export class NodeDatabase implements Database {
  readonly raw: DatabaseSync;
  applyNativeChangeset?: (bytes: Uint8Array) => void;
  constructor(
    path: string,
    native = true,
    private readOnly = false,
  ) {
    this.raw = new DatabaseSync(path, { readOnly });
    this.raw.exec(
      readOnly
        ? "PRAGMA query_only=ON"
        : "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON",
    );
    if (native)
      this.applyNativeChangeset = (bytes) => {
        if (
          !this.raw.applyChangeset(bytes, {
            onConflict: () => constants.SQLITE_CHANGESET_ABORT,
          })
        )
          throw new Error("changeset conflict");
      };
  }
  all(sql: string, params: Value[] = []): Record<string, Value>[] {
    const stmt = this.raw.prepare(sql);
    stmt.setReadBigInts(true);
    return stmt.all(...params) as Record<string, Value>[];
  }
  values(sql: string, params: Value[] = []): Value[][] {
    const stmt = this.raw.prepare(sql);
    stmt.setReadBigInts(true);
    stmt.setReturnArrays(true);
    return stmt.all(...params) as unknown as Value[][];
  }
  run(sql: string, params: Value[] = []): void {
    this.all(sql, params);
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
  close(): void {
    this.raw.close();
  }
  transactionWithoutForeignKeys<T>(body: () => T): T {
    if (this.raw.isTransaction)
      throw Error(
        "cannot disable foreign keys inside an active SQLite transaction",
      );
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
}
