import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "./compatibility/native-values.ts";
import { analyzeCatalogRequirements } from "../scripts/analyze-catalog.ts";
import { catalogFunctionConstants } from "../src/catalog-capabilities.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSqlikeRuntime } from "../scripts/build-sqlike-runtime.ts";
import { defineSqlike, primaryKeyIndex } from "../src/sqlike-features.ts";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import { buildDefinedCatalog } from "../scripts/defined-compiler.ts";
import { openCompiled } from "../src/sqlike-runtime.ts";
import { createDefinedDatabase } from "../adapters/defined-database-core.ts";
import { DefinedDatabase } from "../adapters/defined-database.ts";
import { definedWasm } from "../adapters/defined-wasm.ts";
import type { CatalogSource } from "../src/aot-contract.ts";

const schema = ["CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT)"];
const source: CatalogSource = {
  schema,
  queries: [{ name: "get", sql: "SELECT id,v FROM t ORDER BY id" }],
};
async function runtimes(directory: string) {
  return [
    await import(pathToFileURL(join(directory, "runtime.js")).href),
    (
      await WebAssembly.instantiate(
        await readFile(join(directory, "runtime.wasm")),
        {},
        { builtins: ["js-string"], importedStringConstants: "_" },
      )
    ).instance.exports,
  ];
}

