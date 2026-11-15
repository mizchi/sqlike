import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NodeDatabase } from "../adapters/node-database.ts";
import { packResult } from "../src/protocol.ts";

test("pure MoonBit Wasm GC applies real Litestream files and reads the resulting SQLite image without host database calls", async () => {
  const options = { builtins: ["js-string"], importedStringConstants: "_" };
  const core = await WebAssembly.instantiate(
    readFileSync("_build/wasm-gc/release/build/mizchi/litestream/litestream.wasm"),
    {},
    options,
  );
  const sql = await WebAssembly.instantiate(
    readFileSync("_build/wasm-gc/release/build/mizchi/sqlike/sqlike.wasm"),
    {},
    options,
  );
  assert.deepEqual(WebAssembly.Module.imports(core.module), []);
  assert.deepEqual(WebAssembly.Module.imports(sql.module), []);
  const ltx = core.instance.exports as unknown as {
    apply_ltx_base64(
      base: string,
      txid: string,
      file: string,
      version: number,
    ): unknown;
    ltx_data_base64(result: unknown): string;
    ltx_info(result: unknown): string;
  };
  const db = sql.instance.exports as unknown as {
    database_open(): unknown;
    database_import_sqlite_base64(db: unknown, base64: string): string;
    database_exec(
      db: unknown,
      sql: string,
      params: string,
      readOnly: boolean,
    ): string;
  };
  let image = "",
    txid = "0";
  const directory = new URL("./fixtures/ltx/", import.meta.url);
  const files: string[] = JSON.parse(
    readFileSync(new URL("litestream.json", directory), "utf8"),
  );
  for (const file of files) {
    const result = ltx.apply_ltx_base64(
      image,
      txid,
      readFileSync(new URL(file, directory)).toString("base64"),
      3,
    );
    const info = JSON.parse(ltx.ltx_info(result));
    assert.equal(info.error, undefined);
    txid = info.maxTXID;
    image = ltx.ltx_data_base64(result);
  }
  assert.deepEqual(
    Buffer.from(image, "base64"),
    readFileSync(new URL("litestream-restored.sqlite", directory)),
  );
  const handle = db.database_open();
  assert.deepEqual(
    JSON.parse(db.database_import_sqlite_base64(handle, image)),
    {},
  );
  const result = JSON.parse(
    db.database_exec(handle, "SELECT * FROM items ORDER BY id", "[]", true),
  );
  const oracle = new NodeDatabase(
    new URL("litestream-restored.sqlite", directory).pathname,
    false,
    true,
  );
  try {
    assert.deepEqual(
      result.rows,
      oracle
        .all("SELECT * FROM items ORDER BY id")
        .map((r) =>
          Object.fromEntries(Object.entries(r).map(([k, v]) => [k, packResult(v)])),
        ),
    );
  } finally {
    oracle.close();
  }
  const broken = readFileSync(new URL(files[0]!, directory));
  broken[0] = 0;
  const rejected = ltx.apply_ltx_base64("", "0", broken.toString("base64"), 3);
  assert.ok(JSON.parse(ltx.ltx_info(rejected)).error);
  assert.equal(ltx.ltx_data_base64(rejected), "");
  assert.ok(
    JSON.parse(db.database_import_sqlite_base64(handle, "invalid!!")).error,
  );
  assert.deepEqual(
    JSON.parse(
      db.database_exec(handle, "SELECT * FROM items ORDER BY id", "[]", true),
    ).rows,
    result.rows,
  );
});
