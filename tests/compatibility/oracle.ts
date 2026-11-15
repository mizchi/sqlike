import { NodeDatabase } from "../../adapters/node-database.ts";
import { APP_SCHEMA } from "../../src/engine.ts";
import { bootstrapSafety, observeSQL } from "../../src/safety.ts";
import { packResult, unpack, parseStatements } from "../../src/protocol.ts";
import {
  compatibilityError,
  type CompatibilityDriver,
  type CompatibilityResult,
} from "./contract.ts";

/** Independent native SQLite execution; no candidate parser/evaluator is reused. */
export function sqliteOracle(): CompatibilityDriver & { close(): void } {
  const db = new NodeDatabase(":memory:");
  db.run(APP_SCHEMA);
  bootstrapSafety(db, true);
  return {
    async execute(statements): Promise<CompatibilityResult> {
      try {
        return {
          ok: true,
          effects: db.transaction(() => observeSQL(db, statements)).effects,
        };
      } catch (error) {
        return { ok: false, error: compatibilityError(error) };
      }
    },
    async query(statement): Promise<CompatibilityResult> {
      try {
        parseStatements(new TextEncoder().encode(JSON.stringify([statement])));
        return {
          ok: true,
          rows: db
            .all(statement.sql, statement.params.map(unpack))
            .map((row) =>
              Object.fromEntries(
                Object.entries(row).map(([name, value]) => [
                  name,
                  packResult(value),
                ]),
              ),
            ),
        };
      } catch (error) {
        return { ok: false, error: compatibilityError(error) };
      }
    },
    close() {
      db.close();
    },
  };
}
