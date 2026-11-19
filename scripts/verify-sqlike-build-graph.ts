import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  buildGraph,
  validateBuildGraph,
  dependencyClosure,
  baselineRoots,
  assertBuildSelection,
  type BuildGraph,
  selectedAotExports,
} from "../src/sqlike-build-graph.ts";
import {
  generateSqlikePackages,
  canonicalEngine,
} from "./generate-sqlike-packages.ts";
import { sourceHashes, engineSourcePaths } from "./measurement-manifest.ts";
import { createBuildPlan } from "../src/sqlike-build-plan.ts";
import { baselineSqlike, defineSqlike } from "../src/sqlike-features.ts";
import { generateBuildGraph } from "./generate-build-graph.ts";
import { nativeAotExports } from "./sqlike-runtime-declarations.ts";

await generateBuildGraph(true);
const text = readFileSync("src/sqlike-build-graph.json", "utf8");
assert.deepEqual(JSON.parse(text), buildGraph, "stale generated build graph");
const nodes = validateBuildGraph(),
  ordered = [...nodes.values()],
  ids = ordered.map((n) => n.id),
  index = new Map(ids.map((id, i) => [id, i]));
assert.deepEqual(
  [...baselineSqlike().features].sort(),
  [...buildGraph.baseline.features].sort(),
  "baseline preset drift",
);
const files = readdirSync(canonicalEngine).filter(
  (n) => n.endsWith(".mbt") && !/_w?b?test\.mbt$/.test(n),
);
const owned = ordered.flatMap((n) => n.files ?? []);
assert.equal(
  new Set(owned).size,
  owned.length,
  "implementation file has multiple owners",
);
assert.deepEqual(
  [...new Set(owned)].sort(),
  files.sort(),
  "unclassified or stale implementation files",
);
const source = files
  .map((n) => readFileSync(`${canonicalEngine}/${n}`, "utf8"))
  .join("\n");
const api = JSON.parse(readFileSync("src/sqlike-public-api.json", "utf8"));
assert.deepEqual(
  selectedAotExports(
    dependencyClosure(
      ordered
        .filter((n) => n.kind === "api" && n.id !== "api/delta")
        .map((n) => n.id),
    ),
    "native",
  ),
  [...nativeAotExports].sort(),
  "native AOT capability export contract drift",
);
assert.deepEqual(
  selectedAotExports(createBuildPlan(defineSqlike({ mode: "aot" })).selected),
  [...api.aotExports].sort(),
  "AOT capability export contract drift",
);
assert.deepEqual(
  [...source.matchAll(/^pub fn(?:\[[^\]]+\])? ([a-z_][a-z_0-9]*)\(/gm)]
    .map((m) => m[1]!)
    .sort(),
  api.fullFunctions,
  "public API contract drift",
);
assert.deepEqual(
  [
    ...source.matchAll(
      /^(?:pub(?:\(all\))? )?(?:struct|enum|suberror|typealias) ([A-Z][A-Za-z_0-9]*)\b/gm,
    ),
  ]
    .map((m) => m[1]!)
    .sort(),
  api.fullTypes,
  "public type contract drift",
);
assert.deepEqual(
  [...source.matchAll(/^(?:pub )?trait ([A-Z][A-Za-z_0-9]*)\b/gm)]
    .map((m) => m[1]!)
    .sort(),
  api.traits,
  "public trait contract drift",
);
for (const name of [
  ...api.baselineExports,
  ...api.aotExports,
  ...api.sqlExports,
  ...selectedAotExports(
    dependencyClosure(ordered.filter((n) => n.kind === "api").map((n) => n.id)),
  ),
])
  assert.ok(api.fullFunctions.includes(name), `unknown public export ${name}`);
const constants = [
  ...source.matchAll(
    /const ((?:FEATURE|CAP_FUNCTION|CAP_EXPRESSION|CAP_STATEMENT|CAP_QUERY|CAP_API|OPT)_[A-Z_]+) : Bool/g,
  ),
].map((m) => m[1]!);
assert.deepEqual(
  [...ordered.flatMap((n) => (n.constant ? [n.constant] : []))].sort(),
  constants.sort(),
  "unclassified compiler constants",
);
for (const n of ordered.filter(
  (n) => n.constant && ["optimizer", "api", "expression"].includes(n.kind),
))
  assert.match(
    source,
    new RegExp(`(?:guard|if) ${n.constant}\\b`),
    `capability has no execution gate: ${n.id}`,
  );
await generateSqlikePackages(true);
assertBuildSelection(dependencyClosure(baselineRoots()));

const sym = (prefix: string, i: number) => `${prefix}${i}`;
const declarations = (prefix: string) =>
  ids.map((_, i) => `(declare-const ${sym(prefix, i)} Bool)`).join("\n");
const or = (xs: string[]) => (xs.length ? `(or ${xs.join(" ")})` : "false");
const and = (xs: string[]) => (xs.length ? `(and ${xs.join(" ")})` : "true");
const definitions = (
  roots: string,
  out: string,
  graph: BuildGraph = buildGraph,
) =>
  ids
    .map((id, i) => {
      const parents = graph.nodes
        .filter((n) => n.requires.includes(id))
        .map((n) => sym(out, index.get(n.id)!));
      return `(assert (= ${sym(out, i)} ${or([sym(roots, i), ...parents])}))`;
    })
    .join("\n");
const closed = (out: string) =>
  and(
    ordered.flatMap((n, i) =>
      n.requires.map((d) => `(=> ${sym(out, i)} ${sym(out, index.get(d)!)})`),
    ),
  );
