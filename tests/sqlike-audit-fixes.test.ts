import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as sql from "../_build/js/release/build/mizchi/sqlike/full/full.js";
import * as aot from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import * as compiler from "../_build/js/release/build/mizchi/sqlike/compiler/compiler.js";
import {
  dynamicDriver,
  compiledDriver,
  type DifferentialRuntime,
} from "./compatibility/differential-runtime.ts";
import { oracleDriver } from "./compatibility/differential-node.ts";
import { runTrace, compareTraces } from "./compatibility/differential-core.ts";
import { auditFixCorpus } from "./compatibility/audit-fix-corpus.ts";
import { MoonDatabase } from "../adapters/moon-database.ts";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aotValue } from "../src/aot-values.ts";

const cases = auditFixCorpus();

test("audit fixes preserve boundary behavior across JS/Wasm and SQL/AOT", async () => {
  const options = { builtins: ["js-string"], importedStringConstants: "_" };
  const wasmSQL = (
    await WebAssembly.instantiate(
      readFileSync("_build/wasm-gc/release/build/mizchi/sqlike/full/full.wasm"),
      {},
      options,
    )
  ).instance.exports as unknown as typeof sql;
  const wasmAOT = (
    await WebAssembly.instantiate(
      readFileSync(
        "_build/wasm-gc/release/build/mizchi/litestream-example/runtime/runtime.wasm",
      ),
      {},
      options,
    )
  ).instance.exports as unknown as typeof aot;
  const failures: unknown[] = [];
  for (const c of cases) {
    const native = oracleDriver();
    const expected = await runTrace(c, native);
    native.close();
    for (const r of [
      { sql, aot, compile: compiler.compile_program },
      { sql: wasmSQL, aot: wasmAOT, compile: compiler.compile_program },
    ] satisfies DifferentialRuntime[]) {
      for (const [d, schema] of [
        [dynamicDriver(r.sql), true],
        [compiledDriver(r.aot, c, r.compile), false],
      ] as const) {
        const actual = await runTrace(c, d, { schema });
        assert.equal(actual.setupFailed, false);
        const differences = compareTraces(
          { ...expected, setup: [] },
          { ...actual, setup: [] },
        );
        if (differences.length) failures.push({ c, differences });
        d.close();
      }
    }
  }
  assert.equal(failures.length, 0, JSON.stringify(failures));
});

