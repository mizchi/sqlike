import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cpus } from "node:os";
import { createHash } from "node:crypto";
import { NodeDatabase } from "../adapters/node-database.ts";
import { aotBindings, aotValue } from "../src/aot-values.ts";
import type { Value } from "../src/contract.ts";
import {
  engineSourcePaths,
  sourceHashes,
  fileHash,
} from "./measurement-manifest.ts";

const option = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const before = option("before-dir"),
  output = option("output") ?? "measurements/update-from-speed-current.json";
const files: [string, string][] = [
  ...(before
    ? ([
        ["before/js", `${before}/full.js`],
        ["before/wasm", `${before}/full.wasm`],
      ] as [string, string][])
    : []),
  [
    before ? "after/js" : "js",
    "_build/js/release/build/mizchi/sqlike/full/full.js",
  ],
  [
    before ? "after/wasm" : "wasm",
    "_build/wasm-gc/release/build/mizchi/sqlike/full/full.wasm",
  ],
];
type Runtime =
  typeof import("../_build/js/release/build/mizchi/sqlike/full/full.js");
const runtimes: { engine: string; api: Runtime }[] = [];
for (const [engine, path] of files) {
  const api = path.endsWith(".wasm")
    ? (
        await WebAssembly.instantiate(
          readFileSync(path),
          {},
          { builtins: ["js-string"], importedStringConstants: "_" },
        )
      ).instance.exports
    : await import(pathToFileURL(resolve(path)).href);
  runtimes.push({ engine, api: api as unknown as Runtime });
}
function checked(text: string) {
  const result = JSON.parse(text);
  if (result.error) throw Error(result.error);
  return result;
}
const schema = [
  "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)",
  "CREATE TABLE s(id INTEGER PRIMARY KEY,n INTEGER)",
];
const query = "UPDATE t SET n=s.n+?1 FROM s WHERE t.id=s.id";
const observe = "SELECT count(*),sum(n),changes() FROM t";
const results = [],
  fixtures = [];
function measure(run: (delta: bigint) => void) {
  run(0n);
  const samples = [1n, 2n, 3n].map((delta) => {
    const start = performance.now();
    run(delta);
    return { delta: Number(delta), milliseconds: performance.now() - start };
  });
  return {
    samples,
    medianMilliseconds: samples
      .map((s) => s.milliseconds)
      .sort((a, b) => a - b)[1]!,
  };
}
for (const rows of [5000, 100000]) {
  const native = new NodeDatabase(":memory:");
  try {
    schema.forEach((sql) => native.raw.exec(sql));
    native.transaction(() => {
      const target = native.raw.prepare("INSERT INTO t VALUES(?,0)");
      const source = native.raw.prepare("INSERT INTO s VALUES(?,?)");
      for (let i = 1; i <= rows; i++) {
        target.run(i);
        source.run(i, i % 100);
      }
    });
    const bytes = native.raw.serialize(),
      image = Buffer.from(bytes).toString("base64");
    fixtures.push({
      rows,
      sqliteImageSHA256: createHash("sha256").update(bytes).digest("hex"),
    });
    const statement = native.raw.prepare(query);
    const plan = native.raw
      .prepare("EXPLAIN QUERY PLAN " + query)
      .all(0)
      .map((row) => String(row.detail));
    results.push({
      rows,
      engine: "sqlite/prepared",
      plan,
      ...measure((delta) => {
        statement.run(delta);
      }),
    });
    const oracle = native.raw.prepare(observe);
    oracle.setReadBigInts(true);
    oracle.setReturnArrays(true);
    const expected = oracle.all();
    for (const { engine, api } of runtimes) {
      const db = api.database_open();
      checked(api.database_import_sqlite_base64(db, image));
      const prepared = api.database_prepare(db, query);
      const timing = measure((delta) => {
        checked(
          api.database_prepared_exec(
            prepared,
            aotBindings([delta]),
            false,
            true,
          ),
        );
      });
      const actual: Value[][] = checked(
        api.database_query_values(db, observe, "[]"),
      ).rows.map((row: any[]) => row.map(aotValue));
      assert.deepEqual(actual, expected);
      results.push({ rows, engine, ...timing });
      (globalThis as { gc?: () => void }).gc?.();
    }
  } finally {
    native.close();
  }
}
writeFileSync(
  output,
  JSON.stringify(
    {
      format: "sqlike-update-from-speed@1",
      measuredAt: new Date().toISOString(),
      node: process.version,
      cpu: cpus()[0]?.model,
      scope:
        "Node in-memory prepared SQL; one-to-one source IPK join; all targets updated; no RETURNING; warmup then three single-statement samples with changing bindings; setup, import, preparation and verification excluded; no persistence or RPC",
      schema,
      query,
      observe,
      fixtures,
      results,
      ...(before
        ? {
            baselineSources: JSON.parse(
              readFileSync(`${before}/sources.json`, "utf8"),
            ),
          }
        : {}),
      artifacts: Object.fromEntries(
        files.map(([, path]) => [path, fileHash(path)]),
      ),
      sources: sourceHashes([
        ...engineSourcePaths(),
        "scripts/bench-update-from.ts",
      ]),
    },
    null,
    2,
  ) + "\n",
);
console.table(
  results.map(({ rows, engine, medianMilliseconds }) => ({
    rows,
    engine,
    milliseconds: medianMilliseconds.toFixed(2),
  })),
);
