import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** JSON is the contract; TS and the complete diagram are derived views. */
export async function generateBuildGraph(check = false) {
  const graph = JSON.parse(
    await readFile("src/sqlike-build-graph.json", "utf8"),
  ) as {
    nodes: { id: string; kind: string; requires: string[] }[];
    constraints: { if: string; requires: string }[];
  };
  const ids = new Map(graph.nodes.map((n, i) => [n.id, `n${i}`]));
  const outputs = new Map([
    [
      "src/sqlike-build-graph.generated.ts",
      `// Generated from sqlike-build-graph.json.\nexport const sqlikeBuildGraph = ${JSON.stringify(graph, null, 2)} as const;\n`,
    ],
    [
      "docs/internal/sqlike-build-graph.mmd",
      [
        "%% Generated from src/sqlike-build-graph.json. Arrows mean requires.",
        "flowchart LR",
        ...graph.nodes.map((n) => `  ${ids.get(n.id)}[\"${n.id}\"]`),
        ...graph.nodes.flatMap((n) =>
          n.requires.map((dep) => `  ${ids.get(n.id)} --> ${ids.get(dep)}`),
        ),
        ...graph.constraints.map(
          (c) => `  ${ids.get(c.if)} -. constraint .-> ${ids.get(c.requires)}`,
        ),
        "",
      ].join("\n"),
    ],
  ]);
  for (const [path, text] of outputs) {
    if (check)
      assert.equal(
        await readFile(path, "utf8"),
        text,
        `stale generated graph ${path}`,
      );
    else await writeFile(path, text);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await generateBuildGraph(process.argv.includes("--check"));
