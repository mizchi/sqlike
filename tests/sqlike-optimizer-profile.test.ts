import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { buildSqlikeRuntime } from "../scripts/build-sqlike-runtime.ts";
import { fullSqlike } from "../src/sqlike-features.ts";
import { differentialCorpus } from "./compatibility/differential-corpus.ts";
import { oracleTraces } from "./compatibility/differential-node.ts";
import { dynamicDriver } from "./compatibility/differential-runtime.ts";
import { runTrace, compareTraces } from "./compatibility/differential-core.ts";
test("all optimizer gates may be disabled without changing successful SQLite corpus outputs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sqlike-no-optimizer-"));
  try {
    const built = await buildSqlikeRuntime(fullSqlike(), {
      outDir: dir,
      optimizers: [],
    });
    assert.ok(
      Object.entries(built.plan.constants)
        .filter(([k]) => k.startsWith("OPT_"))
        .every(([, v]) => !v),
    );
    const js = await import(pathToFileURL(join(dir, "runtime.js")).href);
    const wasm = (
      await WebAssembly.instantiate(
        await readFile(join(dir, "runtime.wasm")),
        {},
        { builtins: ["js-string"], importedStringConstants: "_" },
      )
    ).instance.exports;
    const cases = differentialCorpus(),
      oracle = oracleTraces(cases);
    for (const runtime of [js, wasm])
      for (const c of cases) {
        const driver = dynamicDriver(
          runtime as Parameters<typeof dynamicDriver>[0],
        );
        try {
          assert.deepEqual(
            compareTraces(oracle.traces[c.id]!, runTrace(c, driver)),
            [],
            c.id,
          );
        } finally {
          driver.close();
        }
      }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
