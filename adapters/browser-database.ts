import type { BrowserDatabase } from "../src/backend-contract.ts";
import {
  browserCapabilities,
  type BrowserEngine,
} from "../src/browser-engine.ts";
export async function openBrowserDatabase(
  engine: BrowserEngine,
  name: string,
): Promise<BrowserDatabase> {
  let db: BrowserDatabase;
  switch (engine) {
    case "sqlite":
      db = await (await import("./wasm-database.ts")).WasmDatabase.open(name);
      break;
    case "sqlike":
      db = await (await import("./moon-database.ts")).MoonDatabase.open(name);
      break;
    case "turso":
      db = await (await import("./turso-database.ts")).TursoDatabase.open(name);
      break;
    default: {
      const unsupported: never = engine;
      throw Error(`unsupported engine: ${unsupported}`);
    }
  }
  const expected = browserCapabilities[engine];
  if (
    (typeof db.capture === "function") !== expected.changesetCapture ||
    (typeof db.snapshotOf === "function") !== expected.sqliteImageRead
  )
    throw Error(
      `${engine}: backend capability declaration does not match its adapter`,
    );
  return db;
}
