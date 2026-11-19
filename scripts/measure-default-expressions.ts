import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import * as aot from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import { buildCatalog } from "./aot-compiler.ts";
import { aotBindings, aotValue } from "../src/aot-values.ts";
import { engineSourcePaths, sourceHashes } from "./measurement-manifest.ts";

// Bounded batches exercise default evaluation without a 100,000-item SQL AST.
const batchSize = 100,
  samples = 3;
const wasm = (
  await WebAssembly.instantiate(
    await readFile(
      "_build/wasm-gc/release/build/mizchi/litestream-example/runtime/runtime.wasm",
    ),
    {},
    { builtins: ["js-string"], importedStringConstants: "_" },
  )
).instance.exports as unknown as typeof aot;
const checked = (s: string) => {
  const r = JSON.parse(s);
  if (r.error) throw Error(r.error);
  return r;
};
const rows = [];
for (const kind of ["literal", "expression"] as const) {
  const schema = `CREATE TABLE t(id INTEGER PRIMARY KEY,n INT DEFAULT 3,v TEXT DEFAULT 'x',a,b,c,d INT DEFAULT ${kind === "literal" ? "3" : "(1+2)"})`;
  const insert = `INSERT INTO t(id) VALUES ${Array(batchSize).fill("(?)").join(",")}`;
  const query = "SELECT count(*),sum(n),min(v),max(d) FROM t";
  const artifact = buildCatalog({
    schema: [schema],
    queries: [
      { name: "add", sql: insert },
      { name: "q", sql: query },
    ],
  }).artifact;
  for (const count of [5_000, 100_000]) {
    const batches = Array.from({ length: count / batchSize }, (_, b) =>
      Array.from({ length: batchSize }, (_, i) =>
        BigInt(b * batchSize + i + 1),
      ),
    );
    const bindings = batches.map(aotBindings);
    for (const backend of ["sqlite", "js", "wasm"] as const) {
      const timings = [];
      for (let sample = -1; sample < samples; sample++) {
        globalThis.gc?.();
        const raw = backend === "js" ? aot : wasm;
        const native =
          backend === "sqlite" ? new DatabaseSync(":memory:") : undefined;
        const db = native ? undefined : raw.aot_open(artifact, "");
        try {
          native?.exec(schema);
          if (db) checked(raw.aot_info(db));
          const statement = native?.prepare(insert);
          const start = performance.now();
          for (let i = 0; i < batches.length; i++) {
            if (statement) statement.run(...batches[i]!);
            else checked(raw.aot_execute(db!, "add", bindings[i]!));
          }
          const elapsed = performance.now() - start;
          if (sample >= 0) timings.push(elapsed);
          let actual;
          if (native) {
            const q = native.prepare(query);
            q.setReadBigInts(true);
            q.setReturnArrays(true);
            actual = q.all();
          } else
            actual = checked(raw.aot_execute(db!, "q", "[]")).rows.map(
              (row: any[]) => row.map(aotValue),
            );
          assert.deepEqual(actual, [
            [BigInt(count), BigInt(count * 3), "x", 3n],
          ]);
        } finally {
          native?.close();
        }
      }
      timings.sort((a, b) => a - b);
      rows.push({
        kind,
        count,
        backend,
        medianMs: timings[1],
        samplesMs: timings,
      });
    }
  }
}
const output =
  process.argv[2] ?? "measurements/sqlike-default-performance-current.json";
await writeFile(
  output,
  JSON.stringify(
    {
      createdAt: new Date().toISOString(),
      node: process.version,
      batchSize,
      samples,
      notes: [
        "Prepared INSERT batches; bindings encoded before timing; one warmup per backend and row count.",
        "Not a cross-engine transaction benchmark: each engine uses its in-memory statement path.",
      ],
      sourceHashes: sourceHashes([
        ...engineSourcePaths(),
        "scripts/measure-default-expressions.ts",
      ]),
      rows,
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify(rows));
