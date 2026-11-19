import type { Database, SchemaEntry, Value } from "./contract.ts";

export function decodeSchemaEntries(
  rows: Record<string, Value>[],
): SchemaEntry[] {
  return rows.map((row) => {
    if (
      typeof row.name !== "string" ||
      typeof row.tbl_name !== "string" ||
      typeof row.sql !== "string" ||
      !["table", "index", "view", "trigger"].includes(String(row.type))
    )
      throw Error("invalid schema entry");
    return {
      name: row.name,
      tbl_name: row.tbl_name,
      sql: row.sql,
      type: row.type as SchemaEntry["type"],
    };
  });
}

/** Ordinary SQLite drivers use persisted schema order. Logical backends supply
 * their own dependency-safe order, including the relative order of triggers. */
export function readSchemaEntries(db: Database): SchemaEntry[] {
  return (
    db.schemaEntries?.() ??
    decodeSchemaEntries(
      db.all(
        "SELECT name,type,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY rowid",
      ),
    )
  );
}
