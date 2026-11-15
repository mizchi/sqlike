import type { MigrationMeta } from "drizzle-orm/migrator";
import {
  assertDrizzleMigrationIdle,
  type SqlikeDrizzleDatabase,
} from "./drizzle.ts";
import { sha256 } from "../src/aot-values.ts";
import type { DrizzleClient } from "../src/drizzle-contract.ts";
import { migrationStatements } from "../src/migration-statements.ts";

export type DrizzleMigration = Omit<Readonly<MigrationMeta>, "sql"> & {
  readonly sql: readonly string[];
};
export interface DrizzleMigrationOptions {
  migrationsTable?: string;
}
interface Entry {
  hash: string;
  timestamp: number;
}
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
function foreignKeyDirective(sql: string): boolean | undefined {
  const text = sql.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, "");
  const match = /^pragma\s+foreign_keys\s*=\s*(on|off|0|1)\s*;?\s*$/i.exec(
    text,
  );
  if (
    !match &&
    /^pragma\s+(?:(?:main|temp)\s*\.\s*)?["`\[]?foreign_keys\b/i.test(text)
  )
    throw Error(
      "unsupported migration foreign_keys directive; use PRAGMA foreign_keys=OFF/ON",
    );
  return match ? ["off", "0"].includes(match[1]!.toLowerCase()) : undefined;
}
function history(client: DrizzleClient, table: string): Entry[] {
  if (
    !client.values(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name=?",
      [table],
    ).length
  )
    return [];
  return client
    .values(`SELECT hash,created_at FROM ${quote(table)} ORDER BY created_at`)
    .map((row) => {
      const timestamp = Number(row[1]);
      if (
        typeof row[0] !== "string" ||
        !/^[0-9a-f]{64}$/.test(row[0]) ||
        !Number.isSafeInteger(timestamp)
      )
        throw Error("invalid Drizzle migration history");
      return { hash: row[0], timestamp };
    });
}
function checkHistory(
  entries: Entry[],
  migrations: readonly DrizzleMigration[],
) {
  if (
    entries.length > migrations.length ||
    entries.some(
      (entry, i) =>
        entry.hash !== migrations[i]!.hash ||
        entry.timestamp !== migrations[i]!.folderMillis,
    )
  )
    throw Error("Drizzle migration history hash drift or missing migration");
}
/** Verifies actual Kit file bytes, then applies pending schema/data/log changes
 * in one storage transaction. No Node APIs; generated arrays work in browsers. */
export function migrate<T extends Record<string, unknown>>(
  db: SqlikeDrizzleDatabase<T>,
  input: readonly DrizzleMigration[],
  options: DrizzleMigrationOptions = {},
): Promise<{ applied: number }> {
  assertDrizzleMigrationIdle(db);
  const migrations = input.map((m) => ({ ...m, sql: [...m.sql] }));
  const table = options.migrationsTable ?? "__drizzle_migrations";
  if (!table || table.includes("\0"))
    throw Error("invalid migration table name");
  return verifyAndApply(db.$client, migrations, table);
}
async function verifyAndApply(
  client: DrizzleClient,
  migrations: DrizzleMigration[],
  table: string,
) {
  const executable = new Map<DrizzleMigration, string[]>();
  let previous = -1;
  for (const m of migrations) {
    if (
      !Number.isSafeInteger(m.folderMillis) ||
      m.folderMillis <= previous ||
      !m.sql.every((s) => typeof s === "string") ||
      (await sha256(m.sql.join("--> statement-breakpoint"))) !== m.hash
    )
      throw Error("invalid Drizzle migration order or file hash");
    previous = m.folderMillis;
    const statements = m.sql.flatMap(migrationStatements);
    executable.set(m, statements);
    for (const statement of statements) {
      const head = statement.replace(
        /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/,
        "",
      );
      if (/^(begin|commit|end|rollback|savepoint|release)\b/i.test(head))
        throw Error("migration must not control its outer transaction");
      foreignKeyDirective(statement);
    }
  }
  const before = history(client, table);
  checkHistory(before, migrations);
  if (before.length === migrations.length) return { applied: 0 };
  const pending = migrations.slice(before.length);
  const foreignKeysOff = pending.some((m) =>
    executable.get(m)!.some((s) => foreignKeyDirective(s) === true),
  );
  const body = () => {
    if (JSON.stringify(history(client, table)) !== JSON.stringify(before))
      throw Error("Drizzle migration history changed; reopen and retry");
    client.run(
      `CREATE TABLE IF NOT EXISTS ${quote(table)}(id INTEGER PRIMARY KEY AUTOINCREMENT,hash TEXT NOT NULL,created_at NUMERIC)`,
    );
    for (const migration of pending) {
      for (const statement of executable.get(migration)!) {
        if (!statement.trim() || foreignKeyDirective(statement) !== undefined)
          continue;
        try {
          if (client.runMigration) client.runMigration(statement);
          else client.run(statement);
        } catch (cause) {
          throw Object.assign(
            Error(
              `Drizzle migration ${migration.folderMillis}: ${(cause as Error).message}`,
              { cause },
            ),
            { statement },
          );
        }
      }
      client.run(`INSERT INTO ${quote(table)}(hash,created_at) VALUES(?,?)`, [
        migration.hash,
        BigInt(migration.folderMillis),
      ]);
    }
    if (client.values("PRAGMA foreign_key_check").length)
      throw Error("FOREIGN KEY constraint failed after Drizzle migration");
    const after = history(client, table);
    checkHistory(after, migrations);
    if (after.length !== migrations.length)
      throw Error("Drizzle migration history was modified by a migration");
    return { applied: pending.length };
  };
  if (client.migrationScope) return client.migrationScope(body, foreignKeysOff);
  if (foreignKeysOff) {
    if (!client.transactionWithoutForeignKeys)
      throw Error(
        "backend cannot safely disable foreign keys for table rebuild migration",
      );
    return client.transactionWithoutForeignKeys(body);
  }
  return client.transaction(body);
}
