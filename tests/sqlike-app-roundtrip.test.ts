import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import * as js from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import * as dynamic from "../_build/js/release/build/mizchi/sqlike/sqlike.js";
import { aotBindings, aotValue } from "../src/aot-values.ts";
import { result } from "./compatibility/sqlike-paths.ts";
test("new ASTs, composite deferred FKs and clock defaults survive AOT JS/Wasm SQLite export and native import", async () => {
  const built = buildCatalog({
    schema: [
      "CREATE TABLE p(a INTEGER,b TEXT,PRIMARY KEY(a,b))",
      "CREATE TABLE c(id INTEGER PRIMARY KEY,x INTEGER,y TEXT,meta TEXT,created TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(x,y) REFERENCES p(a,b) ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED)",
    ],
    queries: [
      { name: "begin", sql: "BEGIN" },
      {
        name: "child",
        sql: "INSERT INTO c(id,x,y,meta) SELECT 1,7,'a',json_set('{}','$.n',CAST('3tail' AS INTEGER))",
      },
      { name: "parent", sql: "INSERT INTO p VALUES(7,'a')" },
      { name: "commit", sql: "COMMIT" },
      { name: "update", sql: "UPDATE p SET a=8" },
      {
        name: "all",
        sql: "SELECT id,x,json_extract(meta,'$.n'),date(created),sum(x) OVER(ORDER BY id) FROM c",
      },
    ],
  });
  const wasm = (
    await WebAssembly.instantiate(
      readFileSync(
        "_build/wasm-gc/release/build/mizchi/litestream-example/runtime/runtime.wasm",
      ),
      {},
      { builtins: ["js-string"], importedStringConstants: "_" },
    )
  ).instance.exports as unknown as typeof js;
  const images = [];
  for (const r of [js, wasm]) {
    const db = r.aot_open(built.artifact, "");
    result(r.aot_info(db));
    result(r.aot_set_clock(db, "1704067200000"));
    for (const q of ["begin", "child", "parent", "commit", "update"])
      result(r.aot_execute(db, q, "[]"));
    assert.deepEqual(
      result(r.aot_execute(db, "all", "[]")).rows.map((r: any[]) =>
        r.map(aotValue),
      ),
      [[1n, 8n, 3n, "2024-01-01", 8n]],
    );
    const exported = r.aot_export_sqlite(db);
    result(r.sqlite_info(exported));
    images.push(
      Uint8Array.from(Buffer.from(r.sqlite_data_base64(exported), "base64")),
    );
  }
  assert.deepEqual(images[0], images[1]);
  const dir = mkdtempSync(join(tmpdir(), "sqlike-app-roundtrip-"));
  try {
    const path = join(dir, "db.sqlite");
    writeFileSync(path, images[0]!);
    const native = new DatabaseSync(path);
    try {
      native.exec("PRAGMA foreign_keys=ON");
      assert.deepEqual(
        native.prepare("PRAGMA integrity_check").all().map(Object.values),
        [["ok"]],
      );
      assert.deepEqual(native.prepare("PRAGMA foreign_key_check").all(), []);
      assert.deepEqual(
        native
          .prepare(
            "SELECT id,x,json_extract(meta,'$.n'),date(created),sum(x) OVER(ORDER BY id) FROM c",
          )
          .all()
          .map(Object.values),
        [[1, 8, 3, "2024-01-01", 8]],
      );
    } finally {
      native.close();
    }
    const imported = dynamic.database_open();
    result(dynamic.database_import_sqlite(imported, images[0]!));
    result(dynamic.database_exec(imported, "UPDATE p SET a=9", "[]", false));
    assert.deepEqual(
      result(
        dynamic.database_query_values(imported, "SELECT x FROM c", "[]"),
      ).rows.map((r: any[]) => r.map(aotValue)),
      [[9n]],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
