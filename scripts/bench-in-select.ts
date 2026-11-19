import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { cpus } from "node:os";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { brotliCompressSync, constants } from "node:zlib";
import { buildSqlikeRuntime } from "./build-sqlike-runtime.ts";
import { defineSqlike, primaryKeyIndex } from "../src/sqlike-features.ts";
import { buildCatalog } from "./aot-compiler.ts";
import { aotBindings, aotValue } from "../src/aot-values.ts";
import {
  engineSourcePaths,
  sourceHashes,
  fileHash,
} from "./measurement-manifest.ts";

const checked = (text: string) => {
  const r = JSON.parse(text);
  if (r.error) throw Error(r.error);
  return r;
};
const results = [],
  fixtures = [],
  sizes = [],
  artifacts: Record<string, string> = {};
let sqliteVersion = "";
function measure(run: () => bigint, expected: bigint) {
  assert.equal(run(), expected);
  globalThis.gc?.();
  const samples = [],
    startHeap = process.memoryUsage().heapUsed;
  let observedPeak = startHeap;
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    assert.equal(run(), expected);
    samples.push(performance.now() - start);
    observedPeak = Math.max(observedPeak, process.memoryUsage().heapUsed);
  }
  globalThis.gc?.();
  const afterGc = process.memoryUsage().heapUsed;
  return {
    medianMs: [...samples].sort((a, b) => a - b)[1]!,
    samplesMs: samples,
    observedAfterCallHeapDelta: observedPeak - startHeap,
    afterGcHeapDelta: afterGc - startHeap,
  };
}
for (const kind of ["scalar", "row"] as const)
  for (const count of [5000, 100000]) {
    const width = count === 5000 ? 64 : 8,
      batch = 100;
    const source = {
      schema: [
        "CREATE TABLE t(id INTEGER PRIMARY KEY,n NUMERIC,s TEXT COLLATE NOCASE)",
        "CREATE TABLE r(n NUMERIC,s TEXT COLLATE NOCASE)",
      ],
      queries: [
        {
          name: "seed",
          sql: `INSERT INTO t VALUES ${Array.from({ length: batch }, (_, i) => `(?${i * 3 + 1},?${i * 3 + 2},?${i * 3 + 3})`).join(",")}`,
        },
        { name: "rhs", sql: "INSERT INTO r VALUES(?1,?2)" },
        {
          name: "read",
          sql: `SELECT count(*) FROM t WHERE ${kind === "row" ? "(n,s)" : "n"} IN(SELECT ${kind === "row" ? "n,s" : "n"} FROM r WHERE n>=?1 OR n IS NULL)`,
        },
      ],
    };
    const native = new DatabaseSync(":memory:");
    source.schema.forEach((q) => native.exec(q));
    sqliteVersion = String(
      native.prepare("SELECT sqlite_version() AS v").get()!.v,
    );
    const insert = native.prepare("INSERT INTO t VALUES(?,?,?)"),
      rhs = native.prepare(source.queries[1]!.sql);
    native.exec("BEGIN");
    for (let i = 1; i <= count; i++)
      insert.run(i, i % 1280 === 0 ? null : i % 256, `v${i % 8}`);
    for (let i = 0; i < width; i++)
      rhs.run(i === 0 ? null : i, i === 0 ? "unknown" : `V${i % 8}`);
    native.exec("COMMIT");
    const stmt = native.prepare(source.queries[2]!.sql);
    stmt.setReadBigInts(true);
    stmt.setReturnArrays(true);
    const runNative = () => (stmt.all(0n) as unknown as bigint[][])[0]![0]!,
      expected = runNative();
    globalThis.gc?.();
    results.push({
      kind,
      count,
      width,
      engine: "sqlite/prepared",
      ...measure(runNative, expected),
    });
    fixtures.push({ kind, count, width, source });
    try {
      for (const enabled of [false, true]) {
        const built = await buildSqlikeRuntime(
          defineSqlike({ mode: "aot", features: [primaryKeyIndex] }),
          {
            catalog: source,
            outDir: `generated/in-select-bench/${kind}-${count}-${enabled}`,
            apiCapabilities: [],
            optimizers: [
              "pointProjection",
              "simpleScan",
              "aggregateScan",
              ...(enabled ? ["inSelectLookup" as const] : []),
            ],
          },
        );
        for (const target of ["js", "wasm"]) {
          const path = join(built.directory, `runtime.${target}`),
            bytes = await readFile(path);
          artifacts[path] = fileHash(path);
          sizes.push({
            kind,
            count,
            enabled,
            target,
            bytes: bytes.length,
            brotli: brotliCompressSync(bytes, {
              params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
            }).length,
          });
        }
        const js = await import(
            pathToFileURL(join(built.directory, "runtime.js")).href
          ),
          wasm = (
            await WebAssembly.instantiate(
              await readFile(join(built.directory, "runtime.wasm")),
              {},
              { builtins: ["js-string"], importedStringConstants: "_" },
            )
          ).instance.exports;
        for (const [target, raw] of [
          ["js", js],
          ["wasm", wasm],
        ] as const) {
          const db = raw.aot_open(buildCatalog(source).artifact, "");
          checked(raw.aot_info(db));
          for (let offset = 0; offset < count; offset += batch) {
            const values = [];
            for (let j = 1; j <= batch; j++) {
              const id = offset + j;
              values.push(
                BigInt(id),
                id % 1280 === 0 ? null : BigInt(id % 256),
                `v${id % 8}`,
              );
            }
            checked(raw.aot_execute(db, "seed", aotBindings(values)));
          }
          for (let i = 0; i < width; i++)
            checked(
              raw.aot_execute(
                db,
                "rhs",
                aotBindings([
                  i === 0 ? null : BigInt(i),
                  i === 0 ? "unknown" : `V${i % 8}`,
                ]),
              ),
            );
          const params = aotBindings([0n]),
            run = () =>
              aotValue(
                checked(raw.aot_execute(db, "read", params)).rows[0][0],
              ) as bigint;
          globalThis.gc?.();
          results.push({
            kind,
            count,
            width,
            engine: `${target}/${enabled ? "cache" : "repeat"}`,
            ...measure(run, expected),
          });
        }
      }
    } finally {
      native.close();
    }
  }
await writeFile(
  "measurements/in-select-paired.json",
  JSON.stringify(
    {
      format: "sqlike-in-select-bench@1",
      measuredAt: new Date().toISOString(),
      node: process.version,
      cpu: cpus()[0]?.model,
      moon: execFileSync("moon", ["version"], { encoding: "utf8" }).trim(),
      sqliteVersion,
      scope:
    "In-memory prepared COUNT over unindexed columns and an independent physical RHS; one warmup and GC then three single-query samples, setup/bind encoding excluded. Same source/profile/exports/other optimizers per pair; only inSelectLookup differs, including the slot aggregate visitor. Heap samples are after calls, include garbage and are not peak/RSS bounds. afterGcHeapDelta is relative to a GC baseline after warmup and includes JIT/runtime retention, not a cache heap upper bound.",
      fixtures,
      results,
      sizes,
      artifacts,
      sources: sourceHashes([
        ...engineSourcePaths(),
        "scripts/bench-in-select.ts",
        "scripts/build-sqlike-runtime.ts",
        "src/sqlike-build-graph.json",
        "src/sqlike-build-plan.ts",
      ]),
    },
    null,
    2,
  ) + "\n",
);
console.table(
  results.map((r) => ({
    ...r,
    medianMs: r.medianMs.toFixed(3),
    samplesMs: undefined,
  })),
);
