import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import * as runtime from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import { pack } from "../src/protocol.ts";
import type { Value } from "../src/contract.ts";
import * as dynamic from "../_build/js/release/build/mizchi/sqlike/full/full.js";
import { aotBindings, aotValue } from "../src/aot-values.ts";

test("mixed-direction and explicit-collation composite indexes survive JS/Wasm SQLite export and import", async () => {
  const source = {
    schema: [
      "CREATE TABLE t(id INTEGER PRIMARY KEY,tenant TEXT COLLATE NOCASE,n INTEGER,label TEXT)",
      "CREATE INDEX feed ON t(tenant COLLATE BINARY ASC,n DESC,id ASC)",
      "CREATE UNIQUE INDEX uq ON t(label COLLATE NOCASE DESC,tenant COLLATE BINARY)",
    ],
    queries: [{ name: "add", sql: "INSERT INTO t VALUES(?,?,?,?)" }],
  };
  const built = buildCatalog(source, { pageSize: 512 });
  const wasm = (
    await WebAssembly.instantiate(
      readFileSync(
        "_build/wasm-gc/release/build/mizchi/litestream-example/runtime/runtime.wasm",
      ),
      {},
      { builtins: ["js-string"], importedStringConstants: "_" },
    )
  ).instance.exports as unknown as typeof runtime;
  const outputs: Uint8Array[] = [];
  for (const engine of [runtime, wasm]) {
    const db = engine.aot_open(built.artifact, "");
    for (let i = 0; i < 120; i++)
      assert.equal(
        JSON.parse(
          engine.aot_execute(
            db,
            "add",
            aotBindings([
              BigInt(i + 1),
              i % 2 ? "a" : "A",
              i % 9 === 0 ? null : BigInt(i % 7),
              `name${i}`,
            ]),
          ),
        ).error,
        undefined,
      );
    const result = engine.aot_export_sqlite(db);
    assert.equal(JSON.parse(engine.sqlite_info(result)).error, undefined);
    outputs.push(
      Uint8Array.from(Buffer.from(engine.sqlite_data_base64(result), "base64")),
    );
  }
  assert.deepEqual(outputs[1], outputs[0]);
  const db = dynamic.database_open();
  assert.equal(
    JSON.parse(dynamic.database_import_sqlite(db, outputs[0]!)).error,
    undefined,
  );
  inspect(outputs[0]!, (native) => {
    const query =
      "SELECT id,tenant,n,label FROM t INDEXED BY feed ORDER BY tenant COLLATE BINARY,n DESC,id";
    const statement = native.prepare(query);
    statement.setReadBigInts(true);
    statement.setReturnArrays(true);
    const actual = JSON.parse(
      dynamic.database_query_values(
        db,
        query.replace(" INDEXED BY feed", ""),
        "[]",
      ),
    ).rows.map((row: Parameters<typeof aotValue>[0][]) => row.map(aotValue));
    assert.deepEqual(actual, statement.all());
  });
});

const specification = {
  schema: [
    "CREATE TABLE notes(id INTEGER PRIMARY KEY,title TEXT NOT NULL,n INTEGER)",
    "CREATE INDEX ix_title ON notes(title)",
  ],
  queries: [
    { name: "add", sql: "INSERT INTO notes VALUES(?,?,?)" },
    { name: "erase", sql: "DELETE FROM notes WHERE id=?" },
  ],
};

test("trigger schema and materialized effects survive SQLite export and re-import without firing on load", () => {
  const built = buildCatalog({
    schema: [
      "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)",
      "CREATE TABLE audit(id INTEGER PRIMARY KEY,row_id INTEGER,n INTEGER)",
      "CREATE TRIGGER ai AFTER INSERT ON t BEGIN INSERT INTO audit(row_id,n) VALUES(new.id,new.n); END",
    ],
    queries: [{ name: "add", sql: "INSERT INTO t VALUES(?,?)" }],
  });
  const db = runtime.aot_open(built.artifact, "");
  execute(db, "add", [1n, 2n]);
  execute(db, "add", [2n, 3n]);
  const bytes = image(db),
    imported = dynamic.database_open();
  assert.equal(
    JSON.parse(dynamic.database_import_sqlite(imported, bytes)).error,
    undefined,
  );
  inspect(bytes, (native) => {
    assert.equal(native.prepare("SELECT count(*) AS n FROM audit").get()!.n, 2);
    assert.equal(
      native
        .prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='trigger'")
        .get()!.n,
      1,
    );
  });
  assert.equal(
    JSON.parse(
      dynamic.database_exec(imported, "INSERT INTO t VALUES(3,4)", "[]", false),
    ).error,
    undefined,
  );
  assert.equal(
    JSON.parse(
      dynamic.database_query_values(
        imported,
        "SELECT count(*) FROM audit",
        "[]",
      ),
    ).rows[0][0].v,
    "3",
  );
});