const subset = (a: string, b: string) =>
  and(ids.map((_, i) => `(=> ${sym(a, i)} ${sym(b, i)})`));
const obligations: { name: string; expected: "unsat" | "sat"; body: string }[] =
  [];
obligations.push({
  name: "dependency closure",
  expected: "unsat",
  body: `(assert (not ${closed("c")}))`,
});
obligations.push({
  name: "least closed superset",
  expected: "unsat",
  body: `(assert ${closed("x")})\n(assert ${subset("r", "x")})\n(assert (not ${subset("c", "x")}))`,
});
obligations.push({
  name: "monotone closure",
  expected: "unsat",
  body: `${definitions("s", "d")}\n(assert ${subset("r", "s")})\n(assert (not ${subset("c", "d")}))`,
});
obligations.push({
  name: "idempotent closure",
  expected: "unsat",
  body: `${definitions("c", "d")}\n(assert (not ${and(ids.map((_, i) => `(= ${sym("c", i)} ${sym("d", i)})`))}))`,
});
// The implementation computes each root's reachable nodes. The union of these
// tables must equal the graph equations for every Boolean combination of roots.
const reachable = ids.map((id) => new Set(dependencyClosure([id])));
obligations.push({
  name: "implementation reachability table agrees with graph",
  expected: "unsat",
  body: `(assert ${or(ids.map((id, i) => `(not (= c${i} ${or(ids.flatMap((_, r) => (reachable[r]!.has(id) ? [`r${r}`] : [])))}))`))})`,
});
const baseline = new Set(baselineRoots());
obligations.push({
  name: "baseline sanity",
  expected: "sat",
  body: ids.map((id, i) => `(assert (= r${i} ${baseline.has(id)}))`).join("\n"),
});
const bad = structuredClone(buildGraph);
const victim = bad.nodes.find((n) => n.id === "feature/jsonTableFunctions")!;
(victim.requires as string[]).splice(0, 1);
const badSelection = dependencyClosure([victim.id], bad);
assert.throws(
  () => assertBuildSelection(badSelection),
  /requires unit\/jsonTable/,
);
obligations.push({
  name: "missing JSON-table dependency mutation",
  expected: "sat",
  body: `${definitions("r", "b", bad)}\n${ids.map((id, i) => `(assert (= r${i} ${id === victim.id}))`).join("\n")}\n(assert (not ${closed("b")}))`,
});
// Independent artifact publication model. Handled failures must not publish.
const publication = `(declare-const graph_valid Bool)\n(declare-const targets_built Bool)\n(declare-const exports_valid Bool)\n(declare-const published Bool)\n(assert (= published (and graph_valid targets_built exports_valid)))\n(assert (and published (not (and graph_valid targets_built exports_valid))))`;
obligations.push({
  name: "publication requires all checks",
  expected: "unsat",
  body: publication,
});
const smt =
  `; Generated build-graph verification conditions.\n(set-logic QF_UF)\n${["r", "c", "x", "s", "d", "b"].map(declarations).join("\n")}\n${definitions("r", "c")}\n` +
  obligations
    .map((o) => `(push)\n; ${o.name}\n${o.body}\n(check-sat)\n(pop)`)
    .join("\n");
mkdirSync("generated/build-graph", { recursive: true });
writeFileSync("generated/build-graph/contract.smt2", smt);
const version = execFileSync("z3", ["--version"], { encoding: "utf8" }).trim();
const answers = execFileSync("z3", ["-in"], {
  input: smt,
  encoding: "utf8",
  timeout: 30000,
})
  .trim()
  .split(/\s+/);
assert.deepEqual(
  answers,
  obligations.map((o) => o.expected),
  "Z3 proof/counterexample failed",
);
const result = obligations.map((o, i) => ({
  name: o.name,
  result: answers[i],
}));
writeFileSync(
  "measurements/sqlike-build-graph-proof.json",
  JSON.stringify(
    {
      format: "sqlike-build-graph-proof@1",
      verifiedAt: new Date().toISOString(),
      solver: version,
      scope:
        "All Boolean root selections of the declared finite acyclic dependency graph: closed, least, monotone, idempotent. Positive baseline and broken-edge SAT witnesses are required. Publication predicate is a model, exercised separately against staged output tests. Does not prove SQL semantics, graph completeness beyond classified constants/files, compiler correctness, or every backend combination.",
      graphSHA256: createHash("sha256").update(text).digest("hex"),
      nodes: ids.length,
      edges: ordered.reduce((n, v) => n + v.requires.length, 0),
      results: result,
      witness: {
        root: victim.id,
        removedDependency: "unit/jsonTable",
        implementationReproduction:
          "dependencyClosure(mutated graph) fails assertBuildSelection(original graph)",
      },
      sources: sourceHashes([
        ...engineSourcePaths(),
        "src/sqlike-build-graph.json",
        "src/sqlike-build-graph.generated.ts",
        "src/sqlike-build-graph.ts",
        "src/sqlike-build-plan.ts",
        "src/sqlike-features.ts",
        "src/sqlike-public-api.json",
        "scripts/generate-build-graph.ts",
        "scripts/generate-sqlike-packages.ts",
        "scripts/build-sqlike-runtime.ts",
        "scripts/emit-sqlike-moonbit.ts",
        "scripts/build-staging.ts",
        "scripts/sqlike-runtime-declarations.ts",
        "src/sqlike-aot-executor.ts",
        "src/sqlike-portable-aot.ts",
        "scripts/verify-sqlike-build-graph.ts",
      ]),
    },
    null,
    2,
  ) + "\n",
);
console.table(result);
