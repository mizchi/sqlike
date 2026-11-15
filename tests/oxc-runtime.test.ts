import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "vite";
import { minifyRuntime } from "../scripts/oxc-runtime.ts";
import { buildSqlikeRuntime } from "../scripts/build-sqlike-runtime.ts";
import { defineSqlike, allSqlikeFeatures } from "../src/sqlike-features.ts";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import { buildDefinedCatalog } from "../scripts/defined-compiler.ts";
import { createDefinedDatabase } from "../adapters/defined-database-core.ts";
import { openCompiled, openSql } from "../src/sqlike-runtime.ts";
import type { Value } from "../src/contract.ts";

test("Oxc preserves public names, property keys and annotations for downstream tree shaking", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sqlike-oxc-annotation-"));
  try {
    const entry = join(dir, "entry.mjs");
    await writeFile(
      entry,
      `/*! fixture license */
export function stableName(value) { return { schemaId: value, "requiredFeatures": 7 }; }
export const optional = /* @__PURE__ */ new Uint8Array(4096);
`,
    );
    const code = await minifyRuntime(entry, ["stableName", "optional"]);
    assert.match(code, /fixture license/);
    assert.match(code, /[@#]__PURE__/);
    const minified = join(dir, "minified.mjs");
    await writeFile(minified, code);
    const runtime = await import(pathToFileURL(minified).href);
    assert.deepEqual(Object.keys(runtime).sort(), ["optional", "stableName"]);
    assert.deepEqual(runtime.stableName("ok"), {
      schemaId: "ok",
      requiredFeatures: 7,
    });
    assert.ok(Object.is(runtime.stableName(-0).schemaId, -0));
    assert.equal(runtime.optional.length, 4096);
    await assert.rejects(minifyRuntime(entry, ["wrongPublicName"]), /exports/);
    const consumer = join(dir, "consumer.mjs");
    await writeFile(consumer, 'export {stableName} from "./minified.mjs";');
    const second = await build({
      configFile: false,
      publicDir: false,
      logLevel: "silent",
      input: consumer,
      build: {
        write: false,
        minify: "oxc",
        target: "esnext",
        rolldownOptions: { preserveEntrySignatures: "strict" },
      },
    });
    const output = Array.isArray(second) ? second[0]! : second;
    assert.ok("output" in output);
    const chunk = output.output.find((o) => o.type === "chunk");
    assert.ok(chunk?.type === "chunk");
    assert.deepEqual(chunk.exports, ["stableName"]);
    assert.doesNotMatch(chunk.code, /Uint8Array|4096/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("selected JS defaults to Oxc in every mode and matches native typed SQL", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sqlike-oxc-runtime-"));
  const schema = [
    "CREATE TABLE t(id INTEGER PRIMARY KEY,r REAL,b BLOB,v TEXT)",
  ];
  const queries = [
    { name: "add", sql: "INSERT INTO t VALUES(?,?,?,?) RETURNING id,r,b,v" },
    { name: "get", sql: "SELECT id,r,b,v FROM t ORDER BY id" },
    {
      name: "functions",
      sql: "SELECT json_array(9007199254740993) AS j,date('2000-02-28','+1 day') AS d,row_number() OVER () AS w",
    },
    {
      name: "cast",
      sql: "SELECT CAST('9007199254740993' AS INTEGER) AS i,CAST('12.5' AS REAL) AS r",
    },
  ];
  try {
    const features = allSqlikeFeatures.filter(
      (f) => !["binarySync", "sqlitePages", "ltx"].includes(f.name),
    );
    for (const mode of ["aot", "defined", "sql"] as const) {
      const profile = defineSqlike({ mode, features });
      const built = await buildSqlikeRuntime(profile, {
        outDir: join(dir, mode),
        targets: ["js"],
      });
      const text = await readFile(join(built.directory, "runtime.js"), "utf8");
      assert.ok(text.split("\n").length < 15, "whitespace is compacted");
      assert.doesNotMatch(text, /function _M0/);
      assert.equal(
        JSON.parse(
          await readFile(join(built.directory, "profile.json"), "utf8"),
        ).minify,
        "oxc",
      );
      const runtime = await import(
        pathToFileURL(join(built.directory, "runtime.js")).href
      );
      assert.deepEqual(Object.keys(runtime).sort(), [...built.exports].sort());
      const native = new DatabaseSync(":memory:");
      native.exec(schema[0]!);
      let execute: (name: string, params?: Value[]) => Promise<Value[][]>;
      let close = async () => {};
      if (mode === "defined") {
        const db = await createDefinedDatabase(runtime).memory(
          buildDefinedCatalog({ schema, queries }),
        );
        execute = async (name, params = []) =>
          (await db.execute(name, params)).rows;
        close = () => db.close();
      } else if (mode === "aot") {
        const db = openCompiled(
          runtime,
          buildCatalog({ schema, queries }).artifact,
        );
        execute = async (name, params = []) => db.execute(name, params).rows;
      } else {
        const db = openSql(runtime);
        db.run(schema[0]!);
        execute = async (name, params = []) =>
          db
            .all(queries.find((q) => q.name === name)!.sql, params)
            .map((r) => Object.values(r));
        close = async () => db.close();
      }
      const expected = (name: string, params: Value[] = []) => {
        const stmt = native.prepare(queries.find((q) => q.name === name)!.sql);
        stmt.setReadBigInts(true);
        stmt.setReturnArrays(true);
        return stmt.all(...params);
      };
      try {
        const params = [
          9007199254740993n,
          12.5,
          new Uint8Array([0, 255]),
          "\ufeffa\0b",
        ];
        assert.deepEqual(await execute("add", params), expected("add", params));
        for (const q of queries.slice(1))
          assert.deepEqual(
            await execute(q.name),
            expected(q.name),
            `${mode}/${q.name}`,
          );
        await assert.rejects(execute("add", params), /UNIQUE|constraint/i);
        assert.deepEqual(await execute("get"), expected("get"));
      } finally {
        await close();
        native.close();
      }
    }
    const raw = await buildSqlikeRuntime(defineSqlike({ mode: "defined" }), {
      outDir: join(dir, "raw"),
      targets: ["js"],
      minify: false,
    });
    assert.match(
      await readFile(join(raw.directory, "runtime.js"), "utf8"),
      /function _M0/,
    );
    assert.equal(
      JSON.parse(await readFile(join(raw.directory, "profile.json"), "utf8"))
        .minify,
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
