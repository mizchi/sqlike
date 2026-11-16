import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "vite";
import { defineSqlike, allSqlikeFeatures } from "../src/sqlike-features.ts";
import { buildSqlikeRuntime } from "../scripts/build-sqlike-runtime.ts";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import { buildDefinedCatalog } from "../scripts/defined-compiler.ts";
import { openCompiled, openSql } from "../src/sqlike-runtime.ts";
import { definedWasm } from "../adapters/defined-wasm.ts";
import type { CatalogSource } from "../src/aot-contract.ts";

const optional = [
  "sqlJson",
  "dateTime",
  "windowFunctions",
  "schemaMetadata",
  "aggregateFilter",
] as const;
const schema = ["CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT)"];
const cases: {
  feature: (typeof optional)[number];
  bit: number;
  source: CatalogSource;
}[] = [
  ...["sum(id) FILTER(WHERE id>1)", "CASE WHEN 0 THEN count(*) FILTER(WHERE id>1) ELSE 1 END"].map(
    (expression) => ({
      feature: "aggregateFilter" as const,
      bit: 256,
      source: { schema, queries: [{ name: "q", sql: `SELECT ${expression} FROM t WHERE 0` }] },
    }),
  ),
  {
    feature: "aggregateFilter",
    bit: 256,
    source: {
      schema: [...schema, "CREATE VIEW filtered AS SELECT count(*) FILTER(WHERE id>1) AS n FROM t"],
      queries: [],
    },
  },
  {
    feature: "schemaMetadata",
    bit: 128,
    source: { schema, queries: [{ name: "q", sql: "PRAGMA index_list(t)" }] },
  },
  ...[
    "json('{\"n\":9007199254740993}')",
    "json_extract(v,'$.n')",
    "CASE WHEN 0 THEN json_array(1) ELSE 1 END",
    "(SELECT json_quote(v))",
    "v -> '$.n'",
    "v ->> '$.n'",
    "CASE WHEN 0 THEN v -> '$.n' ELSE 1 END",
    "json_group_array(v)",
    "json_group_object(id,v)",
  ].map((e) => ({
    feature: "sqlJson" as const,
    bit: 16,
    source: {
      schema,
      queries: [{ name: "q", sql: `SELECT ${e} FROM t WHERE 0` }],
    },
  })),
  ...["date('2000-01-01','+1 day')", "CURRENT_TIMESTAMP", "strftime('%Y',v)"].map((e) => ({
    feature: "dateTime" as const,
    bit: 32,
    source: {
      schema,
      queries: [{ name: "q", sql: `SELECT ${e} FROM t WHERE 0` }],
    },
  })),
  ...["row_number() OVER (ORDER BY id)", "sum(id) OVER (ORDER BY id ROWS 1 PRECEDING)"].map(
    (e) => ({
      feature: "windowFunctions" as const,
      bit: 64,
      source: { schema, queries: [{ name: "q", sql: `SELECT ${e} FROM t` }] },
    }),
  ),
  {
    feature: "dateTime",
    bit: 32,
    source: {
      schema: ["CREATE TABLE t(v TEXT DEFAULT CURRENT_TIMESTAMP)"],
      queries: [],
    },
  },
  {
    feature: "sqlJson",
    bit: 16,
    source: {
      schema: ["CREATE TABLE t(v TEXT CHECK(json_valid(v)))"],
      queries: [],
    },
  },
  {
    feature: "dateTime",
    bit: 32,
    source: {
      schema: [...schema, "CREATE VIEW vv AS SELECT datetime(v) FROM t"],
      queries: [],
    },
  },
  {
    feature: "windowFunctions",
    bit: 64,
    source: {
      schema: [...schema, "CREATE VIEW vv AS SELECT row_number() OVER () FROM t"],
      queries: [],
    },
  },
  {
    feature: "sqlJson",
    bit: 16,
    source: {
      schema: [
        ...schema,
        "CREATE TRIGGER tr AFTER INSERT ON t WHEN json_valid(NEW.v) BEGIN SELECT 1; END",
      ],
      queries: [],
    },
  },
  {
    feature: "dateTime",
    bit: 32,
    source: {
      schema: [...schema, "CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT date(NEW.v); END"],
      queries: [],
    },
  },
];

