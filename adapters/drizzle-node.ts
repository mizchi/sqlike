import { readMigrationFiles, type MigrationConfig } from "drizzle-orm/migrator";
import { migrate as apply } from "./drizzle-migrator.ts";
import type { SqlikeDrizzleDatabase } from "./drizzle.ts";
/** Node-only file reader. Browser/Worker entry points never import node:fs. */
export function migrate<T extends Record<string, unknown>>(
  db: SqlikeDrizzleDatabase<T>,
  config: MigrationConfig,
) {
  return apply(db, readMigrationFiles(config), config);
}
