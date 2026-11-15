import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as runtime from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import { aotBindings } from "../src/aot-values.ts";

test("parser-free Wasm GC produces identical SQLite and LTX bytes without foreign imports", async () => {
  const { instance, module } = await WebAssembly.instantiate(
    readFileSync("_build/wasm-gc/release/build/mizchi/litestream-example/runtime/runtime.wasm"),
    {},
    { builtins: ["js-string"], importedStringConstants: "_" },
  );
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  const wasm = instance.exports as unknown as typeof runtime;
  assert.equal("compile_program" in instance.exports, false);
  assert.equal("database_exec" in instance.exports, false);
  const built = buildCatalog(
    {
      schema: [
        "CREATE TABLE t(id INTEGER PRIMARY KEY,t TEXT,b BLOB)",
        "CREATE INDEX ix_t ON t(t)",
      ],
      queries: [
        { name: "add", sql: "INSERT INTO t VALUES(?,?,?)" },
        { name: "read", sql: "SELECT * FROM t ORDER BY id" },
      ],
    },
    { pageSize: 512 },
  );
  const outputs = [runtime, wasm].map((engine) => {
    const db = engine.aot_open(built.artifact, "");
    assert.equal(JSON.parse(engine.aot_info(db)).error, undefined);
    for (let i = 0; i < 60; i++)
      assert.equal(
        JSON.parse(
          engine.aot_execute(
            db,
            "add",
            aotBindings([
              BigInt(i + 1),
              `値${i}`,
              new Uint8Array(1500).fill(i),
            ]),
          ),
        ).error,
        undefined,
      );
    const exported = engine.aot_export_sqlite(db);
    assert.equal(JSON.parse(engine.sqlite_info(exported)).error, undefined);
    const sqlite = engine.sqlite_data_base64(exported),
      ltx = engine.encode_ltx_base64("", sqlite, "1", "1", "0");
    assert.equal(JSON.parse(engine.ltx_info(ltx)).error, undefined);
    return {
      rows: engine.aot_execute(db, "read", "[]"),
      sqlite,
      ltx: engine.ltx_data_base64(ltx),
    };
  });
  assert.deepEqual(outputs[1], outputs[0]);
});
