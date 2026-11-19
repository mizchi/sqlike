import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { parseAst } from "vite";
import { buildSqlikeRuntime } from "./build-sqlike-runtime.ts";
import { buildCatalog } from "./aot-compiler.ts";
import { buildOxcBundle, minifyRuntime } from "./oxc-runtime.ts";
import { engineSourcePaths, sourceHashes } from "./measurement-manifest.ts";
import {
  defineSqlike, primaryKeyIndex, type SqlikeFeature,
} from "../src/sqlike-features.ts";
import type { SqlikeOptimizer } from "../src/sqlike-build-graph.ts";
import { openAotExecutor } from "../src/sqlike-aot-executor.ts";
import type { CatalogSource } from "../src/aot-contract.ts";
import type { Value } from "../src/contract.ts";

const output = process.argv[2] ?? "measurements/aot-minimum-current.json";
if (process.argv.length > 3) throw Error("usage: explore-aot-size.ts [report.json]");
const crud: CatalogSource = {
  schema: ["CREATE TABLE item(id INTEGER PRIMARY KEY,title TEXT,n INTEGER)"],
  queries: [
    { name: "create", sql: "INSERT INTO item VALUES(?,?,?)" },
    { name: "read", sql: "SELECT id,title,n FROM item WHERE id=?" },
    { name: "update", sql: "UPDATE item SET title=?,n=? WHERE id=?" },
    { name: "delete", sql: "DELETE FROM item WHERE id=?" },
  ],
};
const id = 9007199254740993n;
const cases: {
  name: string;
  catalog: CatalogSource;
  features: readonly SqlikeFeature[];
  optimizers?: readonly SqlikeOptimizer[];
  calls: [string, Value[]][];
}[] = [
  {
    name: "select-executor",
    catalog: { schema: [], queries: [{ name: "get", sql: "SELECT ? AS v" }] },
    features: [],
    optimizers: [],
    calls: [["get", [id]]] as [string, Value[]][],
  },
  ...["crud-executor", "crud-vite-default"].map((name) => ({
    name,
    catalog: crud,
    features: name === "crud-vite-default" ? [primaryKeyIndex] : [],
    optimizers: name === "crud-vite-default" ? undefined : [],
    calls: [
      ["create", [id, "日本語", 1n]],
      ["read", [id]],
      ["update", ["changed", 2n, id]],
      ["read", [id]],
      ["delete", [id]],
      ["read", [id]],
    ] as [string, Value[]][],
  })),
  {
    name: "select-vite-default",
    catalog: { schema: [], queries: [{ name: "get", sql: "SELECT ? AS v" }] },
    features: [primaryKeyIndex],
    calls: [["get", [id]]],
  },
];
function sizes(code: string) {
  const bytes = Buffer.from(code);
  const compressed = brotliCompressSync(bytes, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  });
  assert.deepEqual(brotliDecompressSync(compressed), bytes);
  return {
    bytes: bytes.length,
    brotli: compressed.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
const rows = [];
for (const sample of cases) {
  const directory = resolve("generated/aot-size-exploration/current", sample.name);
  const built = await buildSqlikeRuntime(
    defineSqlike({ mode: "aot", features: sample.features }),
    {
      outDir: directory,
      catalog: sample.catalog,
      optimizers: sample.optimizers,
      apiCapabilities: [],
      targets: ["js"],
      minify: false,
    },
  );
  const raw = await readFile(join(directory, "runtime.js"), "utf8");
  const code = await minifyRuntime(join(directory, "runtime.js"), built.exports);
  await writeFile(join(directory, "min.js"), code);
  const hostPath = relative(
    directory, resolve("src/sqlike-aot-executor.ts"),
  ).replaceAll("\\", "/");
  const entry = join(directory, "host.ts");
  await writeFile(
    entry,
    `import * as r from './min.js'; import {openAotExecutor} from ${JSON.stringify(hostPath)}; export function open(artifact:string){return openAotExecutor(r,artifact)};`,
  );
  const bundle = await buildOxcBundle(entry);
  const chunks = (Array.isArray(bundle) ? bundle : [bundle]).flatMap((r) =>
    "output" in r ? r.output : [],
  );
  assert.equal(chunks.length, 1);
  const chunk = chunks[0]!;
  assert.ok(chunk.type === "chunk");
  assert.deepEqual(chunk.imports, []);
  assert.deepEqual(chunk.dynamicImports, []);
  await writeFile(join(directory, "host.js"), chunk.code);
  const artifact = buildCatalog(sample.catalog).artifact;
  const engine = await import(pathToFileURL(join(directory, "min.js")).href);
  const host = await import(pathToFileURL(join(directory, "host.js")).href);
  for (const db of [openAotExecutor(engine, artifact), host.open(artifact)]) {
    const oracle = new DatabaseSync(":memory:");
    try {
      for (const ddl of sample.catalog.schema) oracle.exec(ddl);
      for (const [name, params] of sample.calls) {
        const query = sample.catalog.queries.find((q) => q.name === name)!;
        const stmt = oracle.prepare(query.sql);
        stmt.setReadBigInts(true);
        stmt.setReturnArrays(true);
        const result = db.execute(name, params);
        if (stmt.columns().length)
          assert.deepEqual(result.rows, stmt.all(...params));
        else
          assert.equal(result.changes, Number(stmt.run(...params).changes));
      }
    } finally {
      db.close();
      oracle.close();
    }
  }
  const functions = parseAst(raw).body.flatMap((node) =>
    node.type === "FunctionDeclaration"
      ? [{
          name: node.id?.name,
          bytes: Buffer.byteLength(raw.slice(node.start, node.end)),
        }]
      : [],
  ).sort((a, b) => b.bytes - a.bytes);
  const rawGroups: Record<string, { functions: number; bytes: number }> = {};
  for (const fn of functions) {
    const group = ["json", "strconv", "utf8", "mizchi6sqlike"].find(
      (part) => fn.name?.includes(part),
    ) ?? "other";
    const bucket = rawGroups[group] ??= { functions: 0, bytes: 0 };
    bucket.functions++;
    bucket.bytes += fn.bytes;
  }
  rows.push({
    name: sample.name,
    catalog: sample.catalog,
    catalogBytes: Buffer.byteLength(artifact),
    plan: built.plan,
    engine: sizes(code),
    hostBundle: sizes(chunk.code),
    rawBytes: Buffer.byteLength(raw),
    rawGroups,
    largestRawFunctions: functions.slice(0, 25),
  });
}
await mkdir(resolve(output, ".."), { recursive: true });
await writeFile(output, JSON.stringify({
  format: "sqlike-aot-minimum@1",
  measuredAt: new Date().toISOString(),
  node: process.version,
  moon: execFileSync("moon", ["version", "--all", "--no-path"], { encoding: "utf8" }).trim(),
  scope: "JS engine with four portable execute exports. OXC minified and per-file Brotli quality 11. hostBundle includes the execute-only host; both exclude catalog, Vite client metadata and application code. crud-vite-default uses the Vite plugin's default engine selection. Largest functions are unminified function-body bytes, not additive compressed attribution.",
  verification: "Each minified engine and host bundle ran the catalog against native node:sqlite, including exact int64 parameters and CRUD state transitions.",
  sources: sourceHashes([
    ...engineSourcePaths(), "scripts/explore-aot-size.ts", "scripts/build-sqlike-runtime.ts",
    "scripts/oxc-runtime.ts", "scripts/aot-compiler.ts", "src/sqlike-build-plan.ts",
    "src/sqlike-build-graph.json", "src/sqlike-aot-executor.ts",
  ]),
  rows,
}, null, 2) + "\n");
console.table(rows.map((r) => ({ name: r.name, engine: r.engine.bytes, brotli: r.engine.brotli, host: r.hostBundle.bytes, hostBrotli: r.hostBundle.brotli })));
