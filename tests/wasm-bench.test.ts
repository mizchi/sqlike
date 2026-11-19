import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as aot from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import * as dynamic from "../_build/js/release/build/mizchi/sqlike/full/full.js";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import { runSpeedBench } from "../scripts/wasm-bench-workload.ts";

test("speed benchmark checks results and LTX round trips for all four runtimes before recording samples", async () => {
  const source = {
    schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER,title TEXT)"],
    queries: [
      { name: "add", sql: "INSERT INTO t VALUES(?,?,?)" },
      { name: "read", sql: "SELECT n FROM t WHERE id=?" },
      { name: "update", sql: "UPDATE t SET n=? WHERE id=?" },
    ],
  };
  const { artifact } = buildCatalog(source);
  const seed =
    '[{"t":"integer","v":"1"},{"t":"integer","v":"9"},{"t":"text","v":"日本語"}]';
  const db = aot.aot_open(artifact, "");
  aot.aot_execute(db, "add", seed);
  const sqlite = aot.sqlite_data_base64(aot.aot_export_sqlite(db));
  const ltx = aot.ltx_data_base64(
    aot.encode_ltx_base64("", sqlite, "1", "1", "0"),
  );
  const load = async (path: string) =>
    (
      await WebAssembly.instantiate(
        readFileSync(path),
        {},
        { builtins: ["js-string"], importedStringConstants: "_" },
      )
    ).instance.exports;
  const engines = {
    js: { aot, dynamic },
    wasm: {
      aot: (await load(
        "_build/wasm-gc/release/build/mizchi/litestream-example/runtime/runtime.wasm",
      )) as unknown as typeof aot,
      dynamic: (await load(
        "_build/wasm-gc/release/build/mizchi/sqlike/full/full.wasm",
      )) as unknown as typeof dynamic,
    },
  };
  const input = {
    artifact,
    schema: source.schema[0]!,
    insertSQL: source.queries[0]!.sql,
    seeds: [seed],
    warmup: 1,
    runs: 2,
    queries: [
      {
        name: "read",
        sql: source.queries[1]!.sql,
        bindings: '[{"t":"integer","v":"1"}]',
        expected: [[{ t: "integer", v: "9" }]],
        iterations: 2,
      },
      {
        name: "update",
        sql: source.queries[2]!.sql,
        write: true,
        bindings: '[{"t":"integer","v":"7"},{"t":"integer","v":"1"}]',
        expected: [],
        iterations: 2,
        check: {
          name: "read",
          sql: source.queries[1]!.sql,
          bindings: '[{"t":"integer","v":"1"}]',
          expected: [[{ t: "integer", v: "7" }]],
        },
      },
    ],
    sqlite,
    ltxInput: sqlite,
    ltx,
    checkpointIterations: 2,
    checkpointWarmup: 1,
  };
  const report = runSpeedBench(engines, input);
  assert.equal(report.samples.length, (4 * 2 + 2 * 3) * 2);
  assert.equal(report.verified.length, 4 * 2 + 2 * 3);
  assert.ok(report.samples.every((s) => s.milliseconds >= 0));
  assert.throws(
    () =>
      runSpeedBench(engines, {
        ...input,
        queries: [
          { ...input.queries[0]!, expected: [[{ t: "integer", v: "10" }]] },
        ],
      }),
    /result mismatch/,
  );
  assert.throws(
    () => runSpeedBench(engines, { ...input, sqlite: "wrong" }),
    /result mismatch/,
  );
});
