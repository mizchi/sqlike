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
  | "schemaMetadata"
  | "aggregateFilter"
  | "aggregateOrderBy"
  | "rowValues"
  | "updateFrom"
  | "generatedColumns"
  | "jsonTableFunctions"
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
export const schemaMetadata = feature("schemaMetadata");
export const aggregateFilter = feature("aggregateFilter");
export const aggregateOrderBy = feature("aggregateOrderBy");
export const rowValues = feature("rowValues");
export const updateFrom = feature("updateFrom");
export const generatedColumns = feature("generatedColumns");
export const jsonTableFunctions = feature("jsonTableFunctions");
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
  schemaMetadata,
  aggregateFilter,
  aggregateOrderBy,
  rowValues,
  updateFrom,
  generatedColumns,
  jsonTableFunctions,
  binarySync,
  sqlitePages,
  ltx,
]);
export interface SqlikeProfile {
  readonly mode: "aot" | "sql" | "defined";
  readonly features: readonly SqlikeFeatureName[];
  readonly preset?: "baseline" | "full";
}
export function baselineSqlike(): SqlikeProfile {
  return Object.freeze({
    ...defineSqlike({
      mode: "sql",
      features: [primaryKeyIndex, foreignKeys, strictTables],
    }),
    preset: "baseline",
  });
}
export function fullSqlike(
  mode: "sql" | "aot" | "defined" = "sql",
): SqlikeProfile {
  return Object.freeze({
    ...defineSqlike({
      mode,
      features: allSqlikeFeatures.filter(
        (f) =>
          f.name !== "ltx" &&
          (mode === "sql" || f.name !== "binarySync") &&
          (mode !== "defined" || f.name !== "sqlitePages"),
      ),
    }),
    preset: "full",
  });
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
  if (mode === "defined" && names.includes("ltx"))
    throw Error("defined runtime uses the separate LTX codec");
  return Object.freeze({ mode, features: Object.freeze(names) });
}
