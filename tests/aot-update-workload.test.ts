import { test } from "node:test";
import assert from "node:assert/strict";
import * as compiler from "../_build/js/release/build/mizchi/sqlike/compiler/compiler.js";
import { installUpdates } from "../scripts/aot-update-workload.ts";
import { aotBindings } from "../src/aot-values.ts";

test("benchmark UPDATE bindings keep changing values across odd-sized runs", async () => {
  const artifact = compiler.compile_program(JSON.stringify({
    schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,value INTEGER)"],
    queries: [
      { name: "seed", sql: "INSERT INTO t VALUES(1,0)" },
      { name: "scan", sql: "SELECT value FROM t" },
      { name: "range", sql: "SELECT value FROM t" },
      { name: "update", sql: "UPDATE t SET value=? WHERE id=1 RETURNING value" },
    ],
  }));
  const runner = await installUpdates({
    artifact,
    schema: [],
    statements: [],
    seeds: ["[]"],
    operations: [{ name: "update", bindings: [aotBindings([1n]), aotBindings([2n])] }],
  }, [{
    name: "aot/js",
    url: new URL("../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js", import.meta.url).href,
    wasm: false,
    defined: false,
  }]);
  runner.run("aot/js", "update", 3);
  assert.deepEqual(runner.verify()[0]!.rows, JSON.parse(aotBindings([1n])).map((v: unknown) => [v]));
  runner.run("aot/js", "update", 1);
  const state = runner.verify()[0]!;
  assert.deepEqual(state.rows, JSON.parse(aotBindings([2n])).map((v: unknown) => [v]));
  assert.equal(state.operations[0]!.calls, 4);
  assert.equal(state.operations[0]!.last, 1);
  assert.deepEqual(state.operations[0]!.lastRows, state.rows);
});
