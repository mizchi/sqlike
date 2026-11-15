import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { sourceHashes } from "./measurement-manifest.ts";
const dir = mkdtempSync(join(tmpdir(), "sqlike-do-bench-")),
  url = "http://127.0.0.1:19880";
const child = spawn(
  "pnpm",
  [
    "exec",
    "wrangler",
    "dev",
    "--config",
    "scripts/fixtures/wrangler-bench.jsonc",
    "--port",
    "19880",
    "--inspector-port",
    "0",
    "--persist-to",
    dir,
  ],
  {
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  },
);
let output = "";
child.stdout.on("data", (d) => (output += d));
child.stderr.on("data", (d) => (output += d));
const invoke = async (engine: string, query: string, iterations: number) => {
  const r = await fetch(url, {
    method: "POST",
    body: JSON.stringify({ engine, query, iterations }),
  });
  assert.equal(r.status, 200, await r.clone().text());
  return (await r.json()) as {
    milliseconds: number;
    calls: number;
    rows: unknown;
  };
};
try {
  const deadline = Date.now() + 30000;
  while (true) {
    try {
      await invoke("raw", "point", 1);
      break;
    } catch (e) {
      if (child.exitCode !== null || Date.now() > deadline)
        throw Error(`DO benchmark startup failed: ${output}\n${String(e)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const samples: {
    engine: string;
    query: string;
    run: number;
    iterations: number;
    milliseconds: number;
    calls: number;
    rows: unknown;
  }[] = [];
  for (const query of ["point", "real", "update", "cte", "returning"]) {
    for (const engine of ["raw", "typed"]) await invoke(engine, query, 50);
    for (let run = 0; run < 7; run++)
      for (const engine of run % 2 ? ["typed", "raw"] : ["raw", "typed"]) {
        const result = await invoke(engine, query, 10000);
        if (engine === "typed" && ["point", "cte", "returning"].includes(query))
          assert.deepEqual(result.rows, [
            { id: { t: "integer", v: "500" }, n: { t: "integer", v: "1500" } },
          ]);
        if (engine === "typed" && query === "real")
          assert.deepEqual(result.rows, [
            { v: { t: "real", v: 1.5 }, t: { t: "text", v: "real" } },
          ]);
        samples.push({ engine, query, run, iterations: 10000, ...result });
      }
  }
  const median = (a: number[]) =>
    a.toSorted((a, b) => a - b)[Math.floor(a.length / 2)]!;
  const summary = ["point", "real", "update", "cte", "returning"].flatMap(
    (query) =>
      ["raw", "typed"].map((engine) => {
        const ss = samples.filter(
          (s) => s.query === query && s.engine === engine,
        );
        return {
          query,
          engine,
          microseconds: median(
            ss.map((s) => (s.milliseconds / s.iterations) * 1000),
          ),
          callsPerOperation: median(ss.map((s) => s.calls / s.iterations)),
        };
      }),
  );
  const hash = (p: string) =>
    createHash("sha256").update(readFileSync(p)).digest("hex");
  writeFileSync(
    "measurements/do-speed-current.json",
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        node: process.version,
        wrangler: JSON.parse(
          readFileSync("node_modules/wrangler/package.json", "utf8"),
        ).version,
        sourceHashes: sourceHashes([
          "scripts/bench-do.ts",
          "scripts/fixtures/do-bench-worker.ts",
          "scripts/fixtures/wrangler-bench.jsonc",
          "adapters/do-database.ts",
          "adapters/do-bindings.ts",
          "adapters/do-statement.ts",
          "adapters/do-returning.ts",
          "src/protocol.ts",
        ]),
        method:
          "Local workerd SQLite DO, 1000 rows, sequential rotated raw/typed order, 7x10000 calls, 50 warmups. Millisecond-resolution clock; raw sample durations retained. Timing inside DO excludes HTTP and setup; typed includes transactionSync, structural CTE classification, metadata read, typeof/hex decoding and REAL binding checks. Raw API loses storage-class information and is a cost baseline, not a compatible replacement. Typed output verified for point/REAL/CTE/RETURNING; UPDATE and RETURNING set the same value repeatedly. No process memory measurement.",
        artifacts: Object.fromEntries(
          [
            "adapters/do-database.ts",
            "adapters/do-bindings.ts",
            "adapters/do-statement.ts",
            "adapters/do-returning.ts",
            "scripts/fixtures/do-bench-worker.ts",
            "scripts/bench-do.ts",
          ].map((p) => [p, hash(p)]),
        ),
        samples,
        summary,
      },
      null,
      2,
    ) + "\n",
  );
  console.table(summary);
} finally {
  if (child.pid)
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  await new Promise((r) => {
    if (child.exitCode !== null) return r(undefined);
    child.once("exit", r);
  });
  rmSync(dir, { recursive: true, force: true });
}
