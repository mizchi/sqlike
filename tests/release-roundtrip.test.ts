import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import * as js from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import {
  releaseScenarios,
  releaseObserve,
} from "./compatibility/release-scenarios.ts";
import { oracleTraces } from "./compatibility/differential-node.ts";
import { value, datum } from "./compatibility/differential-core.ts";
import { aotBindings } from "../src/aot-values.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "./compatibility/native-values.ts";
test("U01-U09 combined schema survives JS/Wasm SQLite export, native integrity/FK and real Litestream restore", async () => {
  const wasm = (
    await WebAssembly.instantiate(
      readFileSync(
        "_build/wasm-gc/release/build/mizchi/litestream-example/runtime/runtime.wasm",
      ),
      {},
      { builtins: ["js-string"], importedStringConstants: "_" },
    )
  ).instance.exports as unknown as typeof js;
  const cases = releaseScenarios().filter((c) => !c.dynamicOnly),
    oracle = oracleTraces(cases),
    root = mkdtempSync(join(tmpdir(), "sqlike-release-"));
  let last: Uint8Array = new Uint8Array();
  try {
    for (const c of cases) {
      const ops = [...(c.seed ?? []), ...c.steps],
        unique = [...new Set(ops.map((s) => s.sql))],
        names = new Map(unique.map((sql, i) => [sql, `q${i}`]));
      const built = buildCatalog({
        schema: c.schema,
        queries: unique.map((sql) => ({ name: names.get(sql)!, sql })),
      });
      const images: Uint8Array[] = [];
      for (const r of [js, wasm]) {
        const db = r.aot_open(built.artifact, "");
        assert.equal(JSON.parse(r.aot_info(db)).error, undefined);
        for (const op of ops)
          r.aot_execute(
            db,
            names.get(op.sql)!,
            aotBindings((op.params ?? []).map(value)),
          );
        const exported = r.aot_export_sqlite(db);
        assert.equal(JSON.parse(r.sqlite_info(exported)).error, undefined);
        images.push(
          new Uint8Array(Buffer.from(r.sqlite_data_base64(exported), "base64")),
        );
      }
      assert.deepEqual(images[0], images[1], c.id);
      last = images[0]!;
      const path = join(root, c.id + ".sqlite");
      writeFileSync(path, last);
      const native = new NodeDatabase(path, false, true);
      try {
        assert.deepEqual(
          nativeValues(native, "PRAGMA integrity_check"),
          [["ok"]],
          c.id,
        );
        assert.deepEqual(
          nativeValues(native, "PRAGMA foreign_key_check"),
          [],
          c.id,
        );
        const trace = oracle.traces[c.id]!,
          expected = trace.steps.at(-1)!.observations;
        for (const [i, q] of releaseObserve.entries())
          assert.deepEqual(
            nativeValues(native, q.sql).map((row) => row.map(datum)),
            expected[i]!.kind === "rows" ? expected[i]!.rows : [],
            `${c.id}: ${q.sql}`,
          );
      } finally {
        native.close();
      }
    }
    const level = join(root, "replica", "ltx", "0");
    mkdirSync(level, { recursive: true });
    const result = js.encode_ltx(new Uint8Array(), last, "1", "1", "0");
    assert.equal(JSON.parse(js.ltx_info(result)).error, undefined);
    const file = join(level, "0000000000000001-0000000000000001.ltx");
    writeFileSync(file, js.ltx_data(result));
    execFileSync("go", ["run", "-mod=mod", ".", "verify", file], {
      cwd: "scripts/ltx-reference",
      stdio: "pipe",
    });
    assert.ok(
      process.env.LITESTREAM_BIN,
      "LITESTREAM_BIN is required; native restore must not be skipped",
    );
    const restored = join(root, "restored.sqlite");
    execFileSync(
      process.env.LITESTREAM_BIN,
      ["restore", "-o", restored, pathToFileURL(join(root, "replica")).href],
      { stdio: "pipe" },
    );
    assert.deepEqual(new Uint8Array(readFileSync(restored)), last);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("U07 fixed AOT schema requires recompilation and rejects a saved image from another program", () => {
  const old = buildCatalog({
    schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,title TEXT)"],
    queries: [{ name: "put", sql: "INSERT INTO t VALUES(?,?)" }],
  });
  const next = buildCatalog({
    schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,label TEXT)"],
    queries: [{ name: "put", sql: "INSERT INTO t VALUES(?,?)" }],
  });
  const db = js.aot_open(old.artifact, "");
  assert.equal(
    JSON.parse(js.aot_execute(db, "put", aotBindings([1n, "old"]))).error,
    undefined,
  );
  const saved = js.aot_dump(db);
  assert.equal(
    JSON.parse(js.aot_info(js.aot_open(old.artifact, saved))).error,
    undefined,
  );
  assert.match(
    JSON.parse(js.aot_info(js.aot_open(next.artifact, saved))).error,
    /program|schema|invalid/i,
  );
});