test("catalog-selected AOT and binary runtimes remove unused scalar and write implementations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sqlike-catalog-test-"));
  const writer = await DefinedDatabase.memory(
    buildDefinedCatalog({ schema, queries: [{ name: "add", sql: "INSERT INTO t VALUES(?,?)" }] }),
  );
  try {
    await writer.execute("add", [1n, "retained"]);
    const image = await writer.snapshot();
    for (const mode of ["aot", "defined"] as const) {
      const built = await buildSqlikeRuntime(defineSqlike({ mode, features: [primaryKeyIndex] }), {
        outDir: join(dir, mode),
        catalog: source,
        minify: false,
      });
      assert.ok(built.requirements);
      assert.deepEqual(built.requirements.statements, ["select"]);
      assert.deepEqual(built.requirements.functionGroups, []);
      const code = await readFile(join(built.directory, "runtime.js"), "utf8");
      for (const symbol of [
        "glob",
        "like",
        "substring__value",
        "sql__round",
        "insert__rows",
        "prepare__update",
        "updated__row__from__plan",
        "simple__aggregate",
      ])
        assert.ok(
          !code
            .split("\n")
            .some((line) => line.startsWith("function ") && line.includes(symbol + "(")),
          symbol,
        );
      assert.doesNotMatch(code, /function [^\n]*parse__statement\(/);
      for (const [index, raw] of (await runtimes(built.directory)).entries()) {
        if (mode === "defined") {
          const DB = createDefinedDatabase(index === 0 ? raw : definedWasm(raw));
          const db = await DB.memory(buildDefinedCatalog(source), { image });
          assert.deepEqual((await db.execute("get")).rows, [[1n, "retained"]]);
          const snapshot = await db.snapshot();
          if ("close" in db && typeof db.close === "function") await db.close();
          const reopened = await DB.memory(buildDefinedCatalog(source), { image: snapshot });
          assert.deepEqual((await reopened.execute("get")).rows, [[1n, "retained"]]);
          await reopened.close();
          for (const sql of [
            "SELECT CASE WHEN 0 THEN glob('*',v) ELSE 1 END FROM t WHERE 0",
            "INSERT INTO t VALUES(2,'x')",
          ])
            await assert.rejects(
              DB.memory(buildDefinedCatalog({ schema, queries: [{ name: "q", sql }] })),
              /catalog capability disabled/,
            );
        } else {
          const artifact = buildCatalog(source).artifact;
          assert.deepEqual(openCompiled(raw, artifact).execute("get").rows, []);
          for (const sql of [
            "SELECT CASE WHEN 0 THEN glob('*',v) ELSE 1 END FROM t WHERE 0",
            "INSERT INTO t VALUES(2,'x')",
          ])
            assert.throws(
              () =>
                openCompiled(raw, buildCatalog({ schema, queries: [{ name: "q", sql }] }).artifact),
              /catalog capability disabled/,
            );
        }
      }
    }
  } finally {
    await writer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("catalog inference includes schema, unused CASE, views, index expressions and trigger bodies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sqlike-catalog-closure-"));
  const catalog: CatalogSource = {
    schema: [
      "CREATE TABLE p(id INTEGER PRIMARY KEY) STRICT",
      "CREATE TABLE t(id INTEGER PRIMARY KEY,p INTEGER REFERENCES p(id),v TEXT CHECK(v GLOB '*'),created TEXT DEFAULT CURRENT_TIMESTAMP)",
      "CREATE INDEX ix ON t(lower(v)) WHERE v LIKE '%'",
      "CREATE VIEW vv AS SELECT CASE WHEN 0 THEN char(65) ELSE 'x' END AS v FROM t",
      "CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE t SET v=upper(NEW.v) WHERE id=NEW.id; END",
    ],
    queries: [
      { name: "json", sql: "SELECT json_array(1)" },
      { name: "filter", sql: "SELECT count(*) FILTER(WHERE id>0) FROM t" },
      { name: "window", sql: "SELECT row_number() OVER() FROM t" },
      { name: "outer", sql: "SELECT p.id AS a,t.id AS b FROM p FULL JOIN t ON p.id=t.id" },
      { name: "metadata", sql: "PRAGMA index_info(ix)" },
    ],
  };
  try {
    const built = await buildSqlikeRuntime(defineSqlike({ mode: "aot" }), {
      catalog,
      outDir: dir,
      targets: ["js"],
      minify: false,
    });
    assert.deepEqual(built.profile.features, [
      "aggregateFilter",
      "dateTime",
      "foreignKeys",
      "rightFullJoin",
      "schemaMetadata",
      "sqlJson",
      "strictTables",
      "triggers",
      "windowFunctions",
    ]);
    const r = built.requirements;
    assert.ok(r);
    assert.deepEqual(r.statements, ["pragma", "select", "update"]);
    for (const name of [
      "glob",
      "like",
      "char",
      "lower",
      "upper",
      "datetime",
      "json_array",
      "count",
      "$filter",
      "row_number",
    ])
      assert.ok(r.functions.includes(name), name);
    const runtime = await import(pathToFileURL(join(dir, "runtime.js")).href);
    const db = openCompiled(runtime, buildCatalog(catalog).artifact);
    assert.deepEqual(db.execute("json").rows, [["[1]"]]);
    assert.deepEqual(db.execute("filter").rows, [[0n]]);
    const manifest = JSON.parse(await readFile(join(dir, "profile.json"), "utf8"));
    assert.deepEqual(manifest.requirements, r);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("catalog specialization requires a fixed-query runtime", async () => {
  await assert.rejects(
    buildSqlikeRuntime(defineSqlike({ mode: "sql" }), {
      catalog: source,
      outDir: "generated/invalid-catalog-profile",
    }),
    /catalog specialization requires aot or defined/,
  );
});

test("typed requirements ignore SQL text, literal defaults and comments, and cover window aggregate dependencies", () => {
  const r = analyzeCatalogRequirements({
    schema: ["CREATE TABLE t(glob TEXT DEFAULT 'CURRENT_TIMESTAMP')"],
    queries: [
      { name: "q", sql: "SELECT 'json_array() DELETE char()' /* glob() */ AS value FROM t" },
    ],
  });
  assert.deepEqual(r.features, []);
  assert.deepEqual(r.functions, []);
  assert.deepEqual(r.functionGroups, []);
  assert.deepEqual(r.statements, ["select"]);
  const w = analyzeCatalogRequirements({
    schema: [],
    queries: [{ name: "q", sql: "SELECT sum(2) OVER()" }],
  });
  assert.deepEqual(w.features, ["windowFunctions"]);
  assert.deepEqual(w.functionGroups, ["aggregates"]);
});

test("all core function families, trigger writes and transactions retain native results on specialized JS/Wasm", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sqlike-catalog-functions-"));
  const catalog: CatalogSource = {
    schema: [
      schema[0]!,
      "CREATE TRIGGER guard BEFORE UPDATE ON t WHEN NEW.v GLOB '!' BEGIN SELECT RAISE(ABORT,'guard'); END",
    ],
    queries: [
      { name: "begin", sql: "BEGIN" },
      { name: "add", sql: "INSERT INTO t VALUES(1,'a'),(2,'b') RETURNING id,v" },
      { name: "update", sql: "UPDATE t SET v=upper(v) WHERE id=1 RETURNING id,v" },
      { name: "delete", sql: "DELETE FROM t WHERE id=2 RETURNING id,v" },
      { name: "commit", sql: "COMMIT" },
      { name: "meta", sql: "PRAGMA table_info(t)" },
      { name: "values", sql: "SELECT id,v FROM t ORDER BY id" },
      {
        name: "strings",
        sql: "SELECT glob('[a-z]','a'),like('%','a'),char(65,0,233),substr('abc',2),substring('abc',2),trim(' x '),ltrim(' x'),rtrim('x '),instr('abc','b'),replace('abc','b','X'),concat('a',NULL,'b'),concat_ws(':','a','b')",
      },
      {
        name: "scalar",
        sql: "SELECT octet_length('😀'),quote('a'),unicode('é'),sign(-5),round(1.25,1),nullif(1,1),coalesce(NULL,2),ifnull(NULL,3),iif(1,4,5),if(0,4,5),changes(),last_insert_rowid(),typeof(1),hex('a'),length('😀'),lower('A'),upper('a'),abs(-5),1 IN(1,2),min(1,2),max(1,2)",
      },
      {
        name: "aggregate",
        sql: "SELECT count(*),sum(id),total(id),avg(id),min(id),max(id),group_concat(v),string_agg(v,':') FROM t",
      },
    ],
  };
  try {
    for (const mode of ["aot", "defined"] as const) {
      const built = await buildSqlikeRuntime(defineSqlike({ mode }), {
        catalog,
        outDir: join(dir, mode),
      });
      assert.deepEqual(
        built.requirements?.functionGroups,
        Object.keys(catalogFunctionConstants)
          .filter((n) => !n.startsWith("json"))
          .sort(),
      );
      assert.deepEqual(built.requirements?.statements, [
        "delete",
        "insert",
        "pragma",
        "select",
        "transaction",
        "update",
      ]);
      for (const [index, raw] of (await runtimes(built.directory)).entries()) {
        const native = new NodeDatabase(":memory:");
        const db =
          mode === "aot"
            ? openCompiled(raw, buildCatalog(catalog).artifact)
            : await createDefinedDatabase(index === 0 ? raw : definedWasm(raw)).memory(
                buildDefinedCatalog(catalog),
              );
        try {
          for (const ddl of catalog.schema) native.raw.exec(ddl);
          for (const q of catalog.queries)
            assert.deepEqual(
              (await db.execute(q.name)).rows,
              nativeValues(native, q.sql),
              `${mode}/${index}/${q.name}`,
            );
        } finally {
          native.close();
          if ("close" in db && typeof db.close === "function") await db.close();
        }
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI resolves catalog paths relative to its profile file and emits reproducible requirements", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sqlike-catalog-cli-"));
  try {
    await mkdir(join(dir, "source"));
    await writeFile(join(dir, "source", "catalog.json"), JSON.stringify(source));
    await writeFile(
      join(dir, "profile.json"),
      JSON.stringify({
        mode: "defined",
        features: ["primaryKeyIndex"],
        catalog: "./source/catalog.json",
      }),
    );
    execFileSync(
      "pnpm",
      [
        "exec",
        "tsx",
        "scripts/build-sqlike-runtime.ts",
        join(dir, "profile.json"),
        join(dir, "output"),
      ],
      { stdio: "pipe", timeout: 60000 },
    );
    const p = JSON.parse(await readFile(join(dir, "output", "profile.json"), "utf8"));
    assert.deepEqual(p.requirements, analyzeCatalogRequirements(source));
    assert.deepEqual(p.features, ["primaryKeyIndex"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("generated catalog traversals and capability constants cover the current versioned contracts", () => {
  const hash = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
  for (const file of ["capability_config_generated.mbt", "runtime_usage_generated.mbt"]) {
    const text = readFileSync(`packages/sqlike/src/${file}`, "utf8");
    assert.ok(text.includes(`Capability SHA256: ${hash("src/runtime-capabilities.json")}`));
    assert.ok(text.includes(`Contract SHA256: ${hash("src/binary-wire.json")}`));
  }
});

test("FK cascades remain reachable when the catalog has no DELETE or UPDATE statements", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sqlike-catalog-fk-"));
  const catalog: CatalogSource = {
    schema: [
      "CREATE TABLE p(id INTEGER PRIMARY KEY)",
      "CREATE TABLE c(id INTEGER PRIMARY KEY,p INTEGER REFERENCES p(id) ON DELETE CASCADE)",
    ],
    queries: [
      { name: "parent", sql: "INSERT INTO p VALUES(1)" },
      { name: "child", sql: "INSERT INTO c VALUES(1,1)" },
      { name: "replace", sql: "INSERT OR REPLACE INTO p VALUES(1)" },
      { name: "read", sql: "SELECT id,p FROM c ORDER BY id" },
    ],
  };
  try {
    const built = await buildSqlikeRuntime(defineSqlike({ mode: "defined" }), {
      catalog,
      outDir: dir,
    });
    assert.deepEqual(built.requirements?.statements, ["insert", "select"]);
    assert.deepEqual(built.profile.features, ["foreignKeys"]);
    for (const [index, raw] of (await runtimes(dir)).entries()) {
      const db = await createDefinedDatabase(index === 0 ? raw : definedWasm(raw)).memory(
        buildDefinedCatalog(catalog),
      );
      const native = new NodeDatabase(":memory:");
      try {
        for (const ddl of catalog.schema) native.raw.exec(ddl);
        for (const q of catalog.queries)
          assert.deepEqual((await db.execute(q.name)).rows, nativeValues(native, q.sql), q.name);
        assert.deepEqual((await db.execute("read")).rows, []);
      } finally {
        native.close();
        await db.close();
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("each core function family is independently selectable from catalog IR", async () => {
  const witnesses: Record<
    Exclude<keyof typeof catalogFunctionConstants, `json${string}`>,
    string
  > = {
    glob: "SELECT glob('[a-z]','a')",
    like: "SELECT 'a' LIKE '%'",
    character: "SELECT char(65,0)",
    substring: "SELECT substr('abc',2)",
    trim: "SELECT trim(' x ')",
    instr: "SELECT instr('abc','b')",
    replace: "SELECT replace('abc','b','X')",
    concat: "SELECT concat_ws(':','a','b')",
    octetLength: "SELECT octet_length('é')",
    quote: "SELECT quote('a')",
    unicode: "SELECT unicode('é')",
    sign: "SELECT sign(-1)",
    round: "SELECT round(1.25,1)",
    nullif: "SELECT nullif(1,1)",
    coalesce: "SELECT coalesce(NULL,1)",
    conditional: "SELECT iif(1,2,3)",
    connectionCounters: "SELECT changes(),last_insert_rowid()",
    typeof: "SELECT typeof(1)",
    hex: "SELECT hex('a')",
    length: "SELECT length('é')",
    caseConversion: "SELECT lower('A')",
    abs: "SELECT abs(-1)",
    inList: "SELECT 1 IN(1,2)",
    extrema: "SELECT min(1,2)",
    aggregates: "SELECT sum(2) OVER()",
    groupConcat: "SELECT group_concat('a')",
    raise: "INSERT INTO t VALUES(1)",
  };
  const dir = await mkdtemp(join(tmpdir(), "sqlike-catalog-independent-"));
  try {
    for (const [name, sql] of Object.entries(witnesses)) {
      const catalog: CatalogSource = {
        schema:
          name === "raise"
            ? [
                "CREATE TABLE t(id INTEGER PRIMARY KEY)",
                "CREATE TRIGGER tr BEFORE INSERT ON t BEGIN SELECT RAISE(IGNORE); END",
              ]
            : [],
        queries: [{ name: "q", sql }],
      };
      const built = await buildSqlikeRuntime(defineSqlike({ mode: "aot" }), {
        catalog,
        outDir: join(dir, name),
        targets: ["js"],
      });
      assert.deepEqual(built.requirements?.functionGroups, [name]);
      const runtime = await import(pathToFileURL(join(built.directory, "runtime.js")).href);
      const db = openCompiled(runtime, buildCatalog(catalog).artifact);
      const native = new NodeDatabase(":memory:");
      try {
        for (const ddl of catalog.schema) native.raw.exec(ddl);
        assert.deepEqual(db.execute("q").rows, nativeValues(native, sql), name);
      } finally {
        native.close();
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
