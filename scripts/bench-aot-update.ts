import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { cpus } from "node:os";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { build } from "vite";
import * as compiler from "../_build/js/release/build/mizchi/sqlike/compiler/compiler.js";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "../tests/compatibility/native-values.ts";
import { aotBindings } from "../src/aot-values.ts";
import { engineSourcePaths, fileHash, sourceHashes } from "./measurement-manifest.ts";
import { buildSqlikeRuntime } from "./build-sqlike-runtime.ts";
import { defineSqlike, primaryKeyIndex } from "../src/sqlike-features.ts";
import type { UpdateEngine, UpdateFixture, installUpdates } from "./aot-update-workload.ts";
import type { Value } from "../src/contract.ts";

const args = process.argv.slice(2);
for (const arg of args) assert.match(arg, /^--(before-dir|output)=.+$/);
const option = (name: string) =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const schema = [
  "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER,plain INTEGER CHECK(plain>=0),body TEXT)",
  "CREATE INDEX ix_t_n ON t(n)",
  "CREATE TABLE cold(id INTEGER PRIMARY KEY,n INTEGER)",
];
const sql = {
  seed: `INSERT INTO t VALUES${Array(100).fill("(?,?,?,?)").join(",")}`,
  point: "SELECT id,n,plain,body FROM t WHERE id=?",
  pointMiss: "SELECT id,n,plain,body FROM t WHERE id=?",
  steady: "UPDATE t SET n=? WHERE id=?",
  indexed: "UPDATE t SET n=? WHERE id=?",
  plain: "UPDATE t SET plain=? WHERE id=?",
  returning: "UPDATE t SET plain=plain+1 WHERE id=? RETURNING id,plain,body",
  miss: "UPDATE t SET plain=? WHERE id=?",
  reject: "UPDATE t SET plain=? WHERE id=?",
  scan: "SELECT id,n,plain,body FROM t ORDER BY id",
  range: "SELECT id FROM t WHERE n>=0 AND n<30 ORDER BY n",
};
const catalog = { schema, queries: Object.entries(sql).map(([name, sql]) => ({ name, sql })) };
const artifact = compiler.compile_program(JSON.stringify(catalog));
assert.equal(JSON.parse(artifact).error, undefined);
const packed = compiler.pack_program_binary(artifact);
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const selected = [];
for (const mode of ["aot", "defined"] as const) {
  const built = await buildSqlikeRuntime(defineSqlike({ mode, features: [primaryKeyIndex] }), {
    catalog,
    outDir: `generated/aot-update-bench/${mode}`,
  });
  selected.push({ mode, directory: built.directory, requirements: built.requirements });
}
const artifacts = [
  ...[false, true].flatMap((defined) =>
    [false, true].map((wasm) => ({
      name: `after/${defined ? "defined" : "aot"}/${wasm ? "wasm" : "js"}`,
      defined,
      wasm,
      path: `_build/${wasm ? "wasm-gc" : "js"}/release/build/mizchi/${defined ? "sqlike/defined/defined" : "litestream-example/runtime/runtime"}.${wasm ? "wasm" : "js"}`,
    })),
  ),
  ...selected.flatMap(({ mode, directory }) =>
    [false, true].map((wasm) => ({
      name: `after/selected-${mode}/${wasm ? "wasm" : "js"}`,
      defined: mode === "defined",
      wasm,
      path: join(directory, `runtime.${wasm ? "wasm" : "js"}`),
    })),
  ),
  ...(option("before-dir")
    ? [false, true].flatMap((defined) =>
        [false, true].map((wasm) => ({
          name: `before/${defined ? "defined" : "aot"}/${wasm ? "wasm" : "js"}`,
          defined,
          wasm,
          path: join(
            option("before-dir")!,
            `${defined ? "defined" : "runtime"}.${wasm ? "wasm" : "js"}`,
          ),
        })),
      )
    : []),
].map((a, index) => ({ ...a, url: `/engine${index}`, bytes: readFileSync(a.path) }));
const built = await build({
  configFile: false,
  publicDir: false,
  logLevel: "silent",
  build: {
    write: false,
    minify: false,
    target: "esnext",
    lib: { entry: resolve("scripts/aot-update-workload.ts"), formats: ["es"] },
  },
});
const bundle = Array.isArray(built) ? built[0] : built;
assert.ok(bundle && "output" in bundle);
const chunks = bundle.output.filter((c) => c.type === "chunk");
assert.equal(chunks.length, 1);
const server = createServer((req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.url === "/") {
    res.setHeader("Content-Type", "text/html");
    res.end("<!doctype html>");
    return;
  }
  if (req.url === "/runner.js") {
    res.setHeader("Content-Type", "text/javascript");
    res.end(chunks[0]!.code);
    return;
  }
  const a = artifacts.find((a) => a.url === req.url);
  res.setHeader("Content-Type", a?.wasm ? "application/wasm" : "text/javascript");
  res.statusCode = a ? 200 : 404;
  res.end(a?.bytes);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch(),
  results = [];
const median = (values: number[]) =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!;
try {
  for (const rows of [100, 1000, 5000]) {
    const midpoint = Math.floor(rows / 2),
      seeds: string[] = [];
    for (let start = 0; start < rows; start += 100) {
      const params: Value[] = [];
      for (let i = start; i < start + 100; i++)
        params.push(BigInt(i + 1), BigInt(i * 3), BigInt(i), "note");
      seeds.push(aotBindings(params));
    }
    const bindings: Record<string, Value[][]> = {
      point: [[1n]],
      pointMiss: [[BigInt(rows + 1)]],
      steady: [[-7n, BigInt(midpoint)]],
      indexed: [
        [-8n, BigInt(midpoint + 1)],
        [BigInt(rows * 3 + 7), BigInt(midpoint + 1)],
      ],
      plain: [
        [1n, BigInt(midpoint + 2)],
        [2n, BigInt(midpoint + 2)],
      ],
      returning: [[BigInt(midpoint + 3)]],
      miss: [[1n, BigInt(rows + 1)]],
      reject: [[-1n, BigInt(midpoint + 4)]],
    };
    const fixture: UpdateFixture = {
      artifact,
      seeds,
      schema: Array.from(compiler.binary_catalog_schema(packed)),
      statements: Array.from(compiler.binary_catalog_statements(packed)),
      operations: Object.entries(bindings).map(([name, params]) => ({
        name,
        bindings: params.map(aotBindings),
        rejects: name === "reject",
      })),
    };
    const page = await browser.newPage();
    try {
      await page.goto(origin);
      await page.evaluate(
        async ({ fixture, engines }) => {
          const runner = await import(`${location.origin}/runner.js`);
          (window as unknown as { updates: Awaited<ReturnType<typeof installUpdates>> }).updates =
            await runner.installUpdates(fixture, engines);
        },
        {
          fixture,
          engines: artifacts.map(({ name, url, wasm, defined }): UpdateEngine => ({
            name,
            url,
            wasm,
            defined,
          })),
        },
      );
      const run = (engine: string, name: string, iterations: number) =>
        page.evaluate(
          ({ engine, name, iterations }) =>
            (
              window as unknown as { updates: Awaited<ReturnType<typeof installUpdates>> }
            ).updates.run(engine, name, iterations),
          { engine, name, iterations },
        );
      const verify = async () => {
        const states = await page.evaluate(() =>
          (
            window as unknown as { updates: Awaited<ReturnType<typeof installUpdates>> }
          ).updates.verify(),
        );
        for (const state of states) {
          const db = new NodeDatabase(":memory:");
          try {
            schema.forEach((s) => db.run(s));
            for (let start = 0; start < rows; start += 100) {
              const params: Value[] = [];
              for (let i = start; i < start + 100; i++)
                params.push(BigInt(i + 1), BigInt(i * 3), BigInt(i), "note");
              db.run(sql.seed, params);
            }
            for (const operation of state.operations) {
              if (!operation.calls) continue;
              if (operation.name === "returning")
                db.run("UPDATE t SET plain=plain+? WHERE id=?", [
                  BigInt(operation.calls),
                  BigInt(midpoint + 3),
                ]);
              else if (operation.name !== "reject")
                db.run(
                  sql[operation.name as keyof typeof sql],
                  bindings[operation.name]![operation.last]!,
                );
              if (
                operation.name === "point" ||
                operation.name === "pointMiss" ||
                operation.name === "returning"
              ) {
                const expected =
                  operation.name === "returning"
                    ? nativeValues(db, "SELECT id,plain,body FROM t WHERE id=?", [
                        BigInt(midpoint + 3),
                      ])
                    : nativeValues(
                        db,
                        sql[operation.name],
                        bindings[operation.name]![operation.last]!,
                      );
                assert.deepEqual(
                  operation.lastRows,
                  expected.map((row) => JSON.parse(aotBindings(row))),
                  `${state.engine}/${operation.name}`,
                );
              }
            }
            assert.deepEqual(
              state.rows,
              nativeValues(db, sql.scan).map((row) => JSON.parse(aotBindings(row))),
              state.engine,
            );
          } finally {
            db.close();
          }
        }
      };
      await verify();
      const names = Object.keys(bindings),
        iterations: Record<string, number> = {},
        samples: {
          sample: number;
          engine: string;
          name: string;
          iterations: number;
          milliseconds: number;
        }[] = [];
      for (const a of artifacts)
        for (const name of names) {
          await run(a.name, name, 200);
          let count = 100;
          for (let round = 0; round < 2; round++) {
            const ms = await run(a.name, name, count);
            count = Math.max(10, Math.min(100000, Math.ceil((count * 20) / Math.max(ms, 0.01))));
          }
          iterations[`${a.name}:${name}`] = count;
        }
      // Rotate engine order on every sample; each operation uses its own row.
      for (let sample = 0; sample < 7; sample++)
        for (let offset = 0; offset < artifacts.length; offset++) {
          const engine = artifacts[(sample + offset) % artifacts.length]!.name;
          for (let j = 0; j < names.length; j++) {
            const name = names[(sample + j) % names.length]!,
              count = iterations[`${engine}:${name}`]!;
            samples.push({
              sample,
              engine,
              name,
              iterations: count,
              milliseconds: await run(engine, name, count),
            });
          }
        }
      await verify();
      const medians = artifacts.flatMap((a) =>
        names.map((name) => {
          const times = samples
            .filter((s) => s.engine === a.name && s.name === name)
            .map((s) => (s.milliseconds * 1000) / s.iterations);
          return {
            engine: a.name,
            name,
            microseconds: median(times),
            minUs: Math.min(...times),
            maxUs: Math.max(...times),
          };
        }),
      );
      console.log(rows);
      console.table(medians);
      results.push({ rows, verified: true, samples, medians });
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
const output = option("output") ?? "measurements/aot-update-current.json";
writeFileSync(
  output,
  JSON.stringify(
    {
      format: 1,
      measuredAt: new Date().toISOString(),
      programSHA256: hash(artifact),
      schemaSHA256: hash(compiler.binary_catalog_schema(packed)),
      statementsSHA256: hash(compiler.binary_catalog_statements(packed)),
      runnerSHA256: hash(chunks[0]!.code),
      method:
        "Same Chromium page, JSON and binary AOT, JS and Wasm. Rotated engine/operation order, 200 warmups then two calibration rounds targeting 20ms/sample, 7 samples. Pre-encoded binds, response JSON.parse and failure checks included. SELECT PK lookup/miss and UPDATE use separate rows; every non-noop mutation changes a value. Scan typed cells and final timed SELECT/RETURNING results checked against native SQLite before and after timing; rejected writes leave the entire table unchanged. Initial PK/secondary-index reads precede timing; derived caches may be replaced by rejected writes in this mixed workload. No storage, RPC, load/compile costs or forced GC. Before artifacts are supplied explicitly and hashed; this is an optimization comparison, not a SQLite speed comparison.",
      environment: {
        node: process.version,
        chromium: browser.version(),
        cpu: cpus()[0]?.model,
        nativeSQLite: process.versions.sqlite,
      },
      sourceHashes: sourceHashes([
        "scripts/bench-aot-update.ts",
        "scripts/aot-update-workload.ts",
        "tests/aot-update.test.ts",
        "tests/aot-update-workload.test.ts",
        "src/aot-values.ts",
        "adapters/defined-wasm.ts",
        "scripts/build-sqlike-runtime.ts",
        "src/runtime-capabilities.json",
        ...engineSourcePaths(),
      ]),
      artifacts: artifacts.map(({ bytes, ...a }) => ({
        ...a,
        bytes: bytes.length,
        sha256: fileHash(a.path),
      })),
      selected: selected.map(({ mode, requirements }) => ({ mode, requirements })),
      results,
    },
    null,
    2,
  ) + "\n",
);
console.log(`Saved ${output}`);
