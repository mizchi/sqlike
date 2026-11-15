/** Build-time feature tokens. Importing this module loads no database runtime. */
export type SqlikeFeatureName =
  | "rightFullJoin"
  | "strictTables"
  | "primaryKeyIndex"
  | "triggers"
  | "foreignKeys"
  | "sqlJson"
  | "dateTime"
  | "windowFunctions"
  | "binarySync"
  | "sqlitePages"
  | "ltx";
export interface SqlikeFeature {
  readonly name: SqlikeFeatureName;
}
const feature = (name: SqlikeFeatureName): SqlikeFeature =>
  Object.freeze({ name });
export const rightFullJoin = feature("rightFullJoin");
export const strictTables = feature("strictTables");
export const primaryKeyIndex = feature("primaryKeyIndex");
export const triggers = feature("triggers");
export const foreignKeys = feature("foreignKeys");
export const sqlJson = feature("sqlJson");
export const dateTime = feature("dateTime");
export const windowFunctions = feature("windowFunctions");
export const binarySync = feature("binarySync");
export const sqlitePages = feature("sqlitePages");
export const ltx = feature("ltx");
export const allSqlikeFeatures: readonly SqlikeFeature[] = Object.freeze([
  rightFullJoin,
  strictTables,
  primaryKeyIndex,
  triggers,
  foreignKeys,
  sqlJson,
  dateTime,
  windowFunctions,
  binarySync,
  sqlitePages,
  ltx,
]);
export interface SqlikeProfile {
  readonly mode: "aot" | "sql" | "defined";
  readonly features: readonly SqlikeFeatureName[];
}
export function defineSqlike({
  mode = "aot",
  features = [],
}: {
  mode?: "aot" | "sql" | "defined";
  features?: readonly SqlikeFeature[];
} = {}): SqlikeProfile {
  if (mode !== "sql" && mode !== "aot" && mode !== "defined")
    throw Error("invalid Sqlike runtime mode");
  const names = [...new Set(features.map((f) => f.name))].sort();
  if (names.some((n) => !allSqlikeFeatures.some((f) => f.name === n)))
    throw Error("unknown Sqlike feature");
  if (names.includes("ltx") && !names.includes("sqlitePages"))
    throw Error("ltx requires sqlitePages");
  if (mode === "sql" && names.includes("ltx"))
    throw Error("ltx requires the aot runtime");
  if (mode !== "sql" && names.includes("binarySync"))
    throw Error(
      "binarySync requires the sql runtime; AOT uses SQLite pages/LTX",
    );
  if (
    mode === "defined" &&
    names.some((n) => n === "sqlitePages" || n === "ltx")
  )
    throw Error("defined runtime uses the separate SQLite exporter");
  return Object.freeze({ mode, features: Object.freeze(names) });
}
