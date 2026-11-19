import { sqlikeBuildGraph } from "./sqlike-build-graph.generated.ts";
export interface BuildNode {
  id: string;
  kind: string;
  requires: readonly string[];
  files?: readonly string[];
  constant?: string;
  exports?: readonly string[];
  nativeExports?: readonly string[];
}
export interface BuildGraph {
  format: string;
  nodes: readonly BuildNode[];
  baseline: {
    features: readonly string[];
    functions: readonly string[];
    expressionGroups: readonly string[];
    statements: readonly string[];
    queryParts: readonly string[];
    optimizers: readonly string[];
  };
  constraints: readonly { if: string; requires: string }[];
}
export const buildGraph: BuildGraph = sqlikeBuildGraph;
export type SqlikeOptimizer =
  | "pointProjection"
  | "simpleScan"
  | "secondaryRange"
  | "aggregateScan"
  | "jsonTableAggregate"
  | "updateFromLookup"
  | "rowMetadata"
  | "inListLookup"
  | "inSelectLookup";
export type AotApiCapability =
  | "execute"
  | "prepared"
  | "snapshot"
  | "snapshotIncremental"
  | "snapshotChunks"
  | "transaction"
  | "delta";
export const aotApiCapabilities: readonly AotApiCapability[] = [
  "execute",
  "prepared",
  "snapshot",
  "snapshotChunks",
  "snapshotIncremental",
  "transaction",
  "delta",
];
export function selectedAotExports(
  selected: readonly string[],
  backend: "portable" | "native" = "portable",
) {
  if (backend !== "portable" && backend !== "native")
    throw Error("unknown AOT API backend");
  assertBuildSelection(selected);
  const set = new Set(selected);
  return [
    ...new Set(
      buildGraph.nodes.flatMap((n) =>
        n.kind === "api" && set.has(n.id)
          ? ((backend === "native" ? n.nativeExports : n.exports) ?? [])
          : [],
      ),
    ),
  ].sort();
}
export function validateBuildGraph(graph: BuildGraph = buildGraph) {
  if (graph.format !== "sqlike-build-graph@1")
    throw Error("unknown build graph format");
  const nodes = new Map<string, BuildNode>(),
    constants = new Set<string>();
  for (const n of graph.nodes) {
    if (nodes.has(n.id)) throw Error(`duplicate build node ${n.id}`);
    nodes.set(n.id, n);
    if (n.constant) {
      if (constants.has(n.constant))
        throw Error(`duplicate build constant ${n.constant}`);
      constants.add(n.constant);
    }
  }
  const done = new Set<string>(),
    active = new Set<string>();
  const visit = (id: string) => {
    const node = nodes.get(id);
    if (!node) throw Error(`missing dependency ${id}`);
    if (active.has(id)) throw Error(`cyclic build dependency ${id}`);
    if (done.has(id)) return;
    active.add(id);
    node.requires.forEach(visit);
    active.delete(id);
    done.add(id);
  };
  nodes.forEach((n) => visit(n.id));
  for (const c of graph.constraints)
    if (!nodes.has(c.if) || !nodes.has(c.requires))
      throw Error("unknown build constraint");
  return nodes;
}
/** Least dependency closure. Semantic roots and optional optimizers are distinct. */
export function dependencyClosure(
  roots: readonly string[],
  graph: BuildGraph = buildGraph,
): string[] {
  const nodes = validateBuildGraph(graph),
    selected = new Set<string>();
  const visit = (id: string) => {
    const n = nodes.get(id);
    if (!n) throw Error(`unknown build root ${id}`);
    if (selected.has(id)) return;
    selected.add(id);
    n.requires.forEach(visit);
  };
  roots.forEach(visit);
  return [...selected].sort();
}
export function assertBuildSelection(
  selected: readonly string[],
  graph: BuildGraph = buildGraph,
) {
  const nodes = validateBuildGraph(graph),
    set = new Set(selected);
  for (const id of selected) {
    const n = nodes.get(id);
    if (!n) throw Error(`unknown build node ${id}`);
    for (const dep of n.requires)
      if (!set.has(dep)) throw Error(`${id} requires ${dep}`);
  }
  for (const c of graph.constraints)
    if (set.has(c.if) && !set.has(c.requires))
      throw Error(`${c.if} requires ${c.requires}`);
}
export function constantsForSelection(
  selected: readonly string[],
  graph: BuildGraph = buildGraph,
) {
  assertBuildSelection(selected, graph);
  const set = new Set(selected);
  return Object.fromEntries(
    graph.nodes
      .filter((n) => n.constant)
      .map((n) => [n.constant!, set.has(n.id)]),
  );
}
export const baselineRoots = () => [
  "unit/engine",
  "unit/parser",
  ...buildGraph.baseline.features.map((n) => `feature/${n}`),
  ...buildGraph.baseline.functions.map((n) => `function/${n}`),
  ...buildGraph.baseline.expressionGroups.map((n) => `expression/${n}`),
  ...buildGraph.baseline.statements.map((n) => `statement/${n}`),
  ...buildGraph.baseline.queryParts.map((n) => `query/${n}`),
  ...buildGraph.baseline.optimizers.map((n) => `optimizer/${n}`),
];
