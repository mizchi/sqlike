import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { cpus } from "node:os";
import { Session } from "node:inspector";
import { NodeDatabase } from "../adapters/node-database.ts";
import { aotBindings, aotValue } from "../src/aot-values.ts";
import type { Value } from "../src/contract.ts";
import { nativeValues } from "../tests/compatibility/native-values.ts";
import { engineSourcePaths, sourceHashes, fileHash } from "./measurement-manifest.ts";
import { summarizeProfile } from "./profile-summary.ts";

const args = process.argv.slice(2);
for (const arg of args) assert.match(arg, /^(--smoke|--profile|--before-dir=.+|--output=.+)$/);
const smoke = args.includes("--smoke"), profiles = args.includes("--profile");
const beforeDir = args.find(a => a.startsWith("--before-dir="))?.slice(13);
const files = [
  ...(beforeDir ? [["before/js", `${beforeDir}/sqlike.js`], ["before/wasm", `${beforeDir}/sqlike.wasm`]] as const : []),
  ["after/js", "_build/js/release/build/mizchi/sqlike/full/full.js"],
  ["after/wasm", "_build/wasm-gc/release/build/mizchi/sqlike/full/full.wasm"],
] as const;
interface Connection {
  run(sql: string, params?: Value[], encoded?: string): void;
  values(sql: string): Value[][];
  close(): void;
}
const schema = "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER NOT NULL CHECK(n>=0))";
const pointRead = "SELECT id,n FROM t ORDER BY id LIMIT 10";
const fullRead = "SELECT id,n FROM t ORDER BY id";
const makeNative = (rows: number): Connection & { db: NodeDatabase } => {
  const db = new NodeDatabase(":memory:"), plans = new Map<string, any>();
  db.run(schema);
  db.transaction(() => {
    const insert = db.raw.prepare("INSERT INTO t VALUES(?,?)");
    for (let i = 1; i <= rows; i++) insert.run(i, i);
  });
  return {
    db,
    run(sql, params = []) {
      let plan = plans.get(sql);
      if (!plan) { plan = db.raw.prepare(sql); plans.set(sql, plan); }
      plan.run(...params);
    },
    values: sql => nativeValues(db, sql), close: () => db.close(),
  };
};
const runtimes = await Promise.all(files.map(async ([name, path]) => ({ name,
  api: path.endsWith(".wasm")
    ? (await WebAssembly.instantiate(readFileSync(path), {},
      { builtins: ["js-string"], importedStringConstants: "_" })).instance.exports as any
    : await import(pathToFileURL(resolve(path)).href),
})));
const runs = smoke ? 1 : 3, budgetMilliseconds = 3000;
const rowsList = smoke ? [100] : [1000, 10000, 100000];
const results: any[] = [], fixtures: any[] = [], profileReports: any[] = [];
for (const rows of rowsList) {
  const seed = makeNative(rows), image = Buffer.from(seed.db.raw.serialize()).toString("base64"); seed.close();
  fixtures.push({ rows, base64Bytes: image.length });
  const engines: { name: string; open(): Connection }[] = runtimes.map(({ name, api }) => ({ name, open(): Connection {
    const handle = api.database_open(), plans = new Map();
    const checked = (text: string) => { const r = JSON.parse(text); if (r.error) throw Error(r.error); return r; };
    checked(api.database_import_sqlite_base64(handle, image));
    return {
      run(sql, params = [], encoded = aotBindings(params)) {
        let plan = plans.get(sql);
        if (!plan) { plan = api.database_prepare(handle, sql); plans.set(sql, plan); }
        checked(api.database_prepared_exec(plan, encoded, false, false));
      },
      values: sql => checked(api.database_query_values(handle, sql, "[]")).rows.map((row: any[]) => row.map(aotValue)),
      close: () => plans.clear(),
    };
  } }));
  engines.push({ name: "sqlite/prepared", open: () => makeNative(rows) });
  const deletions = Array.from({ length: Math.min(1000, rows / 2) }, (_, i) => {
    const params = [BigInt(i * 2 + 2)]; return { params, encoded: aotBindings(params) };
  });
  for (const mode of ["cold", "warm", "delete-read"]) for (let run = 0; run < runs; run++) {
    const order = engines.map((_, i) => engines[(i + run) % engines.length]!);
    if (run % 2) order.reverse();
    for (const engine of order) {
      const db = engine.open(), oracle = makeNative(rows);
      try {
        // A miss warms the statement without creating a row-order cache.
        db.run("DELETE FROM t WHERE id=?", [0n]);
        oracle.run("DELETE FROM t WHERE id=?", [0n]);
        if (mode !== "cold") assert.deepEqual(db.values(pointRead), oracle.values(pointRead));
        let deleted = 0;
        const start = performance.now();
        for (const { params, encoded } of deletions) {
          if (performance.now() - start >= budgetMilliseconds) break;
          db.run("DELETE FROM t WHERE id=?", params, encoded); deleted++;
          if (mode === "delete-read") db.values(pointRead);
        }
        const milliseconds = performance.now() - start;
        for (let i = 0; i < deleted; i++) oracle.run("DELETE FROM t WHERE id=?", deletions[i]!.params);
        const scanStart = performance.now(), actual = db.values(fullRead);
        const scanMilliseconds = performance.now() - scanStart;
        assert.deepEqual(actual, oracle.values(fullRead));
        assert.deepEqual(db.values("SELECT changes()"), oracle.values("SELECT changes()"));
        results.push({ rows, mode, run, engine: engine.name, deleted, milliseconds, scanMilliseconds,
          status: deleted === deletions.length ? "complete" : "budget-exceeded", verified: true });
      } finally { db.close(); oracle.close(); }
    }
  }
  // CPU samples are collected separately: profiler overhead never enters timings.
  if (profiles && !smoke && rows === 100000) for (const engine of engines.filter(e => e.name.endsWith("/js"))) {
    const db = engine.open(), session = new Session(); session.connect();
    const post = (method: string) => new Promise<any>((resolve, reject) =>
      session.post(method as any, (err, value) => err ? reject(err) : resolve(value)));
    try {
      db.run("DELETE FROM t WHERE id=?", [0n]); db.values(pointRead);
      const profileDeletes = Array.from({ length: 10000 }, (_, i) => {
        const params = [BigInt(i * 2 + 2)]; return { params, encoded: aotBindings(params) };
      });
      await post("Profiler.enable"); await post("Profiler.start");
      for (const { params, encoded } of profileDeletes) db.run("DELETE FROM t WHERE id=?", params, encoded);
      const { profile } = await post("Profiler.stop");
      mkdirSync("measurements/profiles/delete", { recursive: true });
      const path = `measurements/profiles/delete/${engine.name.replace("/", "-")}.cpuprofile`;
      writeFileSync(path, JSON.stringify(profile));
      profileReports.push({ engine: engine.name, deletions: profileDeletes.length, path, sha256: fileHash(path), summary: summarizeProfile(profile) });
    } finally { db.close(); session.disconnect(); }
  }
  console.log(`DELETE: ${rows} rows, cold / warm / alternating read verified`);
}
const median = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!;
const medians = rowsList.flatMap(rows => ["cold", "warm", "delete-read"].flatMap(mode =>
  [...runtimes.map(r => r.name), "sqlite/prepared"].map(engine => {
    const samples = results.filter(r => r.rows === rows && r.mode === mode && r.engine === engine);
    return { rows, mode, engine, complete: samples.every(r => r.status === "complete"),
      microseconds: median(samples.map(r => r.milliseconds * 1000 / r.deleted)),
      scanMilliseconds: median(samples.map(r => r.scanMilliseconds)) };
  })));
