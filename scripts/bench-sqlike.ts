import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { cpus, platform, arch } from "node:os";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import * as runtime from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import { MoonDatabase } from "../adapters/moon-database.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { buildCatalog } from "./aot-compiler.ts";
import { aotBindings, aotValue } from "../src/aot-values.ts";
import { nativeValues } from "../tests/compatibility/native-values.ts";
import type { Cell } from "../src/contract.ts";
const options = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    if (!/^--(output|compare)=/.test(arg)) throw Error(`unknown option ${arg}`);
    return arg.slice(2).split(/=(.*)/s).slice(0, 2);
  }),
);
const workload = {
  schema: "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER,title TEXT)",
  rows: 100,
  warmup: 1000,
  runs: 7,
  queries: [
    { name: "add", sql: "INSERT INTO t VALUES(?,?,?)" },
    { name: "constant", sql: "SELECT ?+1 AS n,upper(?) AS t" },
    { name: "point", sql: "SELECT id,n,title FROM t WHERE id=?" },
  ],
  iterations: { constant: 10000, point: 2000 },
};
const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const environment = {
  node: process.version,
  cpu: cpus()[0]?.model,
  platform: platform(),
  arch: arch(),
  moon: execFileSync("moon", ["version"], { encoding: "utf8" }).split("\n")[0],
};
const built = buildCatalog({
    schema: [workload.schema],
    queries: workload.queries,
  }),
  aot = runtime.aot_open(built.artifact, ""),
  dynamic = new MoonDatabase(),
  native = new NodeDatabase(":memory:");
dynamic.run(workload.schema);
native.run(workload.schema);
for (let i = 0; i < workload.rows; i++) {
  const params = [BigInt(i + 1), BigInt(i), `note${i}`];
  dynamic.run(workload.queries[0]!.sql, params);
  native.run(workload.queries[0]!.sql, params);
  const result = JSON.parse(
    runtime.aot_execute(aot, "add", aotBindings(params)),
  );
  assert.equal(result.error, undefined);
}
const samples: {
  name: string;
  engine: string;
  run: number;
  milliseconds: number;
}[] = [];
try {
  for (const name of ["constant", "point"] as const) {
    const sql = workload.queries.find((q) => q.name === name)!.sql,
      params = name === "constant" ? [2n, "hello"] : [50n],
      bindings = aotBindings(params);
    const expected = nativeValues(native, sql, params),
      actions = {
        aot: () => {
          const result = JSON.parse(runtime.aot_execute(aot, name, bindings));
          if (result.error) throw Error(result.error);
          return result.rows as Cell[][];
        },
        dynamic: () => dynamic.queryValues(sql, params),
      };
    assert.deepEqual(
      actions.aot().map((row) => row.map(aotValue)),
      expected,
    );
    assert.deepEqual(actions.dynamic(), expected);
    for (const action of Object.values(actions))
      for (let i = 0; i < workload.warmup; i++) action();
    for (let run = 0; run < workload.runs; run++)
      for (const engine of (run % 2
        ? ["dynamic", "aot"]
        : ["aot", "dynamic"]) as ("aot" | "dynamic")[]) {
        let rows = 0;
        const start = performance.now();
        for (let i = 0; i < workload.iterations[name]; i++)
          rows += actions[engine]().length;
        const milliseconds = performance.now() - start;
        assert.equal(rows, workload.iterations[name]);
        samples.push({ name, engine, run, milliseconds });
      }
  }
} finally {
  native.close();
}
const median = (values: number[]) =>
  values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const medians = ["constant", "point"].flatMap((name) =>
  ["aot", "dynamic"].map((engine) => ({
    name,
    engine,
    milliseconds: median(
      samples
        .filter((s) => s.name === name && s.engine === engine)
        .map((s) => s.milliseconds),
    ),
  })),
);
const report = {
  format: 1,
  measuredAt: new Date().toISOString(),
  environment,
  workload,
  workloadSHA256: hash(JSON.stringify(workload)),
  artifacts: {
    sqlike: hash(
      readFileSync("_build/js/release/build/mizchi/sqlike/full/full.js"),
    ),
    runtime: hash(
      readFileSync(
        "_build/js/release/build/mizchi/litestream-example/runtime/runtime.js",
      ),
    ),
  },
  method:
    "Node JS backend, no storage/RPC; same typed SQLite oracle checked before measurement; alternating engine order; medians of 7 after 1000 warmups. AOT includes result JSON decoding; dynamic includes SQL parse and positional result decoding.",
  samples,
  medians,
};
writeFileSync(
  options.output ?? "measurements/sqlike-current.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(medians, null, 2));
if (options.compare) {
  const baseline = JSON.parse(
    readFileSync(options.compare, "utf8"),
  ) as typeof report;
  assert.deepEqual(
    environment,
    baseline.environment,
    "benchmark environment differs; record a matching baseline",
  );
  assert.equal(
    report.workloadSHA256,
    baseline.workloadSHA256,
    "benchmark workload differs",
  );
  for (const current of medians) {
    const previous = baseline.medians.find(
      (m) => m.name === current.name && m.engine === current.engine,
    );
    assert.ok(previous);
    const ratio = current.milliseconds / previous.milliseconds;
    console.log(
      `${current.name}/${current.engine}: ${ratio.toFixed(3)}x baseline`,
    );
    assert.ok(
      ratio <= 1.3,
      `performance regression: ${current.name}/${current.engine} ${ratio.toFixed(3)}x > 1.30x`,
    );
  }
}
