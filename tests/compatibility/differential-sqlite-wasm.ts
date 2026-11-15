import type { Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { datum, value, sqlError } from "./differential-core.ts";
import type { DifferentialDriver, SqlDatum } from "./differential-contract.ts";
/** Read storage classes through C API. getString() uses C-string semantics;
 * TEXT containing NUL is read as bytes so the oracle retains its full value. */
export function sqliteWasmOracle(sqlite: Sqlite3Static): DifferentialDriver {
  const db = new sqlite.oo1.DB(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  return {
    close: () => db.close(),
    execute(op) {
      let stmt: ReturnType<typeof db.prepare> | undefined;
      try {
        stmt = db.prepare(op.sql);
        if (op.params?.length) stmt.bind(op.params.map(value));
        for (const [i, p] of (op.params ?? []).entries())
          if (p.type === "real")
            db.checkRc(
              sqlite.capi.sqlite3_bind_double(
                stmt.pointer!,
                i + 1,
                Number(p.value),
              ),
            );
        const rows: SqlDatum[][] = [];
        const columns = stmt.columnCount ? stmt.getColumnNames() : [];
        while (stmt.step()) {
          const row: SqlDatum[] = [];
          for (let i = 0; i < stmt.columnCount; i++)
            switch (sqlite.capi.sqlite3_column_type(stmt.pointer!, i)) {
              case sqlite.capi.SQLITE_INTEGER:
                row.push({
                  type: "integer",
                  value: String(
                    sqlite.capi.sqlite3_column_int64(stmt.pointer!, i),
                  ),
                });
                break;
              case sqlite.capi.SQLITE_FLOAT:
                row.push(datum(stmt.getFloat(i)!));
                break;
              case sqlite.capi.SQLITE_TEXT:
                row.push({
                  type: "text",
                  value: new TextDecoder().decode(stmt.getBlob(i)!),
                });
                break;
              case sqlite.capi.SQLITE_BLOB:
                row.push({ type: "blob", value: Array.from(stmt.getBlob(i)!) });
                break;
              default:
                row.push({ type: "null" });
            }
          rows.push(row);
        }
        return { kind: "rows", rows, columns };
      } catch (e) {
        return sqlError(e);
      } finally {
        stmt?.finalize();
      }
    },
  };
}
