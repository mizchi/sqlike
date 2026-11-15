import type { Mode } from "./contract.ts";
import { failure } from "./errors.ts";
export const browserEngines = ["sqlite", "turso", "sqlike"] as const;
export type BrowserEngine = (typeof browserEngines)[number];
export const defaultBrowserEngine: BrowserEngine = "sqlite";
export interface BackendCapabilities {
  readonly sql: true;
  readonly changesetCapture: boolean;
  readonly sqliteImageRead: boolean;
}
export const browserCapabilities: Readonly<
  Record<BrowserEngine, BackendCapabilities>
> = Object.freeze({
  sqlite: Object.freeze({
    sql: true,
    changesetCapture: true,
    sqliteImageRead: true,
  }),
  sqlike: Object.freeze({
    sql: true,
    changesetCapture: true,
    sqliteImageRead: true,
  }),
  turso: Object.freeze({
    sql: true,
    changesetCapture: false,
    sqliteImageRead: false,
  }),
});
export function parseBrowserEngine(value: unknown): BrowserEngine {
  if (value === "moonbit") return "sqlike"; // Preserve existing URLs and storage names.
  if (
    typeof value !== "string" ||
    !browserEngines.some((engine) => engine === value)
  )
    throw Error(`unsupported browser database engine: ${String(value)}`);
  return value as BrowserEngine;
}
export function defaultSyncMode(engine: BrowserEngine): Mode {
  return browserCapabilities[engine].changesetCapture ? "changeset" : "sql";
}
export function requireCapability(
  engine: BrowserEngine,
  capability: keyof BackendCapabilities,
): void {
  if (!browserCapabilities[engine][capability])
    throw failure(
      "unsupported",
      `${engine}: ${capability === "changesetCapture" ? "SQLite Session capture" : "SQLite image / direct LTX inspection"} is not available; use SQL mode or a logical snapshot backend`,
      "resource",
      "reject",
    );
}