test("native SQLite reads partial expression indexes written by MoonBit and SQLike imports them", () => {
  const source = {
    schema: [
      "CREATE TABLE t(id INTEGER PRIMARY KEY,tenant TEXT,label TEXT,live INTEGER,n INTEGER)",
      "CREATE UNIQUE INDEX uq ON t(tenant,lower(label) COLLATE NOCASE DESC) WHERE live=1",
      "CREATE INDEX ix ON t(tenant,n DESC) WHERE live=1",
    ],
    queries: [{ name: "add", sql: "INSERT INTO t VALUES(?,?,?,?,?)" }],
  };
  const built = buildCatalog(source, { pageSize: 512 }),
    db = runtime.aot_open(built.artifact, "");
  for (let i = 0; i < 100; i++)
    execute(db, "add", [
      BigInt(i + 1),
      "a",
      `Name${i}`,
      BigInt(i % 2),
      BigInt(i % 7),
    ]);
  const bytes = image(db),
    imported = dynamic.database_open();
  assert.equal(
    JSON.parse(dynamic.database_import_sqlite(imported, bytes)).error,
    undefined,
  );
  inspect(bytes, (native) => {
    for (const index of ["uq", "ix"]) {
      const query = `SELECT id,label,n FROM t INDEXED BY ${index} WHERE live=1 ORDER BY id`;
      const stmt = native.prepare(query);
      stmt.setReadBigInts(true);
      stmt.setReturnArrays(true);
      const actual = JSON.parse(
        dynamic.database_query_values(
          imported,
          query.replace(` INDEXED BY ${index}`, ""),
          "[]",
        ),
      ).rows.map((row: Parameters<typeof aotValue>[0][]) => row.map(aotValue));
      assert.deepEqual(actual, stmt.all());
    }
  });
});
function execute(
  db: ReturnType<typeof runtime.aot_open>,
  name: string,
  params: Value[],
) {
  const r = JSON.parse(
    runtime.aot_execute(db, name, JSON.stringify(params.map(pack))),
  );
  if (r.error) throw Error(r.error);
}
function image(db: ReturnType<typeof runtime.aot_open>) {
  const result = runtime.aot_export_sqlite(db);
  const info = JSON.parse(runtime.sqlite_info(result));
  if (info.error) throw Error(info.error);
  return runtime.sqlite_data(result);
}
function inspect(data: Uint8Array, verify: (db: DatabaseSync) => void) {
  const dir = mkdtempSync(join(tmpdir(), "moon-pages-"));
  try {
    const path = join(dir, "data.sqlite");
    writeFileSync(path, data);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.deepEqual(
        db.prepare("PRAGMA integrity_check").all().map(Object.values),
        [["ok"]],
      );
      assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
      verify(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
test("MoonBit writes updated data and indexes into a prebuilt native schema template", () => {
  const built = buildCatalog(specification),
    db = runtime.aot_open(built.artifact, "");
  execute(db, "add", [1n, "first", 5n]);
  execute(db, "add", [2n, "second", null]);
  const bytes = image(db);
  inspect(bytes, (native) => {
    const s = native.prepare("SELECT id,title,n FROM notes ORDER BY id");
    s.setReadBigInts(true);
    assert.deepEqual(s.all().map(Object.values), [
      [1n, "first", 5n],
      [2n, "second", null],
    ]);
    assert.deepEqual(
      native
        .prepare(
          "SELECT id FROM notes INDEXED BY ix_title WHERE title='second'",
        )
        .all()
        .map(Object.values),
      [[2]],
    );
  });
  assert.deepEqual(
    image(db),
    bytes,
    "export is deterministic without a mutation",
  );
});
test("prebuilt template generation and result metadata are validated at build time", () => {
  assert.throws(
    () =>
      buildCatalog({
        schema: ["CREATE TABLE t(n INTEGER)"],
        queries: [{ name: "bad", sql: "SELECT absent FROM t" }],
      }),
    /column|SQL build/,
  );
  assert.throws(
    () => buildCatalog(specification, { pageSize: 513 }),
    /page size/,
  );
});

test("native SQLite validates multi-level table/index B-trees, overflow, int64 rowids and all storage classes", () => {
  for (const pageSize of [512, 4096, 65536]) {
    const source = {
      schema: [
        "CREATE TABLE data(id INTEGER PRIMARY KEY,n INTEGER,r REAL,s TEXT COLLATE NOCASE,b BLOB)",
        "CREATE INDEX ix_s ON data(s)",
      ],
      queries: [{ name: "add", sql: "INSERT INTO data VALUES(?,?,?,?,?)" }],
    };
    const built = buildCatalog(source, { pageSize }),
      db = runtime.aot_open(built.artifact, "");
    const ids = [
      -9223372036854775808n,
      -9007199254740993n,
      -1n,
      0n,
      1n,
      9007199254740993n,
      9223372036854775807n,
    ];
    const expected: Value[][] = [];
    for (let i = 0; i < 220; i++) {
      const id = ids[i] ?? BigInt(i),
        blob = new Uint8Array(900 + (i % 113));
      for (let j = 0; j < blob.length; j++) blob[j] = (i * 17 + j * 31) & 255;
      const row: Value[] = [
        id,
        BigInt(i % 3 ? i : -i),
        i % 5 ? i + 0.25 : null,
        `${i % 2 ? "a" : "A"}-${String(i).padStart(4, "0")}-${"長い文字😀".repeat(80)}`,
        blob,
      ];
      execute(db, "add", row);
      expected.push(row);
    }
    expected.sort((a, b) => ((a[0] as bigint) < (b[0] as bigint) ? -1 : 1));
    inspect(image(db), (native) => {
      const statement = native.prepare(
        "SELECT id,n,r,s,b FROM data ORDER BY id",
      );
      statement.setReadBigInts(true);
      statement.setReturnArrays(true);
      assert.deepEqual(
        statement
          .all()
          .map((row) =>
            (row as unknown as Value[]).map((v) =>
              v instanceof Uint8Array ? new Uint8Array(v) : v,
            ),
          ),
        expected,
      );
      assert.equal(
        native.prepare("SELECT count(*) AS n FROM data INDEXED BY ix_s").get()!
          .n,
        220,
      );
    });
  }
});

test("native constraint and secondary index layouts survive composite keys and WITHOUT ROWID", () => {
  for (const withoutRowid of [false, true]) {
    const source = {
      schema: [
        `CREATE TABLE data(a TEXT COLLATE NOCASE,b INTEGER,c BLOB,PRIMARY KEY(a,b),UNIQUE(b,a))${withoutRowid ? " WITHOUT ROWID" : ""}`,
        "CREATE INDEX ix_b ON data(b)",
      ],
      queries: [{ name: "add", sql: "INSERT INTO data VALUES(?,?,?)" }],
    };
    const built = buildCatalog(source, { pageSize: 512 }),
      db = runtime.aot_open(built.artifact, "");
    for (let i = 0; i < 150; i++)
      execute(db, "add", [
        `k${String(i).padStart(4, "0")}`,
        BigInt(i),
        new Uint8Array(1200 + (i % 31)).fill(i),
      ]);
    inspect(image(db), (native) => {
      assert.equal(
        native.prepare("SELECT count(*) AS n FROM data").get()!.n,
        150,
      );
      assert.deepEqual(
        native
          .prepare("SELECT a,b FROM data INDEXED BY ix_b WHERE b=70")
          .all()
          .map(Object.values),
        [["k0070", 70]],
      );
    });
  }
});

test("SQLite record integer widths and zero AUTOINCREMENT history survive deleted rows", () => {
  const built = buildCatalog(
    {
      schema: [
        "CREATE TABLE numbers(id INTEGER PRIMARY KEY AUTOINCREMENT,n INTEGER,b BLOB)",
      ],
      queries: [
        { name: "add", sql: "INSERT INTO numbers VALUES(?,?,?)" },
        { name: "erase", sql: "DELETE FROM numbers" },
      ],
    },
    { pageSize: 512 },
  );
  const db = runtime.aot_open(built.artifact, "");
  const values = [
    -9223372036854775808n,
    -140737488355329n,
    -140737488355328n,
    -2147483649n,
    -2147483648n,
    -8388609n,
    -8388608n,
    -32769n,
    -32768n,
    -129n,
    -128n,
    -1n,
    0n,
    1n,
    127n,
    128n,
    32767n,
    32768n,
    8388607n,
    8388608n,
    2147483647n,
    2147483648n,
    140737488355327n,
    140737488355328n,
    9223372036854775807n,
  ];
  for (const [i, n] of values.entries())
    execute(db, "add", [BigInt(i + 1), n, new Uint8Array()]);
  inspect(image(db), (native) => {
    const s = native.prepare("SELECT n,length(b) FROM numbers ORDER BY id");
    s.setReadBigInts(true);
    assert.deepEqual(
      s.all().map(Object.values),
      values.map((n) => [n, 0n]),
    );
  });
  const fresh = runtime.aot_open(built.artifact, "");
  execute(fresh, "add", [0n, 1n, null]);
  execute(fresh, "erase", []);
  inspect(image(fresh), (native) => {
    const s = native.prepare("SELECT name,seq FROM sqlite_sequence");
    s.setReadBigInts(true);
    assert.deepEqual(s.all().map(Object.values), [["numbers", 0n]]);
  });
});