const output = args.find(a => a.startsWith("--output="))?.slice(9) ??
  (smoke ? "/tmp/sqlike-delete-smoke.json" : "measurements/delete-current.json");
writeFileSync(output, JSON.stringify({ measuredAt: new Date().toISOString(), node: process.version,
  sqlite: process.versions.sqlite, cpu: cpus()[0]?.model, smoke, runs, budgetMilliseconds,
  method: "Node memory DBs; native SQLite image import outside timings. Cold: no ordered cache before deletion. Warm: ordered LIMIT 10 read once. Delete-read: ordered LIMIT 10 after each delete. DELETE is prepared on all engines and warmed with a miss; read queries use uncached SQL APIs, including parse/JSON/type conversion. Up to 1000 even-rowid deletions per sample; three rotated samples, checked between calls for a 3s budget. A full ordered scan, native typed-row comparison and changes() check follow each sample; scans include first cache build when cold. No disk/IDB/Chromium or identical-ABI claim. CPU profiles use 10000 deletes in separate diagnostic runs, including profiler dispatch overhead, and are not used as benchmark timings.",
  sourceHashes: sourceHashes([...engineSourcePaths(), "scripts/bench-delete.ts", "scripts/profile-summary.ts", "src/aot-values.ts"]),
  artifacts: Object.fromEntries(files.map(([, path]) => [path, fileHash(path)])), fixtures, results, medians, profiles: profileReports,
}, null, 2) + "\n");
console.log(JSON.stringify({ output, medians: medians.filter(r => r.rows === rowsList.at(-1)) }, null, 2));
