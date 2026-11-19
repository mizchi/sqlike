import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
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

const args = process.argv.slice(2);
for (const arg of args)
  assert.match(
    arg,
    /^(--before-dir=.+|--current-dir=.+|--comparison=row-metadata|--output=.+)$/,
  );
const before = args.find((a) => a.startsWith("--before-dir="))?.slice(13);
const current = args.find((a) => a.startsWith("--current-dir="))?.slice(14);
const metadata = args.includes("--comparison=row-metadata");
const output =
  args.find((a) => a.startsWith("--output="))?.slice(9) ??
  "measurements/row-values-cursor-current.json";
const schema =
  "CREATE TABLE t(id INTEGER PRIMARY KEY,tenant TEXT,created TEXT,seq INTEGER)";
const indexes = [
  "CREATE INDEX cursor_ix ON t(tenant,created,id)",
  "CREATE INDEX seq_ix ON t(tenant,created,seq)",
];
const queries = ["id", "seq"].map((field) => ({
  variant: field === "id" ? "rowid-alias" : "ordinary-column",
  sql: `SELECT id FROM t WHERE tenant=? AND (created,${field})>(?,?) ORDER BY created,${field} LIMIT 20`,
}));
const files = [
  ...(before
    ? [
        [
          `${metadata ? "metadata-off" : "leading"}/js`,
          join(before, "sqlike.js"),
        ],
        [
          `${metadata ? "metadata-off" : "leading"}/wasm`,
          join(before, "sqlike.wasm"),
        ],
      ]
    : []),
  [
    `${metadata ? "metadata-on" : "tuple"}/js`,
    current
      ? join(current, "sqlike.js")
      : "_build/js/release/build/mizchi/sqlike/full/full.js",
  ],
  [
    `${metadata ? "metadata-on" : "tuple"}/wasm`,
    current
      ? join(current, "sqlike.wasm")
      : "_build/wasm-gc/release/build/mizchi/sqlike/full/full.wasm",
  ],
];
const runtimes = [];
for (const [name, path] of files) {
  assert.ok(name && path);
  const api = path.endsWith(".wasm")
    ? (
        await WebAssembly.instantiate(
          readFileSync(path),
          {},
          { builtins: ["js-string"], importedStringConstants: "_" },
        )
      ).instance.exports
    : await import(pathToFileURL(resolve(path)).href);
  runtimes.push({ name, path, api });
}
function checked(text: string) {
  const r = JSON.parse(text);
  if (r.error) throw Error(r.error);
  return r;
}
function measure(run: () => Value[][], expected: Value[][]) {
  for (let i = 0; i < 3; i++) assert.deepEqual(run(), expected);
  const samples = [];
  for (let sample = 0; sample < 3; sample++) {
    let iterations = 0,
      last: Value[][] = [];
    const start = performance.now();
    do {
      last = run();
      iterations++;
    } while (performance.now() - start < 20 && iterations < 1000);
    const elapsedMs = performance.now() - start;
    assert.deepEqual(last, expected);
    samples.push({
      iterations,
      elapsedMs,
      microseconds: (elapsedMs * 1000) / iterations,
    });
  }
  return {
    medianMicroseconds: [...samples]
      .map((s) => s.microseconds)
      .sort((a, b) => a - b)[1]!,
    samples,
  };
}
const results = [],
  fixtures = [];
for (const rows of [5000, 100000]) {
  const native = new NodeDatabase(":memory:");
  native.raw.exec(schema);
  indexes.forEach((sql) => native.raw.exec(sql));
  native.transaction(() => {
    const insert = native.raw.prepare(
      "INSERT INTO t VALUES(?,'a','2026-11-18',?)",
    );
    for (let i = 1; i <= rows; i++) insert.run(i, i);
  });
  const params: Value[] = ["a", "2026-11-18", BigInt(rows - 40)];
  const encoded = aotBindings(params);
  const bytes = native.raw.serialize(),
    image = Buffer.from(bytes).toString("base64");
  fixtures.push({
    rows,
    cursor: rows - 40,
    sqliteImageSHA256: createHash("sha256").update(bytes).digest("hex"),
  });
  for (const { variant, sql: query } of queries) {
    const stmt = native.raw.prepare(query);
    stmt.setReadBigInts(true);
    stmt.setReturnArrays(true);
    const expected = stmt.all(...params) as unknown as Value[][];
    assert.equal(expected.length, 20);
    const plan = native.raw
      .prepare("EXPLAIN QUERY PLAN " + query)
      .all(...params)
      .map((row) => String(row.detail));
    results.push({
      rows,
      variant,
      engine: "sqlite/prepared",
      plan,
      ...measure(() => stmt.all(...params) as unknown as Value[][], expected),
    });
    for (const { name, api } of runtimes) {
      const db = api.database_open();
      checked(api.database_import_sqlite_base64(db, image));
      const plan = api.database_prepare(db, query);
      const run = () =>
        checked(
          api.database_prepared_exec(plan, encoded, false, true),
        ).rows.map((row: any[]) => row.map(aotValue));
      results.push({ rows, variant, engine: name, ...measure(run, expected) });
      (globalThis as { gc?: () => void }).gc?.();
    }
  }
  native.close();
}
writeFileSync(
  output,
  JSON.stringify(
    {
      format: "sqlike-row-cursor@1",
      measuredAt: new Date().toISOString(),
      node: process.version,
      cpu: cpus()[0]?.model,
      scope:
        "Node in-memory prepared SQL; identical tenant/date on every row; 20 rows near the end; rowid alias and ordinary integer cursor; setup/index warmup excluded; three samples targeting 20 ms, maximum 1000 iterations",
      baseline: metadata
        ? "Same source/profile/exports and all other optimizer flags; only rowMetadata differs. Not a released version comparison."
        : "Optional frozen row-values runtime with leading-key narrowing before complete-tuple seek; not a released SQLite/SQLike version",
      schema: [schema, ...indexes],
      queries,
      fixtures,
      results,
      artifacts: Object.fromEntries(
        files.map(([, path]) => [path!, fileHash(path!)]),
      ),
      sources: sourceHashes([
        ...engineSourcePaths(),
        "scripts/bench-row-values.ts",
      ]),
    },
    null,
    2,
  ) + "\n",
);
console.table(
  results.map(({ rows, variant, engine, medianMicroseconds }) => ({
    rows,
    variant,
    engine,
    microseconds: medianMicroseconds.toFixed(2),
  })),
);
