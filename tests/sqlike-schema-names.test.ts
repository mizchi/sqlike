import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as sql from "../_build/js/release/build/mizchi/sqlike/full/full.js";
import { MoonDatabase } from "../adapters/moon-database.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "./compatibility/native-values.ts";
import { buildDefinedCatalog } from "../scripts/defined-compiler.ts";
import { DefinedDatabase } from "../adapters/defined-database.ts";
import { exportDefinedSQLite } from "../adapters/defined-sqlite.ts";
import { definedWasm } from "../adapters/defined-wasm.ts";

async function runtimes() {
  const wasm = (
    await WebAssembly.instantiate(
      readFileSync("_build/wasm-gc/release/build/mizchi/sqlike/full/full.wasm"),
      {},
      { builtins: ["js-string"], importedStringConstants: "_" },
    )
  ).instance.exports as unknown as typeof sql;
  return [
    sql,
    {
      ...wasm,
      database_import_sqlite: (
        db: Parameters<typeof sql.database_import_sqlite>[0],
        image: Uint8Array,
      ) =>
        wasm.database_import_sqlite_base64(
          db,
          Buffer.from(image).toString("base64"),
        ),
    },
  ];
}

test("IF NOT EXISTS observes table/view/index and the separate trigger namespace", async () => {
  const existing = [
    "CREATE TABLE same(a)",
    "CREATE VIEW same AS SELECT 1",
    "CREATE INDEX same ON t(a)",
    "CREATE TRIGGER same AFTER INSERT ON t BEGIN SELECT 1; END",
  ];
  const statements = [
    "CREATE TABLE IF NOT EXISTS same(b)",
    "CREATE VIEW IF NOT EXISTS same AS SELECT 2",
    "CREATE INDEX IF NOT EXISTS same ON t(a)",
    "CREATE TRIGGER IF NOT EXISTS same AFTER INSERT ON t BEGIN SELECT 2; END",
    "CREATE TABLE IF NOT EXISTS same AS SELECT 3 AS c",
  ];
  for (const raw of await runtimes())
    for (const initial of existing)
      for (const statement of statements) {
        const moon = new MoonDatabase(undefined, undefined, raw),
          native = new NodeDatabase(":memory:");
        try {
          for (const setup of ["CREATE TABLE t(a)", initial]) {
            moon.run(setup);
            native.raw.exec(setup);
          }
          const before = moon.dump();
          let failed = false;
          try {
            native.raw.exec(statement);
          } catch {
            failed = true;
          }
          if (failed) {
            assert.throws(() => moon.run(statement), Error, statement);
            assert.equal(moon.dump(), before);
          } else moon.run(statement);
          const query =
            "SELECT type,name,tbl_name FROM sqlite_schema ORDER BY type,name";
          assert.deepEqual(
            moon.values(query),
            nativeValues(native, query),
            `${initial}: ${statement}`,
          );
          assert.deepEqual(
            new MoonDatabase(moon.dump(), undefined, raw).values(query),
            moon.values(query),
          );
        } finally {
          moon.close();
          native.close();
        }
      }
});

test("DROP TABLE/VIEW IF EXISTS still rejects an object of the other kind", async () => {
  for (const raw of await runtimes())
    for (const [initial, statement] of [
      ["CREATE TABLE x(a)", "DROP VIEW IF EXISTS x"],
      ["CREATE VIEW x AS SELECT 1", "DROP TABLE IF EXISTS x"],
    ]) {
      const moon = new MoonDatabase(undefined, undefined, raw),
        native = new NodeDatabase(":memory:");
      try {
        moon.run(initial!);
        native.raw.exec(initial!);
        const before = moon.dump();
        assert.throws(() => native.raw.exec(statement!));
        assert.throws(() => moon.run(statement!));
        assert.equal(moon.dump(), before);
      } finally {
        moon.close();
        native.close();
      }
    }
});

test("user DDL rejects SQLite reserved names without publishing schema", async () => {
  for (const raw of await runtimes()) {
    const moon = new MoonDatabase(undefined, undefined, raw),
      native = new NodeDatabase(":memory:");
    try {
      moon.run("CREATE TABLE t(a)");
      native.raw.exec("CREATE TABLE t(a)");
      for (const statement of [
        "CREATE TABLE sqlite_x(a)",
        "CREATE TABLE SQLite_x AS SELECT 1",
        "CREATE VIEW sqlite_x AS SELECT 1",
        "CREATE INDEX sqlite_x ON t(a)",
        "CREATE TRIGGER sqlite_x AFTER INSERT ON t BEGIN SELECT 1; END",
      ]) {
        const before = moon.dump();
        assert.throws(() => native.raw.exec(statement));
        assert.throws(() => moon.run(statement));
        assert.equal(moon.dump(), before);
      }
    } finally {
      moon.close();
      native.close();
    }
  }
});

test("same-name trigger and table survive SQLite export/import and trigger dispatch", async () => {
  const source = {
    schema: [
      "CREATE TABLE t(a)",
      "CREATE TABLE audit(a)",
      "CREATE TRIGGER t AFTER INSERT ON t BEGIN INSERT INTO audit VALUES(new.a); END",
    ],
    queries: [
      { name: "add", sql: "INSERT INTO t VALUES(7)" },
      { name: "read", sql: "SELECT * FROM audit ORDER BY a" },
    ],
  };
  const catalog = buildDefinedCatalog(source, { sqliteExport: true });
  const binaryWasm = definedWasm(
    (
      await WebAssembly.instantiate(
        readFileSync(
          "_build/wasm-gc/release/build/mizchi/sqlike/defined/defined.wasm",
        ),
        {},
        { builtins: ["js-string"], importedStringConstants: "_" },
      )
    ).instance.exports,
  );
  for (const [i, raw] of (await runtimes()).entries()) {
    const binary = await DefinedDatabase.memory(
        catalog,
        i === 0 ? {} : { runtime: binaryWasm },
      ),
      native = new NodeDatabase(":memory:");
    try {
      for (const statement of [...source.schema, source.queries[0]!.sql])
        native.raw.exec(statement);
      await binary.execute("add");
      const image = await binary.snapshot();
      const reopened = await DefinedDatabase.memory(catalog, { image });
      try {
        assert.deepEqual((await reopened.execute("read")).rows, [[7n]]);
      } finally {
        await reopened.close();
      }
      const restored = MoonDatabase.fromSQLite(
        await exportDefinedSQLite(catalog, image),
        raw,
      );
      try {
        restored.run("INSERT INTO t VALUES(8)");
        native.raw.exec("INSERT INTO t VALUES(8)");
        assert.deepEqual(
          restored.values("SELECT * FROM audit ORDER BY a"),
          nativeValues(native, "SELECT * FROM audit ORDER BY a"),
        );
        restored.run("DROP TRIGGER t");
        restored.run("INSERT INTO t VALUES(9)");
        assert.deepEqual(restored.values("SELECT * FROM audit ORDER BY a"), [
          [7n],
          [8n],
        ]);
      } finally {
        restored.close();
      }
    } finally {
      await binary.close();
      native.close();
    }
  }
});
