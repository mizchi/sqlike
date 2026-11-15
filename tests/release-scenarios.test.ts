import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as sql from "../_build/js/release/build/mizchi/sqlike/sqlike.js";
import * as aot from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import { compile_program as compile } from "../_build/js/release/build/mizchi/sqlike/compiler/compiler.js";
import { releaseScenarios } from "./compatibility/release-scenarios.ts";
import { oracleTraces } from "./compatibility/differential-node.ts";
import { auditTarget } from "./compatibility/differential-runtime.ts";
import { sourceHashes } from "../scripts/measurement-manifest.ts";
test("U01-U09 application scenarios preserve typed results and failure state on JS/Wasm SQL/AOT", async () => {
  const cases = releaseScenarios();
  assert.deepEqual(
    cases.map((c) => c.id),
    Array.from({ length: 9 }, (_, i) => `U${String(i + 1).padStart(2, "0")}`),
  );
  const oracle = oracleTraces(cases);
  assert.ok(cases.every((c) => !oracle.traces[c.id]!.setupFailed));
  const load = async (path: string) =>
    (
      await WebAssembly.instantiate(
        readFileSync(path),
        {},
        { builtins: ["js-string"], importedStringConstants: "_" },
      )
    ).instance.exports;
  const wr = {
    sql: (await load(
      "_build/wasm-gc/release/build/mizchi/sqlike/sqlike.wasm",
    )) as unknown as typeof sql,
    aot: (await load(
      "_build/wasm-gc/release/build/mizchi/litestream-example/runtime/runtime.wasm",
    )) as unknown as typeof aot,
    compile,
  };
  const results = [
    ...auditTarget(
      cases,
      oracle.traces,
      { sql, aot, compile },
      "js/sql",
      false,
      oracle.compileErrors,
    ),
    ...auditTarget(
      cases,
      oracle.traces,
      wr,
      "wasm/sql",
      false,
      oracle.compileErrors,
    ),
    ...auditTarget(
      cases,
      oracle.traces,
      { sql, aot, compile },
      "js/aot",
      true,
      oracle.compileErrors,
    ),
    ...auditTarget(
      cases,
      oracle.traces,
      wr,
      "wasm/aot",
      true,
      oracle.compileErrors,
    ),
  ];
  writeFileSync(
    "measurements/release-scenarios-node.json",
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        sourceHashes: sourceHashes([
          "tests/release-scenarios.test.ts",
          "tests/compatibility/release-scenarios.ts",
          "tests/compatibility/differential-core.ts",
          "tests/compatibility/differential-runtime.ts",
          ...[
            "mizchi/sqlike/sqlike.js",
            "mizchi/sqlike/compiler/compiler.js",
            "mizchi/litestream-example/runtime/runtime.js",
          ].map((p) => "_build/js/release/build/" + p),
          ...[
            "mizchi/sqlike/sqlike.wasm",
            "mizchi/litestream-example/runtime/runtime.wasm",
          ].map((p) => "_build/wasm-gc/release/build/" + p),
        ]),
        oracle: process.versions.sqlite,
        cases,
        corpusSHA256: createHash("sha256")
          .update(JSON.stringify(cases))
          .digest("hex"),
        results,
      },
      null,
      2,
    ) + "\n",
  );
  assert.deepEqual(
    results.filter(
      (r) =>
        r.status !== "matched" &&
        !(r.id === "U07" && r.status === "not-applicable"),
    ),
    [],
  );
  assert.equal(results.filter((r) => r.status === "matched").length, 34);
});
