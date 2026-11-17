import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  defineSqlike,
  strictTables,
  triggers,
  foreignKeys,
  rightFullJoin,
  primaryKeyIndex,
} from "../src/sqlike-features.ts";
import { buildSqlikeRuntime } from "../scripts/build-sqlike-runtime.ts";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import { openCompiled, openSql } from "../src/sqlike-runtime.ts";
test("selected JS/Wasm AOT runtimes reject omitted features and never include the SQL parser", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sqlike-profiles-test-"));
  try {
    const minimal = await buildSqlikeRuntime(defineSqlike(), {
      outDir: join(dir, "minimal"),
      minify: false,
    });
    const full = await buildSqlikeRuntime(
      defineSqlike({
        features: [
          strictTables,
          triggers,
          foreignKeys,
          rightFullJoin,
          primaryKeyIndex,
        ],
      }),
      { outDir: join(dir, "full"), minify: false },
    );
    const basic = buildCatalog({
      schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT)"],
      queries: [
        { name: "add", sql: "INSERT INTO t VALUES(?,?)" },
        { name: "get", sql: "SELECT v FROM t WHERE id=?" },
      ],
    }).artifact;
    const disabled = [
      buildCatalog({
        schema: [
          "CREATE TABLE t(id INTEGER PRIMARY KEY)",
          "CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END",
        ],
        queries: [],
      }).artifact,
      buildCatalog({
        schema: [
          "CREATE TABLE p(id INTEGER PRIMARY KEY)",
          "CREATE TABLE c(id INTEGER PRIMARY KEY,p INTEGER REFERENCES p(id))",
        ],
        queries: [],
      }).artifact,
      buildCatalog({
        schema: ["CREATE TABLE a(id INTEGER)", "CREATE TABLE b(id INTEGER)"],
        queries: [
          {
            name: "q",
            sql: "SELECT a.id,b.id FROM a FULL JOIN b ON a.id=b.id",
          },
        ],
      }).artifact,
    ];
    const strict = buildCatalog({
      schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,v INT) STRICT"],
      queries: [{ name: "add", sql: "INSERT INTO t VALUES(?,?)" }],
    }).artifact;
    for (const built of [minimal, full]) {
      const js = await readFile(join(built.directory, "runtime.js"), "utf8");
      for (const marker of [
        "foreign key cascade depth limit",
        "datatype constraint failed",
        "cannot join using column",
      ])
        assert.equal(js.includes(marker), built !== minimal, marker);
      assert.equal(
        /function [^\n]*primary__value__key\(/.test(js),
        built !== minimal,
      );
      assert.doesNotMatch(
        js,
        /SQL syntax: expected|unterminated SQL quote|unterminated SQL comment/,
      );
      assert.doesNotMatch(js, /function [^\n]*parse__statement\(/);
      const declarations = await readFile(
        join(built.directory, "runtime.d.ts"),
        "utf8",
      );
      assert.match(declarations, /export function aot_execute/);
      assert.doesNotMatch(declarations, /export function database_exec/);
      const runtimes = [
        await import(pathToFileURL(join(built.directory, "runtime.js")).href),
        (
          await WebAssembly.instantiate(
            await readFile(join(built.directory, "runtime.wasm")),
            {},
            { builtins: ["js-string"], importedStringConstants: "_" },
          )
        ).instance.exports,
      ];
      for (const runtime of runtimes) {
        const db = openCompiled(runtime, basic);
        db.execute("add", [1n, "ok"]);
        assert.deepEqual(db.execute("get", [1n]).rows, [["ok"]]);
        if (built === minimal) {
          for (const artifact of disabled)
            assert.throws(
              () => openCompiled(runtime, artifact),
              /feature disabled/,
            );
        }
        if (built === minimal)
          assert.throws(
            () => openCompiled(runtime, strict),
            /feature disabled: strictTables/,
          );
        else
          assert.throws(
            () => openCompiled(runtime, strict).execute("add", [1n, "bad"]),
            /datatype/,
          );
      }
    }
    assert.ok(
      (await readFile(join(minimal.directory, "runtime.js"))).length <
        (await readFile(join(full.directory, "runtime.js"))).length,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("selected SQL driver enables native capture only with binarySync and retains transaction rollback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sqlike-selected-sql-"));
  try {
    for (const enabled of [false, true]) {
      const { directory } = await buildSqlikeRuntime(
        defineSqlike({
          mode: "sql",
          features: enabled
            ? [{ name: "binarySync" }, triggers, foreignKeys, primaryKeyIndex]
            : [],
        }),
        { outDir: join(dir, String(enabled)) },
      );
      const runtimes = [
        await import(pathToFileURL(join(directory, "runtime.js")).href),
        (
          await WebAssembly.instantiate(
            await readFile(join(directory, "runtime.wasm")),
            {},
            { builtins: ["js-string"], importedStringConstants: "_" },
          )
        ).instance.exports,
      ];
      for (const r of runtimes) {
        const db = openSql(r as any, undefined, { statementCache: { capacity: 8 } });
        assert.equal(typeof db.capture, enabled ? "function" : "undefined");
        db.run("CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT)");
        assert.throws(
          () =>
            db.transaction(() => {
              db.run("INSERT INTO t VALUES(1,'a')");
              throw Error("abort");
            }),
          /abort/,
        );
        assert.equal(db.all("SELECT * FROM t").length, 0);
        if (enabled) {
          const bytes = db.capture!(() =>
            db.run("INSERT INTO t VALUES(1,'a')"),
          );
          assert.ok(bytes.length > 0);
        } else
          assert.throws(
            () => db.run("CREATE TABLE p(id INTEGER PRIMARY KEY) STRICT"),
            /feature disabled/,
          );
        db.close();
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("selected STRICT AOT pages and portable LTX bridge are identical on JS and Wasm", async () => {
  const { sqlitePages, ltx } = await import("../src/sqlike-features.ts");
  const dir = await mkdtemp(join(tmpdir(), "sqlike-selected-ltx-"));
  try {
    await buildSqlikeRuntime(
      defineSqlike({ features: [strictTables, sqlitePages, ltx] }),
      { outDir: dir },
    );
    const js = await import(pathToFileURL(join(dir, "runtime.js")).href);
    const { instance } = await WebAssembly.instantiate(
      await readFile(join(dir, "runtime.wasm")),
      {},
      { builtins: ["js-string"], importedStringConstants: "_" },
    );
    const built = buildCatalog({
      schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,v ANY) STRICT"],
      queries: [{ name: "add", sql: "INSERT INTO t VALUES(1,'000123')" }],
    });
    const outputs = [];
    for (const r of [js, instance.exports as any]) {
      const db = r.aot_open(built.artifact, "");
      assert.equal(JSON.parse(r.aot_execute(db, "add", "[]")).error, undefined);
      const result = r.aot_export_sqlite(db);
      assert.equal(JSON.parse(r.sqlite_info(result)).error, undefined);
      const image = r.sqlite_data_base64(result);
      const file = r.encode_ltx_base64("", image, "1", "1", "0");
      assert.equal(JSON.parse(r.ltx_info(file)).error, undefined);
      const restored = r.apply_ltx_base64("", "0", r.ltx_data_base64(file), 3);
      assert.equal(JSON.parse(r.ltx_info(restored)).error, undefined);
      assert.equal(r.ltx_data_base64(restored), image);
      outputs.push({ image, file: r.ltx_data_base64(file) });
    }
    assert.deepEqual(outputs[0], outputs[1]);
    const path = join(dir, "strict.sqlite");
    await writeFile(path, Buffer.from(outputs[0]!.image, "base64"));
    const native = new DatabaseSync(path);
    try {
      assert.equal(
        native.prepare("PRAGMA integrity_check").get()!.integrity_check,
        "ok",
      );
      assert.equal(native.prepare("SELECT v FROM t").get()!.v, "000123");
      assert.equal(
        native
          .prepare("SELECT strict FROM pragma_table_list WHERE name='t'")
          .get()!.strict,
        1,
      );
    } finally {
      native.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
