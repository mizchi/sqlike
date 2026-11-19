import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { cpus } from "node:os";
import { NodeDatabase } from "../adapters/node-database.ts";
import { aotBindings, aotValue } from "../src/aot-values.ts";
import type { Value } from "../src/contract.ts";
import { nativeValues } from "../tests/compatibility/native-values.ts";
import { engineSourcePaths, sourceHashes, fileHash } from "./measurement-manifest.ts";

const args = process.argv.slice(2);
for (const arg of args) assert.match(arg, /^(--smoke|--before-dir=.+|--output=.+)$/);
const smoke = args.includes("--smoke");
const beforeDir = args.find(a => a.startsWith("--before-dir="))?.slice(13);
const rowsList = smoke ? [100] : [1000, 10000, 100000];
const runs = smoke ? 1 : 3, budgetMilliseconds = smoke ? 1000 : 3000;
const files = [
  ...(beforeDir ? [["before/js", `${beforeDir}/sqlike.js`], ["before/wasm", `${beforeDir}/sqlike.wasm`]] as const : []),
  ["after/js", "_build/js/release/build/mizchi/sqlike/full/full.js"],
  ["after/wasm", "_build/wasm-gc/release/build/mizchi/sqlike/full/full.wasm"],
] as const;
interface Connection {
  run(sql: string, values?: Value[], encoded?: string): void;
  values(sql: string): Value[][];
  close(): void;
}
const engines: { name: string; open(): Connection }[] = [];
for (const [name, path] of files) {
  const runtime = path.endsWith(".wasm")
    ? (await WebAssembly.instantiate(readFileSync(path), {},
      { builtins: ["js-string"], importedStringConstants: "_" })).instance.exports as any
    : await import(pathToFileURL(resolve(path)).href);
  engines.push({ name, open() {
    const db = runtime.database_open(), plans = new Map();
    const checked = (text: string) => { const r = JSON.parse(text); if (r.error) throw Error(r.error); return r; };
    return {
      run(sql, values = [], encoded = aotBindings(values)) {
        let plan = plans.get(sql);
        if (!plan) { plan = runtime.database_prepare(db, sql); plans.set(sql, plan); }
        checked(runtime.database_prepared_exec(plan, encoded, false, false));
      },
      values: sql => checked(runtime.database_query_values(db, sql, "[]")).rows.map((row: any[]) => row.map(aotValue)),
      close() { plans.clear(); },
    };
  } });
}
const sqlite = { name: "sqlite/prepared", open(): Connection {
  const db = new NodeDatabase(":memory:"), statements = new Map();
  return {
    run(sql, values = []) {
      let statement = statements.get(sql);
      if (!statement) { statement = db.raw.prepare(sql); statements.set(sql, statement); }
      statement.run(...values);
    },
    values: sql => nativeValues(db, sql), close: () => db.close(),
  };
} };
engines.push(sqlite);
const schema = "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER NOT NULL CHECK(n>=0))";
const observations = ["SELECT count(*),sum(n),min(id),max(id) FROM t", "SELECT changes(),last_insert_rowid()"];
const results = [];
for (const rows of rowsList) for (const mode of ["explicit", "automatic"]) {
  const sql = mode === "explicit"
    ? `INSERT INTO t(id,n) VALUES${Array(100).fill("(?,?)").join(",")}`
    : `INSERT INTO t(n) VALUES${Array(100).fill("(?)").join(",")}`;
  const batches = [];
  for (let start = 0; start < rows; start += 100) {
    const values: Value[] = [];
    for (let i = start; i < start + 100; i++) {
      if (mode === "explicit") values.push(BigInt(i + 1));
      values.push(BigInt(i));
    }
    batches.push({ values, encoded: aotBindings(values) });
  }
  for (let run = 0; run < runs; run++) {
    const order = engines.map((_, i) => engines[(i + run) % engines.length]!);
    if (run % 2) order.reverse();
    for (const engine of order) {
      const db = engine.open(), oracle = sqlite.open();
      try {
        db.run(schema); oracle.run(schema);
        let inserted = 0;
        const started = performance.now();
        for (const batch of batches) {
          if (performance.now() - started >= budgetMilliseconds) break;
          db.run(sql, batch.values, batch.encoded); inserted += 100;
        }
        const insertMilliseconds = performance.now() - started;
        for (const batch of batches.slice(0, inserted / 100)) oracle.run(sql, batch.values);
        for (const query of observations) assert.deepEqual(db.values(query), oracle.values(query));
        // Point deletes after a full ordered read expose costs of a warm rowid
        // order index. Partial INSERT samples never become full-size comparisons.
        let deleted = 0, deleteMilliseconds: number | null = null;
        if (inserted === rows) {
          db.values("SELECT id FROM t ORDER BY id LIMIT 1");
          const begin = performance.now();
          for (let i = 0; i < Math.min(1000, rows / 2); i++) {
            if (performance.now() - begin >= budgetMilliseconds) break;
            db.run("DELETE FROM t WHERE id=?", [BigInt(i * 2 + 2)]); deleted++;
          }
          deleteMilliseconds = performance.now() - begin;
          for (let i = 0; i < deleted; i++) oracle.run("DELETE FROM t WHERE id=?", [BigInt(i * 2 + 2)]);
          for (const query of observations) assert.deepEqual(db.values(query), oracle.values(query));
        }
        results.push({ rows, mode, engine: engine.name, run, inserted, insertMilliseconds,
          insertStatus: inserted === rows ? "complete" : "budget-exceeded", deleted, deleteMilliseconds, verified: true });
      } finally { db.close(); oracle.close(); }
    }
  }
  console.log(`bulk writes: ${rows} rows / ${mode} verified, including partial-budget samples`);
}
writeFileSync(args.find(a => a.startsWith("--output="))?.slice(9) ??
  (smoke ? "/tmp/sqlike-bulk-smoke.json" : "measurements/optimization-bulk-write.json"), JSON.stringify({
  measuredAt: new Date().toISOString(), node: process.version, sqlite: process.versions.sqlite, cpu: cpus()[0]?.model,
  smoke, runs, budgetMilliseconds, batchRows: 100,
  method: "Node JS/Wasm GC and native node:sqlite prepared calls; not a Chromium or disk benchmark. Fresh memory DB per sample. Three rotated samples, pre-encoded SQLike bindings; SQLite native BigInt bindings. Setup excluded, first preparation included. Explicit and automatic rowids, 100 rows per statement, atomic backup per batch. Each INSERT case stops between batches at a 3s budget, reporting the actual inserted prefix and native-verified state; partial samples are not full-size timings. Complete cases additionally point-delete up to 1000 even IDs after warming a rowid-order read; deletion is also bounded between calls. Count/sum/min/max, changes and last_insert_rowid are checked against an independently seeded native oracle after INSERT and DELETE. No claim about identical ABI cost or disk commit throughput.",
  sourceHashes: sourceHashes([...engineSourcePaths(), "scripts/bench-bulk-write.ts", "src/aot-values.ts"]),
  artifacts: Object.fromEntries(files.map(([, path]) => [path, fileHash(path)])), results,
}, null, 2) + "\n");