test("optional execution features reject at load, including unused schema expressions, on JS/Wasm", async () => {
  for (const name of optional)
    assert.ok(
      allSqlikeFeatures.some((f) => f.name === name),
      name,
    );
  const fixtures = cases.map((c) => ({
    ...c,
    legacy: buildCatalog(c.source).artifact,
    binary: buildDefinedCatalog(c.source),
  }));
  for (const f of fixtures) {
    const flags =
      new DataView(f.binary.schema.buffer).getUint32(8, true) |
      new DataView(f.binary.statements.buffer).getUint32(8, true);
    assert.equal(flags & f.bit, f.bit, JSON.stringify(f.source));
  }
  const dir = await mkdtemp(join(tmpdir(), "sqlike-optional-test-"));
  try {
    const execution = allSqlikeFeatures.filter(
      (f) => !["binarySync", "sqlitePages", "ltx"].includes(f.name),
    );
    const base = execution.filter((f) => !optional.includes(f.name as any));
    for (const mode of ["aot", "defined", "sql"] as const) {
      for (const enabled of [false, true]) {
        const built = await buildSqlikeRuntime(
          defineSqlike({ mode, features: enabled ? execution : base }),
          { outDir: join(dir, `${mode}-${enabled}`), minify: false },
        );
        const code = await readFile(join(built.directory, "runtime.js"), "utf8");
        for (const symbol of [
          "datetime__call",
          "json__call",
          "compute__windows",
          "index__metadata",
        ])
          assert.equal(new RegExp(`function [^\\n]*${symbol}\\(`).test(code), enabled, symbol);
        if (mode !== "sql") {
          assert.doesNotMatch(code, /function [^\n]*parse__statement\(/);
          assert.doesNotMatch(code, /function [^\n]*sql__(digits|number)\(/);
        }
        assert.equal(code.includes("invalid aggregate FILTER"), enabled);
        const js = await import(pathToFileURL(join(built.directory, "runtime.js")).href);
        const wasm = (
          await WebAssembly.instantiate(
            await readFile(join(built.directory, "runtime.wasm")),
            {},
            { builtins: ["js-string"], importedStringConstants: "_" },
          )
        ).instance.exports;
        for (const raw of [js, wasm]) {
          if (mode === "defined") {
            const { createDefinedDatabase } = await import("../adapters/defined-database-core.ts");
            const DB = createDefinedDatabase(raw === js ? js : definedWasm(wasm));
            for (const f of fixtures) {
              if (enabled) (await DB.memory(f.binary)).close();
              else
                await assert.rejects(
                  DB.memory(f.binary),
                  /required feature|feature disabled/,
                  JSON.stringify(f.source),
                );
            }
          } else if (mode === "aot") {
            for (const f of fixtures) {
              if (enabled) openCompiled(raw as any, f.legacy);
              else
                assert.throws(
                  () => openCompiled(raw as any, f.legacy),
                  /feature disabled/,
                  JSON.stringify(f.source),
                );
            }
          } else {
            const db = openSql(raw as any);
            db.run(schema[0]!);
            if (!enabled) {
              for (const f of fixtures.filter((f) => f.source.queries.length))
                assert.throws(() => db.all(f.source.queries[0]!.sql), /feature disabled/);
              assert.throws(
                () => db.run("CREATE TABLE bad(v DEFAULT CURRENT_TIMESTAMP)"),
                /feature disabled/,
              );
              assert.equal(
                db.all("SELECT count(*) FROM sqlite_schema WHERE name='bad'")[0]!["count(*)"],
                0n,
              );
              assert.throws(
                () => db.run("INSERT INTO t VALUES(1,json_array(1))"),
                /feature disabled/,
              );
              assert.deepEqual(db.all("SELECT id FROM t"), []);
            }
            db.close();
          }
          const queries = [
            { name: "add", sql: "INSERT INTO t VALUES(?,?) RETURNING id,v" },
            {
              name: "core",
              sql: "SELECT ~id,id & 3,id | 4294967296,sign(-id),min(id,2),v LIKE '%n%' ESCAPE '!',v GLOB '*n*',glob('*n*',v),char(65,0,128512),0xF_F,1_000,id IS DISTINCT FROM NULL,id IS NOT DISTINCT FROM 1 FROM t ORDER BY id NULLS LAST",
            },
            {
              name: "get",
              sql: "SELECT id,v,CAST('12.5' AS REAL),sum(id) FROM t GROUP BY id,v ORDER BY id",
            },
            ...(enabled
              ? [
                  {
                    name: "json",
                    sql: "SELECT json('{\"n\":9007199254740993}'),json_extract(v,'$.n') FROM t ORDER BY id",
                  },
                  {
                    name: "arrows",
                    sql: "SELECT v -> '$.n',v ->> 'n',json_array(v -> 'n') FROM t ORDER BY id",
                  },
                  {
                    name: "date",
                    sql: "SELECT date('2000-02-28','+1 day'),strftime('%Y-%m','2000-02-28')",
                  },
                  {
                    name: "window",
                    sql: "SELECT id,lag(id) OVER (ORDER BY id),sum(id) OVER (ORDER BY id ROWS 1 PRECEDING) FROM t ORDER BY id",
                  },
                  { name: "filter", sql: "SELECT count(*) FILTER(WHERE id>1) FROM t" },
                ]
              : []),
          ];
          const source = { schema, queries };
          const native = new DatabaseSync(":memory:");
          native.exec(schema[0]!);
          let exec: (name: string, params?: any[]) => Promise<any[][]>;
          if (mode === "defined") {
            const { createDefinedDatabase } = await import("../adapters/defined-database-core.ts");
            const db = await createDefinedDatabase(raw === js ? js : definedWasm(wasm)).memory(
              buildDefinedCatalog(source),
            );
            exec = async (name, params = []) => (await db.execute(name, params)).rows;
          } else if (mode === "aot") {
            const db = openCompiled(raw as any, buildCatalog(source).artifact);
            exec = async (name, params = []) => db.execute(name, params).rows;
          } else {
            const db = openSql(raw as any);
            db.run(schema[0]!);
            exec = async (name, params = []) =>
              Object.values(db.all(queries.find((q) => q.name === name)!.sql, params)).map((row) =>
                Object.values(row),
              );
          }
          const expected = (name: string, params: any[] = []) => {
            const stmt = native.prepare(queries.find((q) => q.name === name)!.sql);
            stmt.setReadBigInts(true);
            stmt.setReturnArrays(true);
            return stmt.all(...params);
          };
          try {
            for (const id of [1n, 2n, 3n]) {
              const params = [id, '{"n":7}'];
              assert.deepEqual(await exec("add", params), expected("add", params));
            }
            for (const q of queries.slice(1))
              assert.deepEqual(await exec(q.name), expected(q.name), `${mode}/${q.name}`);
          } finally {
            native.close();
          }
        }
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("selected binary host bundles contain only the injected runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sqlike-optional-bundle-"));
  try {
    const built = await buildSqlikeRuntime(defineSqlike({ mode: "defined" }), {
      outDir: join(dir, "runtime"),
      targets: ["js"],
    });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(dir, "entry.ts"),
      `import * as runtime from ${JSON.stringify(join(built.directory, "runtime.js"))};\nimport {createDefinedDatabase} from ${JSON.stringify(join(process.cwd(), "adapters/defined-database-core.ts"))};\nexport const DB=createDefinedDatabase(runtime);\n`,
    );
    const result = await build({
      configFile: false,
      publicDir: false,
      logLevel: "silent",
      build: {
        write: false,
        minify: false,
        target: "esnext",
        lib: { entry: join(dir, "entry.ts"), formats: ["es"] },
      },
    });
    const chunks = (Array.isArray(result) ? result : [result]).flatMap((r) =>
      "output" in r ? r.output : [],
    );
    const code = chunks
      .filter((f) => f.type === "chunk")
      .map((f) => f.code)
      .join("\n");
    assert.doesNotMatch(
      code,
      /datetime__call|json__call|compute__windows|parse__statement|sqlite__export/,
    );
    assert.equal(
      chunks.filter(
        (f) =>
          f.type === "chunk" &&
          Object.keys(f.modules).some((p) => p.endsWith("/defined/defined.js")),
      ).length,
      0,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("each optional feature can be enabled independently on JS and Wasm", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sqlike-independent-test-"));
  try {
    const base = allSqlikeFeatures.filter(
      (f) => ![...optional, "binarySync", "sqlitePages", "ltx"].includes(f.name),
    );
    const fixtures = cases.map((c) => ({
      ...c,
      binary: buildDefinedCatalog(c.source),
    }));
    const { createDefinedDatabase } = await import("../adapters/defined-database-core.ts");
    for (const name of optional) {
      const built = await buildSqlikeRuntime(
        defineSqlike({ mode: "defined", features: [...base, { name }] }),
        { outDir: join(dir, name) },
      );
      const js = await import(pathToFileURL(join(built.directory, "runtime.js")).href);
      const wasm = definedWasm(
        (
          await WebAssembly.instantiate(
            await readFile(join(built.directory, "runtime.wasm")),
            {},
            { builtins: ["js-string"], importedStringConstants: "_" },
          )
        ).instance.exports,
      );
      for (const runtime of [js, wasm]) {
        const DB = createDefinedDatabase(runtime);
        for (const f of fixtures) {
          if (f.feature === name) await (await DB.memory(f.binary)).close();
          else await assert.rejects(DB.memory(f.binary), /required feature|feature disabled/);
        }
        const sql =
          name === "sqlJson"
            ? "SELECT json_array(1),json_extract('{\"n\":9007199254740993}','$.n')"
            : name === "dateTime"
              ? "SELECT date('2000-02-28','+1 day'),strftime('%Y','2000-02-28')"
              : name === "schemaMetadata"
                ? "PRAGMA index_xinfo(ix)"
                : name === "aggregateFilter"
                  ? "SELECT sum(1) FILTER(WHERE 1),count(*) FILTER(WHERE 0)"
                  : "SELECT row_number() OVER (),sum(1) OVER ()";
        const sourceSchema =
          name === "schemaMetadata"
            ? ["CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT)", "CREATE INDEX ix ON t(v)"]
            : [];
        const db = await DB.memory(
          buildDefinedCatalog({ schema: sourceSchema, queries: [{ name: "q", sql }] }),
        );
        const native = new DatabaseSync(":memory:");
        try {
          for (const ddl of sourceSchema) native.exec(ddl);
          const stmt = native.prepare(sql);
          stmt.setReadBigInts(true);
          stmt.setReturnArrays(true);
          assert.deepEqual((await db.execute("q")).rows, stmt.all());
        } finally {
          await db.close();
          native.close();
        }
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
