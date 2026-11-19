import { readMigrationFiles, type MigrationConfig } from "drizzle-orm/migrator";
import { migrate as apply } from "./drizzle-migrator.ts";
import type { SqlikeDrizzleDatabase } from "./drizzle.ts";
/** Read migration files from disk and apply them to the database.
 * Browser/Worker entry points do not import this Node-only module. */
export function migrate<T extends Record<string, unknown>>(
  db: SqlikeDrizzleDatabase<T>,
  config: MigrationConfig,
) {
  return apply(db, readMigrationFiles(config), config);
}
