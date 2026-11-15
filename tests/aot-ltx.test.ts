import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import * as runtime from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import { pack } from "../src/protocol.ts";
import type { Value } from "../src/contract.ts";

test("compiled SQL, partial/expression/composite indexes and trigger effects survive an LTX chain restored by real Litestream", () => {
  const built = buildCatalog(
    {
      schema: [
        "CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT NOT NULL,b BLOB)",
        "CREATE INDEX ix_value ON items(value)",
        "CREATE INDEX ix_feed ON items(value DESC,id ASC) WHERE id>0",
        "CREATE UNIQUE INDEX ix_normalized ON items(lower(value) DESC) WHERE id>0",
        "CREATE TABLE audit(id INTEGER PRIMARY KEY,item_id INTEGER,event TEXT)",
        "CREATE TRIGGER ai AFTER INSERT ON items BEGIN INSERT INTO audit(item_id,event) VALUES(new.id,'insert'); END",
        "CREATE TRIGGER ad AFTER DELETE ON items BEGIN INSERT INTO audit(item_id,event) VALUES(old.id,'delete'); END",
      ],
      queries: [
        { name: "add", sql: "INSERT INTO items VALUES(?,?,?)" },
        { name: "delete", sql: "DELETE FROM items WHERE id=?" },
      ],
    },
    { pageSize: 512 },
  );
  const db = runtime.aot_open(built.artifact, "");
  function execute(name: string, params: Value[]) {
    const info = JSON.parse(
      runtime.aot_execute(db, name, JSON.stringify(params.map(pack))),
    );
    if (info.error) throw Error(info.error);
  }
  function image() {
    const result = runtime.aot_export_sqlite(db);
    assert.equal(JSON.parse(runtime.sqlite_info(result)).error, undefined);
    return runtime.sqlite_data(result);
  }
  execute("add", [1n, "first", new Uint8Array([0, 255])]);
  const first = image();
  execute("add", [2n, "second", new Uint8Array(16000).fill(37)]);
  const second = image();
  execute("delete", [2n]);
  const third = image();
  const root = mkdtempSync(join(tmpdir(), "moon-generated-ltx-"));
  try {
    const level = join(root, "replica", "ltx", "0");
    mkdirSync(level, { recursive: true });
    let previous: Uint8Array<ArrayBufferLike> = new Uint8Array();
    for (const [index, data] of [first, second, third].entries()) {
      const tx = String(index + 1),
        result = runtime.encode_ltx(previous, data, tx, tx, "0");
      assert.equal(JSON.parse(runtime.ltx_info(result)).error, undefined);
      const bytes = runtime.ltx_data(result),
        id = BigInt(tx).toString(16).padStart(16, "0"),
        path = join(level, `${id}-${id}.ltx`);
      writeFileSync(path, bytes);
      execFileSync("go", ["run", "-mod=mod", ".", "verify", path], {
        cwd: "scripts/ltx-reference",
        stdio: "pipe",
      });
      const applied = runtime.apply_ltx(previous, String(index), bytes, 3);
      assert.equal(JSON.parse(runtime.ltx_info(applied)).error, undefined);
      assert.deepEqual(runtime.ltx_data(applied), data);
      previous = data;
    }
    const binary = process.env.LITESTREAM_BIN;
    assert.ok(
      binary,
      "set LITESTREAM_BIN; this compatibility gate must not skip native restore",
    );
    const output = join(root, "restored.sqlite");
    execFileSync(
      binary,
      ["restore", "-o", output, pathToFileURL(join(root, "replica")).href],
      { stdio: "pipe" },
    );
    assert.deepEqual(new Uint8Array(readFileSync(output)), third);
    const native = new DatabaseSync(output, { readOnly: true });
    try {
      assert.deepEqual(
        native.prepare("PRAGMA integrity_check").all().map(Object.values),
        [["ok"]],
      );
      const s = native.prepare("SELECT id,value,hex(b) FROM items ORDER BY id");
      s.setReadBigInts(true);
      assert.deepEqual(s.all().map(Object.values), [[1n, "first", "00FF"]]);
      assert.deepEqual(
        native
          .prepare("SELECT item_id,event FROM audit ORDER BY id")
          .all()
          .map(Object.values),
        [
          [1, "insert"],
          [2, "insert"],
          [2, "delete"],
        ],
      );
      assert.deepEqual(
        native
          .prepare(
            "SELECT lower(value) FROM items INDEXED BY ix_normalized WHERE id>0 ORDER BY lower(value) DESC",
          )
          .all()
          .map(Object.values),
        [["first"]],
      );
      assert.deepEqual(
        native
          .prepare(
            "SELECT value,id FROM items INDEXED BY ix_feed WHERE id>0 ORDER BY value DESC,id ASC",
          )
          .all()
          .map(Object.values),
        [["first", 1]],
      );
      assert.equal(
        native
          .prepare(
            "SELECT count(*) AS n FROM sqlite_schema WHERE type='trigger'",
          )
          .get()!.n,
        2,
      );
    } finally {
      native.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
