import type { SqlikeProfile } from "./sqlike-features.ts";
import type { CatalogRequirements } from "./catalog-requirements-contract.ts";
import {
  catalogFunctionConstants,
  catalogExpressionConstants,
  catalogStatementConstants,
  catalogQueryConstants,
} from "./catalog-capabilities.ts";
import {
  buildGraph,
  dependencyClosure,
  constantsForSelection,
  type SqlikeOptimizer,
  type AotApiCapability,
  aotApiCapabilities,
} from "./sqlike-build-graph.ts";
interface SchemaHint {
  objects: { kind: string }[];
  tables: {
    without_rowid: boolean;
    columns: { declared: string; primary: number; primary_desc?: boolean }[];
    unique_keys: number[][];
  }[];
}
/** Read compiled schema IR, never SQL text. Rowid aliases need no secondary planner. */
export function catalogHasSecondaryIndexes(schema: SchemaHint) {
  return (
    schema.objects.some((o) => o.kind === "index") ||
    schema.tables.some((t) =>
      t.unique_keys.some(
        (key) =>
          !(
            key.length === 1 &&
            !t.without_rowid &&
            t.columns.filter((c) => c.primary > 0).length === 1 &&
            t.columns[key[0]!]!.declared === "INTEGER" &&
            t.columns[key[0]!]!.primary === 1 &&
            !t.columns[key[0]!]!.primary_desc
          ),
      ),
    )
  );
}
export function createBuildPlan(
  profile: SqlikeProfile,
  {
    requirements,
    hasSecondaryIndexes = true,
    optimizers,
    emitter = "flat-single-link",
    apiCapabilities,
    apiBackend = "portable",
  }: {
    requirements?: CatalogRequirements;
    hasSecondaryIndexes?: boolean;
    optimizers?: readonly SqlikeOptimizer[];
    emitter?: "flat-single-link" | "moonbit-source";
    apiCapabilities?: readonly AotApiCapability[];
    apiBackend?: "portable" | "native";
  } = {},
) {
  if (apiBackend !== "portable" && apiBackend !== "native")
    throw Error("unknown AOT API backend");
  if (apiBackend === "native" && profile.mode !== "aot")
    throw Error("native API backend requires AOT mode");
  if (apiCapabilities !== undefined && profile.mode !== "aot")
    throw Error("API capabilities require portable AOT mode");
  if (
    apiCapabilities !== undefined &&
    (!Array.isArray(apiCapabilities) ||
      apiCapabilities.some((n) => !aotApiCapabilities.includes(n)))
  )
    throw Error("unknown AOT API capability");
  if (apiBackend === "native" && apiCapabilities !== undefined)
    throw Error("API capability selection requires portable AOT");
  const groups: readonly string[] =
    profile.preset === "baseline"
      ? buildGraph.baseline.functions
      : (requirements?.functionGroups ??
        Object.keys(catalogFunctionConstants).filter(
          (n) => !n.startsWith("json") || profile.features.includes("sqlJson"),
        ));
  const statements: readonly string[] =
    profile.preset === "baseline"
      ? buildGraph.baseline.statements
      : (requirements?.statements ?? Object.keys(catalogStatementConstants));
  const expressionGroups: readonly string[] =
    profile.preset === "baseline"
      ? buildGraph.baseline.expressionGroups
      : (requirements?.expressionGroups ?? Object.keys(catalogExpressionConstants));
  const parts: readonly string[] =
    profile.preset === "baseline"
      ? buildGraph.baseline.queryParts
      : (requirements?.queryParts ?? Object.keys(catalogQueryConstants));
  const automatic =
    profile.preset === "baseline"
      ? buildGraph.baseline.optimizers
      : [
          ...(statements.includes("select")
            ? [
                "pointProjection",
                "simpleScan",
                ...(hasSecondaryIndexes ? ["secondaryRange"] : []),
              ]
            : []),
          ...(groups.includes("aggregates") ? ["aggregateScan"] : []),
          ...(profile.features.includes("jsonTableFunctions") &&
          groups.includes("aggregates")
            ? ["jsonTableAggregate"]
            : []),
          ...(profile.features.includes("updateFrom") &&
          statements.includes("update")
            ? ["updateFromLookup"]
            : []),
          ...(profile.features.includes("rowValues") &&
          statements.includes("select")
            ? ["rowMetadata"]
            : []),
          ...(groups.includes("inList") ? ["inListLookup"] : []),
          ...(parts.includes("inSelect") ? ["inSelectLookup"] : []),
        ];
  const roots = [
    "unit/engine",
    ...(profile.mode === "aot"
      ? [
          "api/execute",
          ...(
            apiCapabilities ??
            aotApiCapabilities.filter(
              (n) =>
                n !== "snapshotChunks" &&
                n !== "snapshotIncremental" &&
                (apiBackend !== "native" || n !== "delta"),
            )
          ).map((n) => `api/${n}`),
        ]
      : []),
    ...(profile.mode === "sql" ? ["unit/parser"] : []),
    ...profile.features.map((n) => `feature/${n}`),
    ...groups.map((n) => `function/${n}`),
    ...expressionGroups.map((n) => `expression/${n}`),
    ...statements.map((n) => `statement/${n}`),
    ...parts.map((n) => `query/${n}`),
    ...(optimizers ?? automatic).map((n) => `optimizer/${n}`),
  ];
  const selected = dependencyClosure(roots);
  return {
    format: "sqlike-build-plan@1",
    graphFormat: buildGraph.format,
    emitter,
    mode: profile.mode,
    ...(profile.mode === "aot" ? { apiBackend } : {}),
    apiCapabilities: aotApiCapabilities
      .filter((n) => selected.includes(`api/${n}`))
      .sort(),
    roots: [...new Set(roots)].sort(),
    selected,
    constants: constantsForSelection(selected),
    optimizers: optimizers ?? automatic,
    groups,
    expressionGroups,
    statements,
    parts,
  };
}
