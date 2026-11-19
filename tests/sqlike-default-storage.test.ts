import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as aot from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import * as sql from "../_build/js/release/build/mizchi/sqlike/full/full.js";
import * as ltx from "../_build/js/release/build/mizchi/litestream/litestream.js";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import { aotValue } from "../src/aot-values.ts";
import { applyLtx } from "../src/ltx.ts";
import { result } from "./compatibility/sqlike-paths.ts";
import { buildDefinedCatalog } from "../scripts/defined-compiler.ts";
import { DefinedDatabase } from "../adapters/defined-database.ts";
import { exportDefinedSQLite } from "../adapters/defined-sqlite.ts";
import { definedWasm } from "../adapters/defined-wasm.ts";

async function wasm(path: string) {
  return (
    await WebAssembly.instantiate(
      readFileSync(path),
      {},
      { builtins: ["js-string"], importedStringConstants: "_" },
    )
  ).instance.exports;
}

test("expression DEFAULT clock values survive JSON restore, SQLite pages and LTX without reevaluation", async () => {
  const source = {
    schema: [
      "CREATE TABLE t(id INTEGER PRIMARY KEY,at TEXT DEFAULT(datetime('now','+1 day')),v DEFAULT(abs(-9223372036854775808)))",
    ],
    queries: [
      { name: "add", sql: "INSERT INTO t(id,v) VALUES(1,7),(2,8)" },
      { name: "q", sql: "SELECT * FROM t ORDER BY id" },
    ],
  };
  const built = buildCatalog(source),
    directory = mkdtempSync(join(tmpdir(), "sqlike-default-storage-"));
  const dynamic = [
    sql,
    (await wasm(
      "_build/wasm-gc/release/build/mizchi/sqlike/full/full.wasm",
    )) as unknown as typeof sql,
  ];
  try {
    for (const raw of [
      aot,
      (await wasm(
        "_build/wasm-gc/release/build/mizchi/litestream-example/runtime/runtime.wasm",
      )) as unknown as typeof aot,
    ]) {
      const db = raw.aot_open(built.artifact, "");
      result(raw.aot_info(db));
      result(raw.aot_set_clock(db, "1704067200125"));
      const exportImage = () => {
        const r = raw.aot_export_sqlite(db);
        result(raw.sqlite_info(r));
        return Uint8Array.from(
          Buffer.from(raw.sqlite_data_base64(r), "base64"),
        );
      };
      const base = exportImage();
      result(raw.aot_execute(db, "add", "[]"));
      const expected = [
        [1n, "2024-01-02 00:00:00", 7n],
        [2n, "2024-01-02 00:00:00", 8n],
      ];
      const values = () =>
        result(raw.aot_execute(db, "q", "[]")).rows.map((row: any[]) =>
          row.map(aotValue),
        );
      assert.deepEqual(values(), expected);
      const saved = raw.aot_dump(db);
      result(raw.aot_set_clock(db, "1900000000000"));
      result(raw.aot_restore(db, saved));
      assert.deepEqual(values(), expected);
      const after = exportImage(),
        encoded = ltx.encode_ltx(base, after, "2", "2", "0");
      result(ltx.ltx_info(encoded));
      assert.deepEqual(
        applyLtx(base, "1", ltx.ltx_data(encoded), 3).data,
        after,
      );
      const file = join(directory, "db.sqlite");
      writeFileSync(file, after);
      const native = new DatabaseSync(file);
      try {
        assert.equal(
          native.prepare("PRAGMA integrity_check").get()!.integrity_check,
          "ok",
        );
        const q = native.prepare(source.queries[1]!.sql);
        q.setReadBigInts(true);
        q.setReturnArrays(true);
        assert.deepEqual(q.all(), expected);
      } finally {
        native.close();
      }
      for (const r of dynamic) {
        const handle = r.database_open();
        result(
          r.database_import_sqlite_base64(
            handle,
            Buffer.from(after).toString("base64"),
          ),
        );
        assert.deepEqual(
          result(
            r.database_query_values(handle, source.queries[1]!.sql, "[]"),
          ).rows.map((row: any[]) => row.map(aotValue)),
          expected,
        );
        assert.throws(
          () =>
            result(
              r.database_exec(
                handle,
                "INSERT INTO t(id) VALUES(3)",
                "[]",
                false,
              ),
            ),
          /overflow/,
        );
        assert.deepEqual(
          result(
            r.database_query_values(handle, source.queries[1]!.sql, "[]"),
          ).rows.map((row: any[]) => row.map(aotValue)),
          expected,
        );
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("parser-free catalog validation rejects parameter and column defaults even when no rows use them", () => {
  const artifact = buildCatalog({
    schema: ["CREATE TABLE t(v DEFAULT(1+2))"],
    queries: [],
  }).artifact;
  for (const invalid of [
    ["Parameter", 0],
    ["Column", "", "v"],
  ]) {
    const changed = JSON.parse(artifact);
    changed.schema.tables[0].columns[0].default_value = invalid;
    assert.throws(
      () => result(aot.aot_info(aot.aot_open(JSON.stringify(changed), ""))),
      /DEFAULT/,
    );
  }
});

test("CTAS initial rows round-trip through binary snapshots, SQLite templates and LTX", async () => {
  const source = {
    schema: [
      "CREATE TABLE t AS SELECT CAST(7 AS INTEGER) AS id,lower('HELLO') AS v",
      "CREATE INDEX by_id ON t(id)",
    ],
    queries: [
      { name: "q", sql: "SELECT rowid,* FROM t ORDER BY rowid" },
      { name: "add", sql: "INSERT INTO t VALUES(8,'next')" },
    ],
  };
  const catalog = buildDefinedCatalog(source, {
    sqliteExport: true,
    pageSize: 512,
  });
  const directory = mkdtempSync(join(tmpdir(), "sqlike-ctas-storage-"));
  const runtime = definedWasm(
    await wasm(
      "_build/wasm-gc/release/build/mizchi/sqlike/defined/defined.wasm",
    ),
  );
  try {
    for (const engine of [undefined, runtime]) {
      const db = await DefinedDatabase.memory(
        catalog,
        engine ? { runtime: engine } : {},
      );
      try {
        assert.deepEqual((await db.execute("q")).rows, [[1n, 7n, "hello"]]);
        const base = await exportDefinedSQLite(catalog, await db.snapshot());
        await db.execute("add");
        const image = await db.snapshot(),
          after = await exportDefinedSQLite(catalog, image);
        const restored = await DefinedDatabase.memory(catalog, { image });
        try {
          assert.deepEqual((await restored.execute("q")).rows, [
            [1n, 7n, "hello"],
            [2n, 8n, "next"],
          ]);
        } finally {
          await restored.close();
        }
        const encoded = ltx.encode_ltx(base, after, "2", "2", "0");
        result(ltx.ltx_info(encoded));
        assert.deepEqual(
          applyLtx(base, "1", ltx.ltx_data(encoded), 3).data,
          after,
        );
        const file = join(directory, "db.sqlite");
        writeFileSync(file, after);
        const native = new DatabaseSync(file);
        try {
          assert.equal(
            native.prepare("PRAGMA integrity_check").get()!.integrity_check,
            "ok",
          );
          const q = native.prepare(source.queries[0]!.sql);
          q.setReadBigInts(true);
          q.setReturnArrays(true);
          assert.deepEqual(q.all(), (await db.execute("q")).rows);
        } finally {
          native.close();
        }
      } finally {
        await db.close();
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