test("infinite REAL survives logical images and native SQLite export", () => {
  const db = new MoonDatabase();
  db.run("CREATE TABLE t(id INTEGER PRIMARY KEY,v REAL)");
  db.run("INSERT INTO t VALUES(1,1e999),(2,-1e999)");
  const image = db.dump();
  assert.deepEqual(
    new MoonDatabase(image).queryValues("SELECT v FROM t ORDER BY id"),
    [[Infinity], [-Infinity]],
  );
  assert.deepEqual(db.queryValues("SELECT 1e999-1e999,1e999*0"), [
    [null, null],
  ]);
  const raw = sql.database_open();
  assert.equal(JSON.parse(sql.database_restore(raw, image)).error, undefined);
  const built = buildCatalog({
    schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,v REAL)"],
    queries: [
      { name: "write", sql: "INSERT INTO t VALUES(1,1e999),(2,-1e999)" },
    ],
  });
  const compiled = aot.aot_open(built.artifact, "");
  assert.equal(
    JSON.parse(aot.aot_execute(compiled, "write", "[]")).error,
    undefined,
  );
  const exported = aot.aot_export_sqlite(compiled);
  assert.equal(JSON.parse(aot.sqlite_info(exported)).error, undefined);
  const bytes = Buffer.from(aot.sqlite_data_base64(exported), "base64");
  const dir = mkdtempSync(join(tmpdir(), "sqlike-real-"));
  try {
    const file = join(dir, "test.sqlite");
    writeFileSync(file, bytes);
    const native = new DatabaseSync(file);
    try {
      assert.deepEqual(
        native
          .prepare("SELECT v FROM t ORDER BY id")
          .all()
          .map((r) => r.v),
        [Infinity, -Infinity],
      );
      assert.equal(
        native.prepare("PRAGMA integrity_check").get()?.integrity_check,
        "ok",
      );
    } finally {
      native.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // The binary reader must accept IEEE infinity too.
  const imported = sql.database_open();
  assert.equal(
    JSON.parse(sql.database_import_sqlite(imported, bytes)).error,
    undefined,
  );
  const result = JSON.parse(
    sql.database_query_values(imported, "SELECT v FROM t ORDER BY id", "[]"),
  );
  assert.deepEqual(
    result.rows.map((row: any[]) => row.map(aotValue)),
    [[Infinity], [-Infinity]],
  );
});

test("persistent Moon adapter preserves connection counters after failed writes and host rollback", () => {
  let commits = 0;
  const db = new MoonDatabase(undefined, () => {
    commits++;
  });
  db.run("CREATE TABLE t(id INTEGER PRIMARY KEY,v NOT NULL)");
  db.run("INSERT INTO t VALUES(1,1)");
  const before = commits;
  assert.throws(() => db.run("INSERT INTO t VALUES(2,2),(3,NULL)"), /NOT NULL/);
  assert.equal(commits, before);
  assert.deepEqual(db.queryValues("SELECT last_insert_rowid(),changes()"), [
    [2n, 0n],
  ]);
  assert.throws(
    () =>
      db.transaction(() => {
        db.run("INSERT INTO t VALUES(7,7)");
        throw Error("abort");
      }),
    /abort/,
  );
  assert.deepEqual(db.queryValues("SELECT last_insert_rowid(),changes()"), [
    [7n, 1n],
  ]);
  assert.deepEqual(db.queryValues("SELECT * FROM t"), [[1n, 1n]]);
});

test("AOT persistence keeps failed-insert counters without publishing rolled-back rows", async () => {
  const { AotDatabase } = await import("../adapters/aot-database.ts");
  const built = buildCatalog({
    schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,v NOT NULL)"],
    queries: [
      { name: "add", sql: "INSERT INTO t VALUES(1,1)" },
      { name: "fail", sql: "INSERT INTO t VALUES(2,2),(3,NULL)" },
      { name: "meta", sql: "SELECT last_insert_rowid(),changes()" },
      { name: "all", sql: "SELECT * FROM t" },
    ],
  });
  let generation = 0,
    image: string | undefined;
  const store = {
    async read() {
      return { generation, image };
    },
    async commit(expected: number, next: string) {
      assert.equal(expected, generation);
      image = next;
      return ++generation;
    },
    close() {},
  };
  const db = await AotDatabase.withStore(
    built.artifact,
    built.manifest.artifactSHA256,
    store,
  );
  try {
    await db.execute("add");
    const before = generation;
    await assert.rejects(db.execute("fail"), /NOT NULL/);
    assert.equal(generation, before);
    assert.deepEqual((await db.inspect("meta")).rows, [[2n, 0n]]);
    assert.deepEqual((await db.inspect("all")).rows, [[1n, 1n]]);
  } finally {
    await db.close();
  }
});

test("injected SQL/AOT host transactions preserve SQLite connection counters", async () => {
  const { openSql, openCompiled } = await import("../src/sqlike-runtime.ts");
  const schema = ["CREATE TABLE t(id INTEGER PRIMARY KEY)"];
  const built = buildCatalog({
    schema,
    queries: [
      { name: "add", sql: "INSERT INTO t VALUES(7)" },
      { name: "meta", sql: "SELECT last_insert_rowid(),changes()" },
      { name: "all", sql: "SELECT * FROM t" },
    ],
  });
  const compiled = openCompiled(aot, built.artifact),
    dynamic = openSql(sql);
  dynamic.run(schema[0]!);
  for (const db of [
    {
      transaction: compiled.transaction,
      write: () => compiled.execute("add"),
      meta: () => compiled.execute("meta").rows,
      rows: () => compiled.execute("all").rows,
    },
    {
      transaction: dynamic.transaction.bind(dynamic),
      write: () => dynamic.run("INSERT INTO t VALUES(7)"),
      meta: () =>
        Object.values(
          dynamic.query("SELECT last_insert_rowid(),changes()")[0]!,
        ),
      rows: () => dynamic.query("SELECT * FROM t"),
    },
  ]) {
    assert.throws(
      () =>
        db.transaction(() => {
          db.write();
          throw Error("rollback");
        }),
      /rollback/,
    );
    const actual = db.meta();
    assert.deepEqual(actual, Array.isArray(actual[0]) ? [[7n, 1n]] : [7n, 1n]);
    assert.deepEqual(db.rows(), []);
  }
  assert.throws(
    () => aotValue({ t: "real", v: "invalid" } as any),
    /invalid REAL/,
  );
});
