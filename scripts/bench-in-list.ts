import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { cpus } from "node:os";
import { execFileSync } from "node:child_process";
import { buildSqlikeRuntime } from "./build-sqlike-runtime.ts";
import { buildCatalog } from "./aot-compiler.ts";
import { defineSqlike, primaryKeyIndex } from "../src/sqlike-features.ts";
import { aotBindings, aotValue } from "../src/aot-values.ts";
import {
  engineSourcePaths,
  sourceHashes,
  fileHash,
} from "./measurement-manifest.ts";

const results = [],
  fixtures = [],
  artifacts: Record<string, string> = {};
let sqliteVersion: string | undefined;
const checked = (s: string) => {
  const r = JSON.parse(s);
  if (r.error) throw Error(r.error);
  return r;
};
function measure(run: () => bigint, expected: bigint) {
  for (let i = 0; i < 2; i++) assert.equal(run(), expected);
  const samples = [];
  for (let sample = 0; sample < 3; sample++) {
    let iterations = 0,
      last = 0n;
    const start = performance.now();
    do {
      last = run();
      iterations++;
    } while (performance.now() - start < 20 && iterations < 5);
    const milliseconds = (performance.now() - start) / iterations;
    assert.equal(last, expected);
    samples.push(milliseconds);
  }
  return {
    medianMs: [...samples].sort((a, b) => a - b)[1]!,
    samplesMs: samples,
  };
}
for (const kind of ["scalar", "row"] as const)
  for (const count of [5000, 100000]) {
    // Keep the slow comparison bounded at about 1.3–1.6 million RHS checks.
    const width = count === 5000 ? (kind === "row" ? 64 : 256) : 16,
      batch = 100;
    const columns = kind === "row" ? 3 : 2;
    const source = {
      schema: [
        "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER" +
          (kind === "row" ? ",s TEXT COLLATE NOCASE" : "") +
          ")",
      ],
      queries: [
        {
          name: "seed",
          sql: `INSERT INTO t VALUES ${Array.from({ length: batch }, (_, i) => `(${Array.from({ length: columns }, (_, j) => `?${i * columns + j + 1}`).join(",")})`).join(",")}`,
        },
        {
          name: "read",
          sql: `SELECT count(*) FROM t WHERE ${kind === "row" ? "(n,s)" : "n"} IN (${Array.from({ length: width }, (_, i) => (kind === "row" ? `(?${i * 2 + 1},?${i * 2 + 2})` : `?${i + 1}`)).join(",")})`,
        },
      ],
    };
    const artifact = buildCatalog(source).artifact,
      params = Array.from({ length: width }, (_, i) =>
        kind === "row" ? [BigInt(i), `V${i % 16}`] : [BigInt(i)],
      ).flat(),
      encoded = aotBindings(params);
    fixtures.push({ kind, count, width, source });
    const native = new DatabaseSync(":memory:");
    sqliteVersion ??= String(
      native.prepare("SELECT sqlite_version() AS version").get()!.version,
    );
    native.exec(source.schema[0]!);
    const insert = native.prepare(
      `INSERT INTO t VALUES(${Array(columns).fill("?").join(",")})`,
    );
    native.exec("BEGIN");
    for (let i = 1; i <= count; i++) {
      if (kind === "row")
        insert.run(
          i,
          i % 1280 === 0 ? null : i % 512,
          i % 1536 === 0 ? null : `v${i % 16}`,
        );
      else insert.run(i, i % 512);
    }
    native.exec("COMMIT");
    const statement = native.prepare(source.queries[1]!.sql);
    statement.setReadBigInts(true);
    statement.setReturnArrays(true);
    const runNative = () =>
      (statement.all(...params) as unknown as bigint[][])[0]![0]!;
    const expected = runNative();
    results.push({
      kind,
      count,
      width,
      engine: "sqlite/prepared",
      ...measure(runNative, expected),
    });
    try {
      for (const enabled of [false, true]) {
        const built = await buildSqlikeRuntime(
          defineSqlike({ mode: "aot", features: [primaryKeyIndex] }),
          {
            catalog: source,
            outDir: `generated/in-list-bench/${kind}-${count}-${enabled}`,
            apiCapabilities: [],
            optimizers: [
              "pointProjection",
              "simpleScan",
              "aggregateScan",
              ...(kind === "row" ? ["rowMetadata" as const] : []),
              ...(enabled ? ["inListLookup" as const] : []),
            ],
          },
        );
        for (const name of ["runtime.js", "runtime.wasm"]) {
          const path = join(built.directory, name);
          artifacts[path] = fileHash(path);
        }
        const js = await import(
          pathToFileURL(join(built.directory, "runtime.js")).href
        );
        const wasm = (
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
          globalThis.gc?.();
          const api = raw as typeof js,
            db = api.aot_open(artifact, "");
          checked(api.aot_info(db));
          for (let offset = 0; offset < count; offset += batch) {
            const values = [];
            for (let j = 1; j <= batch; j++) {
              const id = offset + j;
              values.push(
                BigInt(id),
                kind === "row" && id % 1280 === 0 ? null : BigInt(id % 512),
              );
              if (kind === "row")
                values.push(id % 1536 === 0 ? null : `v${id % 16}`);
            }
            checked(api.aot_execute(db, "seed", aotBindings(values)));
          }
          const run = () =>
            aotValue(
              checked(api.aot_execute(db, "read", encoded)).rows[0][0],
            ) as bigint;
          results.push({
            kind,
            count,
            width,
            engine: `${target}/${enabled ? "lookup" : "linear"}`,
            ...measure(run, expected),
          });
        }
      }
    } finally {
      native.close();
    }
  }
await writeFile(
  "measurements/in-list-paired.json",
  JSON.stringify(
    {
      format: "sqlike-in-list-bench@1",
      measuredAt: new Date().toISOString(),
      node: process.version,
      cpu: cpus()[0]?.model,
      moon: execFileSync("moon", ["version"], { encoding: "utf8" }).trim(),
      sqliteVersion,
      scope:
        "In-memory prepared aggregate over non-indexed scalar/row columns; two warmups and three bounded samples; binding encoding and setup excluded. Same source, exports and other optimizer flags per pair. Row inputs include NULL and NOCASE strings.",
      fixtures,
      results,
      artifacts,
      sources: sourceHashes([
        ...engineSourcePaths(),
        "scripts/bench-in-list.ts",
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
