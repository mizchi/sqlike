import { createHash } from "node:crypto";
import { test, expect } from "@playwright/test";
import { build } from "vite";
import { readFileSync, writeFileSync } from "node:fs";
import { differentialCorpus } from "../tests/compatibility/differential-corpus.ts";
import { oracleTraces } from "../tests/compatibility/differential-node.ts";
import type * as Runtime from "./fixtures/differential-runtime.ts";
// Completion is tested here; check-sqlike-differential.ts is the strict gate.
test("audits typed behavior and failed-write state against real SQLite WASM in Chromium", async ({
  page,
  browser,
}) => {
  const cases = differentialCorpus(),
    oracle = oracleTraces(cases);
  let code = "";
  const outputs = await build({
    configFile: false,
    publicDir: false,
    logLevel: "error",
    build: {
      write: false,
      minify: true,
      target: "esnext",
      lib: { entry: "e2e/fixtures/differential-runtime.ts", formats: ["es"] },
    },
  });
  for (const b of Array.isArray(outputs) ? outputs : [outputs])
    if ("output" in b)
      for (const chunk of b.output)
        if (chunk.type === "chunk") code += chunk.code;
  await page.route("**/sqlike-differential", (r) =>
    r.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.route("**/sqlike-differential.js", (r) =>
    r.fulfill({ contentType: "text/javascript", body: code }),
  );
  for (const [url, path] of [
    ["sqlite3.wasm", "node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm"],
    [
      "sqlike-diff.wasm",
      "_build/wasm-gc/release/build/mizchi/sqlike/sqlike.wasm",
    ],
    [
      "aot-diff.wasm",
      "_build/wasm-gc/release/build/mizchi/litestream-example/runtime/runtime.wasm",
    ],
  ])
    await page.route("**/" + url, (r) =>
      r.fulfill({ contentType: "application/wasm", body: readFileSync(path!) }),
    );
  await page.goto("/sqlike-differential");
  const result = await page.evaluate(
    async ({ cases, nodeOracle, nodeCompileErrors }) => {
      const path = "/sqlike-differential.js",
        m = (await import(path)) as typeof Runtime;
      const sqlite = await m.sqlite3InitModule();
      const traces: typeof nodeOracle = {};
      for (const c of cases) {
        const db = m.sqliteWasmOracle(sqlite);
        try {
          traces[c.id] = m.runTrace(c, db);
        } finally {
          db.close();
        }
      }
      const oracleDrift = cases.flatMap((c) =>
        m
          .compareTraces(nodeOracle[c.id]!, traces[c.id]!)
          .map((d) => ({ id: c.id, ...d })),
      );
      const instantiate = async (path: string) => {
        const { module, instance } = await WebAssembly.instantiate(
          await (await fetch(path)).arrayBuffer(),
          {},
          { builtins: ["js-string"], importedStringConstants: "_" },
        );
        if (WebAssembly.Module.imports(module).length)
          throw Error("unexpected foreign Wasm imports");
        return instance.exports;
      };
      const runtime = { sql: m.sql, aot: m.aot, compile: m.compile };
      const wr = {
        sql: (await instantiate(
          "/sqlike-diff.wasm",
        )) as unknown as typeof m.sql,
        aot: (await instantiate("/aot-diff.wasm")) as unknown as typeof m.aot,
        compile: m.compile,
      };
      const results = [
        ...m.auditTarget(cases, traces, m, "chromium-js/prepared-sql", false, nodeCompileErrors, true),
        ...m.auditTarget(cases, traces, wr, "chromium-wasm/prepared-sql", false, nodeCompileErrors, true),
        ...m.auditTarget(
          cases,
          traces,
          runtime,
          "chromium-js/sql",
          false,
          nodeCompileErrors,
        ),
        ...m.auditTarget(
          cases,
          traces,
          wr,
          "chromium-wasm/sql",
          false,
          nodeCompileErrors,
        ),
        ...m.auditTarget(
          cases,
          traces,
          runtime,
          "chromium-js/aot",
          true,
          nodeCompileErrors,
        ),
        ...m.auditTarget(
          cases,
          traces,
          wr,
          "chromium-wasm/aot",
          true,
          nodeCompileErrors,
        ),
      ];
      return {
        results,
        oracleDrift,
        sqliteVersion: sqlite.capi.sqlite3_libversion(),
      };
    },
    {
      cases,
      nodeOracle: oracle.traces,
      nodeCompileErrors: oracle.compileErrors,
    },
  );
  const counts = Object.fromEntries(
    [...new Set(result.results.map((r) => r.status))].map((status) => [
      status,
      result.results.filter((r) => r.status === status).length,
    ]),
  );
  const artifacts = Object.fromEntries(
    [
      "tests/compatibility/differential-runtime.ts",
      "src/sql-statement-cache.ts",
      "_build/js/release/build/mizchi/sqlike/sqlike.js",
      "_build/js/release/build/mizchi/sqlike/compiler/compiler.js",
      "_build/js/release/build/mizchi/litestream-example/runtime/runtime.js",
      "_build/wasm-gc/release/build/mizchi/sqlike/sqlike.wasm",
      "_build/wasm-gc/release/build/mizchi/litestream-example/runtime/runtime.wasm",
    ].map((path) => [
      path,
      createHash("sha256").update(readFileSync(path)).digest("hex"),
    ]),
  );
  const report = {
    artifacts,
    corpusSHA256: createHash("sha256")
      .update(JSON.stringify(cases))
      .digest("hex"),
    format: 1,
    measuredAt: new Date().toISOString(),
    seed: 0x51a17e,
    family: null,
    chromium: browser.version(),
    oracleVersion: result.sqliteVersion,
    oracleSetupErrors: cases
      .filter((c) => oracle.traces[c.id]!.setupFailed)
      .map((c) => c.id),
    cases,
    counts,
    ...result,
  };
  writeFileSync(
    "measurements/sqlike-differential-chromium.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  expect(result.results.length).toBe(cases.length * 6);
  expect(
    result.results.filter((r) => r.status === "matched").length,
  ).toBeGreaterThan(0);
  expect(new Set(result.results.map((r) => r.target)).size).toBe(6);
  console.log(
    JSON.stringify({
      cases: cases.length,
      counts,
      oracleDrift: result.oracleDrift.length,
    }),
  );
});
