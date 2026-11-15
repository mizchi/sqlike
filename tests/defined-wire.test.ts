import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import * as runtime from "../_build/js/release/build/mizchi/sqlike/defined/defined.js";
import { buildDefinedCatalog } from "../scripts/defined-compiler.ts";
import { DefinedDatabase } from "../adapters/defined-database.ts";
import { exportDefinedSQLite } from "../adapters/defined-sqlite.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import * as compiler from "../_build/js/release/build/mizchi/sqlike/compiler/compiler.js";
import { definedWasm } from "../adapters/defined-wasm.ts";
const instantiate = async (path: string) =>
  (
    await WebAssembly.instantiate(
      readFileSync(path),
      {},
      { builtins: ["js-string"], importedStringConstants: "_" },
    )
  ).instance.exports;
test("generated binary codecs match the explicit versioned wire contract", () => {
  const contract = readFileSync("src/binary-wire.json");
  const hash = createHash("sha256").update(contract).digest("hex");
  for (const file of [
    "binary_generated.mbt",
    "feature_validation_generated.mbt",
  ])
    assert.ok(
      readFileSync(`packages/sqlike/src/${file}`, "utf8").includes(
        `Contract SHA256: ${hash}`,
      ),
    );
});
test("binary definition and row image bytes agree on JS/Wasm and SHA256 matches Node", async () => {
  const wasm = definedWasm(
    await instantiate(
      "_build/wasm-gc/release/build/mizchi/sqlike/defined/defined.wasm",
    ),
  );
  const cwasm = (await instantiate(
    "_build/wasm-gc/release/build/mizchi/sqlike/compiler/compiler.wasm",
  )) as unknown as typeof compiler;
  const request = JSON.stringify({
    schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,body TEXT,n REAL,b BLOB)"],
    queries: [
      { name: "put", sql: "INSERT INTO t VALUES(?,?,?,?) RETURNING *" },
      { name: "read", sql: "SELECT * FROM t" },
    ],
  });
  const packed = compiler.pack_program_binary(
      compiler.compile_program(request),
    ),
    wp = cwasm.pack_program_binary(cwasm.compile_program(request));
  const schema = compiler.binary_catalog_schema(packed),
    statements = compiler.binary_catalog_statements(packed);
  // SHA-256 IDs cover the complete emitted frame. Wasm GC byte arrays are
  // opaque here; compare their independently computed digests.
  assert.deepEqual(
    JSON.parse(cwasm.binary_catalog_info(wp)),
    JSON.parse(compiler.binary_catalog_info(packed)),
  );
  for (const bytes of [schema, statements]) {
    assert.equal(Buffer.from(bytes.slice(0, 4)).toString(), "SQLK");
    assert.equal(bytes[4], 1);
    assert.deepEqual(
      Buffer.from(bytes.slice(-32)),
      createHash("sha256").update(bytes.slice(0, -32)).digest(),
    );
  }
  const catalog = buildDefinedCatalog(JSON.parse(request)),
    images = [];
  for (const engine of [runtime, wasm]) {
    const db = await DefinedDatabase.memory(catalog, { runtime: engine });
    try {
      const output = await db.execute("put", [
        9223372036854775807n,
        "\ufeffa\0b",
        -0,
        new Uint8Array([0, 255]),
      ]);
      assert.deepEqual(output.rows, [
        [9223372036854775807n, "\ufeffa\0b", -0, new Uint8Array([0, 255])],
      ]);
      images.push(await db.snapshot());
    } finally {
      await db.close();
    }
    for (const offset of [0, 4, 5, 8, 12, schema.length - 1]) {
      const bad = schema.slice();
      bad[offset] = bad[offset]! ^ 128;
      const handle = engine.defined_open(bad, statements, new Uint8Array());
      assert.ok(JSON.parse(engine.defined_info(handle)).error);
    }
  }
  assert.deepEqual(images[1], images[0]);
});
test("optional binary SQLite layout exports a native-integrity image without a runtime SQL parser", async () => {
  const source = {
    schema: [
      "CREATE TABLE t(id INTEGER PRIMARY KEY,n TEXT NOT NULL)",
      "CREATE INDEX title ON t(n DESC)",
    ],
    queries: [{ name: "add", sql: "INSERT INTO t VALUES(?,?)" }],
  };
  const catalog = buildDefinedCatalog(source, { sqliteExport: true }),
    db = await DefinedDatabase.memory(catalog);
  const directory = mkdtempSync(join(tmpdir(), "defined-sqlite-"));
  try {
    await db.execute("add", [9007199254740993n, "kept"]);
    const image = await db.snapshot(),
      bytes = await exportDefinedSQLite(catalog, image);
    const path = join(directory, "image.sqlite");
    writeFileSync(path, bytes);
    const native = new NodeDatabase(path, true, true);
    try {
      assert.deepEqual(native.values("PRAGMA integrity_check"), [["ok"]]);
      assert.deepEqual(native.values("SELECT * FROM t"), [
        [9007199254740993n, "kept"],
      ]);
    } finally {
      native.close();
    }
    await assert.rejects(
      exportDefinedSQLite({ ...catalog, storage: undefined }, image),
      /optional storage layout/,
    );
  } finally {
    await db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("binary IR preserves STRICT, expression index, view, JSON, datetime, CTE, window and FULL JOIN on JS/Wasm", async () => {
  const source = {
    schema: [
      "CREATE TABLE t(id INTEGER PRIMARY KEY,grp TEXT,n REAL) STRICT",
      "CREATE INDEX fx ON t(lower(grp)) WHERE n>0",
      "CREATE VIEW ids AS SELECT id FROM t",
    ],
    queries: [
      {
        name: "seed",
        sql: "INSERT INTO t VALUES(1,'A',1.5),(2,'B',2.5),(3,'C',3.5)",
      },
      {
        name: "functions",
        sql: "SELECT json_extract(?,'$.x') AS wide,json_set('{}','$.n',1) AS payload,datetime('2024-02-28','+1 day') AS date",
      },
      {
        name: "window",
        sql: "SELECT id,row_number() OVER(ORDER BY id) AS rank,sum(n) OVER(ORDER BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS total FROM t ORDER BY id",
      },
      {
        name: "cte",
        sql: "WITH RECURSIVE x(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM x WHERE n<3) SELECT n FROM x",
      },
      { name: "view", sql: "SELECT id FROM ids ORDER BY id" },
      {
        name: "full",
        sql: "SELECT t.id AS left_id,v.id AS right_id FROM t FULL JOIN ids v ON t.id=v.id ORDER BY t.id",
      },
    ],
  };
  const catalog = buildDefinedCatalog(source),
    wasm = definedWasm(
      await instantiate(
        "_build/wasm-gc/release/build/mizchi/sqlike/defined/defined.wasm",
      ),
    );
  for (const engine of [runtime, wasm]) {
    const native = new NodeDatabase(":memory:"),
      db = await DefinedDatabase.memory(catalog, { runtime: engine });
    try {
      for (const sql of source.schema) native.run(sql);
      for (const query of source.queries) {
        const params =
          query.name === "functions" ? ['{"x":9223372036854775807}'] : [];
        assert.deepEqual(
          (await db.execute(query.name, params)).rows,
          native.values(query.sql, params),
          query.name,
        );
      }
    } finally {
      native.close();
      await db.close();
    }
  }
});
