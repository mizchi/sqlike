import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as sql from "../_build/js/release/build/mizchi/sqlike/sqlike.js";
import * as aot from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import { aotBindings, aotValue } from "../src/aot-values.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "./compatibility/native-values.ts";
import type { Cell, Value } from "../src/contract.ts";

interface Query {
  name: string;
  sql: string;
  write?: boolean;
}

test("qualified Drizzle UPSERT conflict target matches native across dynamic and AOT runtimes", async () => {
  const schema = [
    "CREATE TABLE t(id INTEGER PRIMARY KEY,name TEXT UNIQUE,n REAL)",
  ];
  const queries: Query[] = [
    {
      name: "upsert",
      sql: 'INSERT INTO t VALUES(?,?,?) ON CONFLICT("t"."name" DESC) DO UPDATE SET n=excluded.n RETURNING id,n',
      write: true,
    },
    { name: "all", sql: "SELECT id,name,n FROM t ORDER BY id" },
  ];
  const native = new NodeDatabase(":memory:"),
    drivers = await engines(schema, queries);
  try {
    native.run(schema[0]!);
    for (const params of [
      [1n, "one", 1],
      [2n, "one", 2.5],
    ] as Value[][]) {
      const expected = native.values(queries[0]!.sql, params);
      for (const driver of drivers) {
        assert.deepEqual(driver.exec("upsert", params), expected);
        assert.deepEqual(driver.exec("all"), native.values(queries[1]!.sql));
      }
    }
  } finally {
    native.close();
  }
});

test("UPSERT names a partial unique index only with its matching target predicate", async () => {
  const schema = [
    "CREATE TABLE t(id INTEGER PRIMARY KEY,tag TEXT,live INTEGER)",
    "CREATE UNIQUE INDEX uq ON t(tag) WHERE live=1",
  ];
  const queries: Query[] = [
    { name: "add", sql: "INSERT INTO t VALUES(?,?,?)", write: true },
    {
      name: "upsert",
      sql: "INSERT INTO t VALUES(?,?,?) ON CONFLICT(tag) WHERE live=1 DO UPDATE SET id=excluded.id",
      write: true,
    },
    { name: "all", sql: "SELECT id,tag,live FROM t ORDER BY id" },
  ];
  const native = new NodeDatabase(":memory:"),
    drivers = await engines(schema, queries);
  try {
    for (const s of schema) native.run(s);
    for (const [name, params] of [
      ["add", [1n, "a", 1n]],
      ["add", [2n, "a", 0n]],
      ["upsert", [3n, "a", 1n]],
      ["upsert", [4n, "a", 0n]],
    ] as [string, Value[]][]) {
      native.run(queries.find((q) => q.name === name)!.sql, params);
      for (const d of drivers) {
        d.exec(name, params);
        assert.deepEqual(d.exec("all"), nativeValues(native, queries[2]!.sql));
      }
    }
  } finally {
    native.close();
  }
});

test("partial and expression indexes enforce membership and uniqueness across mutations and replay", async () => {
  const schema = [
    "CREATE TABLE items(id INTEGER PRIMARY KEY,tenant TEXT,label TEXT,deleted INTEGER NOT NULL DEFAULT 0,n INTEGER)",
    "CREATE UNIQUE INDEX uq_live ON items(tenant,lower(label) COLLATE NOCASE DESC) WHERE deleted=0",
    "CREATE INDEX ix_live ON items(tenant,n DESC,id) WHERE deleted=0",
  ];
  const queries: Query[] = [
    { name: "add", sql: "INSERT INTO items VALUES(?,?,?,?,?)", write: true },
    {
      name: "change",
      sql: "UPDATE items SET label=?,deleted=?,n=? WHERE id=?",
      write: true,
    },
    { name: "erase", sql: "DELETE FROM items WHERE id=?", write: true },
    {
      name: "all",
      sql: "SELECT id,tenant,label,deleted,n FROM items ORDER BY id",
    },
    {
      name: "live",
      sql: "SELECT id,label,n FROM items WHERE tenant=? AND deleted=0 AND n>=? ORDER BY n DESC,id",
    },
    {
      name: "every",
      sql: "SELECT id,label,n FROM items WHERE tenant=? ORDER BY n DESC,id",
    },
  ];
  const native = new NodeDatabase(":memory:"),
    drivers = await engines(schema, queries);
  try {
    for (const s of schema) native.run(s);
    const check = () => {
      for (const q of queries.filter((q) => !q.write)) {
        const params: Value[] =
          q.name === "all" ? [] : q.name === "live" ? ["a", 0n] : ["a"];
        for (const d of drivers)
          assert.deepEqual(
            d.exec(q.name, params),
            nativeValues(native, q.sql, params),
            `${d.name}/${q.name}`,
          );
      }
    };
    const write = (name: string, params: Value[], error = false) => {
      const q = queries.find((q) => q.name === name)!;
      if (error) {
        assert.throws(() => native.run(q.sql, params));
        for (const d of drivers) {
          const before = d.dump();
          assert.throws(() => d.exec(name, params));
          assert.equal(d.dump(), before);
        }
      } else {
        native.run(q.sql, params);
        for (const d of drivers) d.exec(name, params);
      }
      check();
    };
    write("add", [1n, "a", "One", 0n, 3n]);
    write("add", [2n, "a", "one", 1n, 9n]);
    write("add", [3n, "a", "ONE", 0n, 2n], true);
    write("change", ["one", 0n, 4n, 2n], true);
    write("change", ["one", 1n, 3n, 1n]);
    write("change", ["one", 0n, 4n, 2n]);
    write("add", [3n, "b", "ONE", 0n, 2n]);
    write("add", [4n, "a", null, 0n, null]);
    write("add", [5n, "a", null, 0n, 7n]);
    write("erase", [2n]);
    write("change", ["one", 0n, 8n, 1n]);
    for (const d of drivers) {
      const image = d.dump();
      d.restore(image);
      assert.equal(d.dump(), image);
      assert.deepEqual(d.clone().exec("all"), d.exec("all"));
    }
    check();
  } finally {
    native.close();
  }
});

test("composite mixed-direction indexes, residuals and explicit collations match SQLite on dynamic/AOT JS/Wasm", async () => {
  const schema = [
    "CREATE TABLE feed(id INTEGER PRIMARY KEY,tenant TEXT COLLATE NOCASE,n INTEGER,body TEXT)",
    "CREATE INDEX ix_feed ON feed(tenant COLLATE NOCASE ASC,n DESC,id ASC)",
    "CREATE TABLE names(id INTEGER PRIMARY KEY,a TEXT,b TEXT COLLATE NOCASE)",
    "CREATE UNIQUE INDEX uq_names ON names(a COLLATE NOCASE,b COLLATE BINARY DESC)",
  ];
  const queries: Query[] = [
    { name: "add", sql: "INSERT INTO feed VALUES(?,?,?,?)", write: true },
    {
      name: "move",
      sql: "UPDATE feed SET tenant=?,n=?,body=? WHERE id=?",
      write: true,
    },
    { name: "drop", sql: "DELETE FROM feed WHERE id=?", write: true },
    { name: "name", sql: "INSERT INTO names VALUES(?,?,?)", write: true },
    { name: "bad", sql: "UPDATE names SET b='x' WHERE id=2", write: true },
    {
      name: "forward",
      sql: "SELECT id,n,body FROM feed WHERE tenant=? AND n>=? AND n<? ORDER BY n DESC,id ASC LIMIT ? OFFSET ?",
    },
    {
      name: "reverse",
      sql: "SELECT id,n,body FROM feed WHERE tenant=? AND n>=? AND n<? ORDER BY n ASC,id DESC LIMIT ? OFFSET ?",
    },
    {
      name: "residual",
      sql: "SELECT id,n,body FROM feed WHERE tenant=? AND n>=? AND n<? AND body='yes' ORDER BY n DESC,id ASC LIMIT ? OFFSET ?",
    },
    {
      name: "full",
      sql: "SELECT id,tenant,n FROM feed ORDER BY tenant COLLATE NOCASE ASC,n DESC,id ASC",
    },
    {
      name: "names",
      sql: "SELECT id,a,b FROM names ORDER BY a COLLATE NOCASE,b COLLATE BINARY DESC,id",
    },
  ];
  const native = new NodeDatabase(":memory:"),
    drivers = await engines(schema, queries);
  try {
    for (const s of schema) native.run(s);
    const write = (name: string, params: Value[]) => {
      const q = queries.find((q) => q.name === name)!;
      native.run(q.sql, params);
      for (const d of drivers) d.exec(name, params);
    };
    for (let i = 0; i < 80; i++)
      write("add", [
        BigInt(81 - i),
        i % 3 ? (i % 2 ? "a" : "A") : "b",
        i % 11 === 0 ? null : BigInt(i % 9),
        i % 4 ? "yes" : "no",
      ]);
    write("name", [1n, "A", "x"]);
    write("name", [2n, "a", "X"]);
    const compare = () => {
      for (const name of ["forward", "reverse", "residual"])
        for (const tenant of ["a", "b", "missing", null])
          for (const [lo, hi] of [
            [null, 5n],
            [1n, 6n],
            [4n, 4n],
            [8n, -1n],
            [-2n, 10n],
          ] as Value[][]) {
            const params: Value[] = [tenant!, lo!, hi!, 7n, 1n],
              q = queries.find((q) => q.name === name)!;
            const expected = nativeValues(native, q.sql, params);
            for (const d of drivers)
              assert.deepEqual(
                d.exec(name, params),
                expected,
                `${d.name}/${name}`,
              );
          }
      for (const name of ["full", "names"])
        for (const d of drivers)
          assert.deepEqual(
            d.exec(name),
            nativeValues(native, queries.find((q) => q.name === name)!.sql),
          );
    };
    compare();
    write("move", ["a", 6n, "yes", 80n]);
    write("drop", [79n]);
    compare();
    for (const name of ["bad", "name"]) {
      const params: Value[] = name === "name" ? [3n, "a", "x"] : [],
        q = queries.find((q) => q.name === name)!;
      assert.throws(() => native.run(q.sql, params));
      for (const d of drivers) {
        const before = d.dump();
        assert.throws(() => d.exec(name, params));
        assert.equal(d.dump(), before);
        d.restore(before);
      }
    }
    compare();
    for (const d of drivers) {
      const image = d.dump();
      d.restore(image);
      assert.equal(d.dump(), image);
      const clone = d.clone();
      assert.deepEqual(clone.exec("full"), d.exec("full"));
    }
  } finally {
    native.close();
  }
});
interface Driver {
  name: string;
  exec(name: string, params?: Value[]): Value[][];
  dump(): string;
  restore(image: string): void;
  clone(): Driver;
}
function rows(text: string): Value[][] {
  const r = JSON.parse(text) as {
    error?: string;
    rows?: (Cell[] | Record<string, Cell>)[];
  };
  if (r.error) throw Error(r.error);
  return (r.rows ?? []).map((row) =>
    (Array.isArray(row) ? row : Object.values(row)).map(aotValue),
  );
}
async function engines(schema: string[], queries: Query[]): Promise<Driver[]> {
  const wasm = async (path: string) =>
    (
      await WebAssembly.instantiate(
        readFileSync(path),
        {},
        { builtins: ["js-string"], importedStringConstants: "_" },
      )
    ).instance.exports;
  const { artifact } = buildCatalog({
    schema,
    queries: queries.map(({ name, sql }) => ({ name, sql })),
  });
  const result: Driver[] = [];
  for (const [name, runtime] of [
    ["js", sql],
    [
      "wasm",
      (await wasm(
        "_build/wasm-gc/release/build/mizchi/sqlike/sqlike.wasm",
      )) as unknown as typeof sql,
    ],
  ] as const) {
    function wrap(db: ReturnType<typeof sql.database_open>): Driver {
      return {
        name: `${name}/dynamic`,
        exec(name, params = []) {
          const q = queries.find((q) => q.name === name)!;
          return rows(
            q.write
              ? runtime.database_exec(db, q.sql, aotBindings(params), false)
              : runtime.database_query_values(db, q.sql, aotBindings(params)),
          );
        },
        dump: () => runtime.database_dump(db),
        restore(image) {
          rows(runtime.database_restore(db, image));
        },
        clone: () => wrap(runtime.database_clone(db)),
      };
    }
    const db = runtime.database_open();
    for (const statement of schema)
      rows(runtime.database_exec(db, statement, "[]", false));
    result.push(wrap(db));
  }
  for (const [name, runtime] of [
    ["js", aot],
    [
      "wasm",
      (await wasm(
        "_build/wasm-gc/release/build/mizchi/litestream-example/runtime/runtime.wasm",
      )) as unknown as typeof aot,
    ],
  ] as const) {
    function wrap(db: ReturnType<typeof aot.aot_open>): Driver {
      return {
        name: `${name}/aot`,
        exec: (name, params = []) =>
          rows(runtime.aot_execute(db, name, aotBindings(params))),
        dump: () => runtime.aot_dump(db),
        restore(image) {
          rows(runtime.aot_restore(db, image));
        },
        clone: () => wrap(runtime.aot_clone(db)),
      };
    }
    const db = runtime.aot_open(artifact, "");
    assert.equal(JSON.parse(runtime.aot_info(db)).error, undefined);
    result.push(wrap(db));
  }
  return result;
}

test("single-column secondary ranges match SQLite across storage classes, collation, aliases and conservative fallbacks", async () => {
  const tables = [
    { name: "nums", type: "INTEGER" },
    { name: "names", type: "TEXT COLLATE NOCASE" },
    { name: "trimmed", type: "TEXT COLLATE RTRIM" },
    { name: "mixed", type: "BLOB" },
  ];
  const schema = tables.flatMap((t) => [
    `CREATE TABLE ${t.name}(id INTEGER PRIMARY KEY,n ${t.type})`,
    `CREATE INDEX ix_${t.name} ON ${t.name}(n)`,
  ]);
  const queries: Query[] = tables.flatMap((t) => [
    {
      name: `seed_${t.name}`,
      sql: `INSERT INTO ${t.name} VALUES(?,?)`,
      write: true,
    },
    { name: `${t.name}_all`, sql: `SELECT id,n FROM ${t.name} ORDER BY n` },
    ...["=", "==", "<", "<=", ">", ">="].map((op, i) => ({
      name: `${t.name}_${i}`,
      sql: `SELECT id,n FROM ${t.name} WHERE n${op}? ORDER BY n`,
    })),
    {
      name: `${t.name}_range`,
      sql: `SELECT id,n FROM ${t.name} WHERE n>=? AND n<? ORDER BY n`,
    },
    {
      name: `${t.name}_open`,
      sql: `SELECT id,n FROM ${t.name} WHERE n>? AND n<=? ORDER BY n`,
    },
    {
      name: `${t.name}_reverse`,
      sql: `SELECT id,n FROM ${t.name} WHERE ?<=n AND ?>n ORDER BY n`,
    },
    {
      name: `${t.name}_alias`,
      sql: `SELECT n AS rank,id FROM ${t.name} WHERE n>=? AND n<? ORDER BY rank LIMIT 2 OFFSET 1`,
    },
    {
      name: `${t.name}_star`,
      sql: `SELECT *,id AS n FROM ${t.name} WHERE n>=? AND n<? ORDER BY n`,
    },
    {
      name: `${t.name}_shadow`,
      sql: `SELECT n AS id,id AS n FROM ${t.name} WHERE n>=? AND n<? ORDER BY n`,
    },
    {
      name: `${t.name}_desc`,
      sql: `SELECT id,n FROM ${t.name} WHERE n>=? AND n<? ORDER BY n DESC,id`,
    },
    {
      name: `${t.name}_or`,
      sql: `SELECT id,n FROM ${t.name} WHERE n>=? OR n<? ORDER BY n,id`,
    },
    {
      name: `${t.name}_other`,
      sql: `SELECT id,n FROM ${t.name} WHERE n>=? AND id<? ORDER BY n,id`,
    },
  ]);
  const values: Value[] = [
    null,
    -5n,
    -0,
    2n,
    2.5,
    2n,
    "20",
    "tail",
    "A",
    "a",
    "a ",
    "x\0a",
    9007199254740993n,
    9223372036854775807n,
    new Uint8Array([0, 255]),
    new Uint8Array(),
  ];
  const bounds: Value[] = [
    null,
    -10n,
    0n,
    2n,
    2.5,
    "2",
    "20",
    "A",
    "a ",
    "tail",
    9007199254740993n,
    9223372036854775807n,
    new Uint8Array(),
  ];
  const native = new NodeDatabase(":memory:"),
    drivers = await engines(schema, queries);
  try {
    for (const statement of schema) native.run(statement);
    for (const t of tables)
      for (const [i, value] of values.entries()) {
        const params = [BigInt(values.length - i), value];
        native.run(
          queries.find((q) => q.name === `seed_${t.name}`)!.sql,
          params,
        );
        for (const d of drivers) d.exec(`seed_${t.name}`, params);
      }
    for (const t of tables) {
      const compare = (name: string, params: Value[]) => {
        const q = queries.find((q) => q.name === name)!,
          expected = nativeValues(native, q.sql, params);
        for (const d of drivers)
          assert.deepEqual(
            d.exec(name, params),
            expected,
            `${d.name} ${name} ${aotBindings(params)}`,
          );
      };
      compare(`${t.name}_all`, []);
      for (const bound of bounds)
        for (let i = 0; i < 6; i++) compare(`${t.name}_${i}`, [bound]);
      for (const lower of bounds)
        for (const upper of bounds)
          for (const kind of ["range", "open", "reverse"])
            compare(`${t.name}_${kind}`, [lower, upper]);
      for (const kind of ["alias", "star", "shadow", "desc", "or", "other"])
        compare(`${t.name}_${kind}`, [0n, "z"]);
    }
    for (const d of drivers) {
      const image = d.dump();
      d.exec("nums_range", [0n, 30n]);
      d.exec("names_range", ["a", "z"]);
      assert.equal(d.dump(), image, `${d.name}: caches must not enter images`);
    }
  } finally {
    native.close();
  }
});

test("indexed reads stay correct through writes, failed statements, cascades, snapshots and restore", async () => {
  const schema = [
    "CREATE TABLE p(id INTEGER PRIMARY KEY)",
    "CREATE TABLE u(id INTEGER PRIMARY KEY,n INTEGER UNIQUE,pid INTEGER REFERENCES p(id) ON DELETE CASCADE)",
    "CREATE INDEX ix_u ON u(n)",
  ];
  const queries: Query[] = [
    { name: "parents", sql: "INSERT INTO p VALUES(1),(2)", write: true },
    {
      name: "seed",
      sql: "INSERT INTO u VALUES(3,30,1),(1,10,1),(2,20,2)",
      write: true,
    },
    {
      name: "read",
      sql: "SELECT id,n,pid FROM u WHERE n>=? AND n<? ORDER BY n",
    },
    { name: "insert", sql: "INSERT INTO u VALUES(?,?,?)", write: true },
    { name: "update", sql: "UPDATE u SET n=? WHERE id=?", write: true },
    { name: "move", sql: "UPDATE u SET id=? WHERE id=?", write: true },
    {
      name: "upsert",
      sql: "INSERT INTO u VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET n=excluded.n,pid=excluded.pid",
      write: true,
    },
    {
      name: "replace",
      sql: "INSERT OR REPLACE INTO u VALUES(?,?,?)",
      write: true,
    },
    { name: "badUnique", sql: "UPDATE u SET n=7", write: true },
    { name: "badFK", sql: "UPDATE u SET pid=99 WHERE id=2", write: true },
    { name: "cascade", sql: "DELETE FROM p WHERE id=?", write: true },
  ];
  const operations: { name: string; params: Value[]; error?: boolean }[] = [
    { name: "insert", params: [4n, 15n, 1n] },
    { name: "update", params: [5n, 3n] },
    { name: "move", params: [9n, 4n] },
    { name: "upsert", params: [2n, 25n, 2n] },
    { name: "replace", params: [2n, 22n, 2n] },
    { name: "badUnique", params: [], error: true },
    { name: "badFK", params: [], error: true },
    { name: "cascade", params: [1n] },
  ];
  for (const d of await engines(schema, queries)) {
    const native = new NodeDatabase(":memory:");
    try {
      for (const sql of schema) native.run(sql);
      for (const name of ["parents", "seed"]) {
        native.run(queries.find((q) => q.name === name)!.sql);
        d.exec(name);
      }
      const readParams = [-100n, 100n],
        read = () => nativeValues(native, queries[2]!.sql, readParams),
        initial = read();
      assert.deepEqual(d.exec("read", readParams), initial);
      const snapshot = d.clone(),
        image = d.dump();
      for (const op of operations) {
        const q = queries.find((q) => q.name === op.name)!;
        d.exec("read", readParams);
        if (op.error) {
          assert.throws(() => native.run(q.sql, op.params));
          assert.throws(() => d.exec(op.name, op.params));
        } else {
          native.run(q.sql, op.params);
          d.exec(op.name, op.params);
        }
        assert.deepEqual(
          d.exec("read", readParams),
          read(),
          `${d.name}/${op.name}`,
        );
        assert.deepEqual(
          snapshot.exec("read", readParams),
          initial,
          `${d.name}: clone isolation`,
        );
      }
      d.restore(image);
      assert.deepEqual(
        d.exec("read", readParams),
        initial,
        `${d.name}: restore`,
      );
    } finally {
      native.close();
    }
  }
});

test("legacy logical images keep identical bytes after cached queries and schema invalidation", async () => {
  const legacy = readFileSync(
    "tests/fixtures/sqlike/pre-index-cache-image.json",
    "utf8",
  ).trim();
  const { instance } = await WebAssembly.instantiate(
    readFileSync("_build/wasm-gc/release/build/mizchi/sqlike/sqlike.wasm"),
    {},
    { builtins: ["js-string"], importedStringConstants: "_" },
  );
  for (const runtime of [sql, instance.exports as unknown as typeof sql]) {
    const db = runtime.database_open();
    rows(runtime.database_restore(db, legacy));
    const read = "SELECT id,n FROM t WHERE n>=0 ORDER BY n";
    assert.deepEqual(rows(runtime.database_query_values(db, read, "[]")), [
      [1n, 10n],
      [3n, 20n],
    ]);
    assert.equal(runtime.database_dump(db), legacy);
    for (const statement of [
      "DROP INDEX ix",
      "CREATE INDEX renamed ON t(n)",
      "DROP INDEX renamed",
      "ALTER TABLE t ADD COLUMN body TEXT",
      "CREATE INDEX ix ON t(n)",
    ]) {
      rows(runtime.database_exec(db, statement, "[]", false));
      assert.deepEqual(rows(runtime.database_query_values(db, read, "[]")), [
        [1n, 10n],
        [3n, 20n],
      ]);
    }
  }
});

test("incremental index mutations match SQLite with mixed keys, duplicate collations and three warm indexes", async () => {
  const schema = [
    "CREATE TABLE t(id INTEGER PRIMARY KEY,n BLOB,label TEXT COLLATE NOCASE,trimmed TEXT COLLATE RTRIM,payload TEXT NOT NULL)",
    "CREATE INDEX ix_n ON t(n)",
    "CREATE INDEX ix_label ON t(label)",
    "CREATE INDEX ix_trimmed ON t(trimmed)",
  ];
  const queries: Query[] = [
    { name: "insert", sql: "INSERT INTO t VALUES(?,?,?,?,?)", write: true },
    {
      name: "upsert",
      sql: "INSERT INTO t VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET n=excluded.n,label=excluded.label,trimmed=excluded.trimmed,payload=excluded.payload",
      write: true,
    },
    {
      name: "replace",
      sql: "INSERT OR REPLACE INTO t VALUES(?,?,?,?,?)",
      write: true,
    },
    {
      name: "update",
      sql: "UPDATE t SET n=?,label=?,trimmed=? WHERE id=?",
      write: true,
    },
    {
      name: "payload",
      sql: "UPDATE t SET payload=? WHERE id=?",
      write: true,
    },
    { name: "move", sql: "UPDATE t SET id=? WHERE id=?", write: true },
    { name: "delete", sql: "DELETE FROM t WHERE id=?", write: true },
    {
      name: "bulkUpdate",
      sql: "UPDATE t SET n=? WHERE id>=? AND id<?",
      write: true,
    },
    {
      name: "bulkDelete",
      sql: "DELETE FROM t WHERE id>=? AND id<?",
      write: true,
    },
    {
      name: "rollback",
      sql: "UPDATE t SET n='changed',payload=CASE WHEN id=? THEN NULL ELSE 'valid' END",
      write: true,
    },
    ...["n", "label", "trimmed"].flatMap((column) => [
      {
        name: `${column}All`,
        sql: `SELECT * FROM t ORDER BY ${column}`,
      },
      {
        name: `${column}Range`,
        sql: `SELECT * FROM t WHERE ${column}>=? AND ${column}<=? ORDER BY ${column} LIMIT 4 OFFSET 1`,
      },
    ]),
  ];
  const drivers = await engines(schema, queries),
    native = new NodeDatabase(":memory:");
  const keys: Value[] = [
    null,
    -3n,
    0n,
    2n,
    2.5,
    9007199254740993n,
    9223372036854775807n,
    "2",
    "A",
    "a",
    "a ",
    "x\0a",
    "🐕",
    new Uint8Array(),
    new Uint8Array([0, 255]),
  ];
  const names = [null, "A", "a", "a ", "b", "b ", "z", "x\0a", "🐕"];
  let state = 0x51a7;
  const random = (length: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % length;
  };
  const apply = (name: string, params: Value[], label: string) => {
    const q = queries.find((q) => q.name === name)!;
    let failed = false;
    try {
      native.run(q.sql, params);
    } catch {
      failed = true;
    }
    for (const d of drivers) {
      if (failed)
        assert.throws(() => d.exec(name, params), `${d.name}/${label}`);
      else d.exec(name, params);
    }
  };
  const check = (step: number) => {
    for (const column of ["n", "label", "trimmed"]) {
      const lower = column === "n" ? keys[random(keys.length)]! : "a",
        upper = column === "n" ? keys[random(keys.length)]! : "z";
      for (const [kind, params] of [
        ["All", []],
        ["Range", [lower, upper]],
      ] as const) {
        const name = column + kind,
          q = queries.find((q) => q.name === name)!,
          expected = nativeValues(native, q.sql, [...params]);
        for (const d of drivers)
          assert.deepEqual(
            d.exec(name, [...params]),
            expected,
            `${d.name}/step ${step}/${name}`,
          );
      }
    }
  };
  try {
    for (const statement of schema) native.run(statement);
    for (let id = 1; id <= 12; id++)
      apply(
        "insert",
        [BigInt(id), keys[id % keys.length]!, "a", "a ", `seed${id}`],
        "seed",
      );
    check(-1);
    for (let step = 0; step < 240; step++) {
      const id = BigInt(1 + random(24)),
        n = keys[random(keys.length)]!,
        label = names[random(names.length)]!,
        trimmed = names[random(names.length)]!;
      const operations: [string, Value[]][] = [
        ["insert", [id, n, label, trimmed, `insert${step}`]],
        ["upsert", [id, n, label, trimmed, `upsert${step}`]],
        ["replace", [id, n, label, trimmed, `replace${step}`]],
        ["update", [n, label, trimmed, id]],
        ["payload", [`payload${step}`, id]],
        ["move", [BigInt(1 + random(24)), id]],
        ["delete", [id]],
        ["bulkUpdate", [n, id, id + 3n]],
        ["bulkDelete", [id, id + 3n]],
        ["rollback", [id]],
      ];
      const [name, params] = operations[step % operations.length]!;
      apply(name, params, `step ${step}/${name}`);
      check(step);
      if (step % 40 === 0)
        for (const d of drivers) {
          const snapshot = d.clone(),
            image = d.dump(),
            expected = d.exec("nAll");
          d.exec("upsert", [-1n, n, "A", "a ", "temporary"]);
          assert.deepEqual(snapshot.exec("nAll"), expected, `${d.name}/clone`);
          d.restore(image);
          assert.equal(d.dump(), image);
          assert.deepEqual(d.exec("nAll"), expected, `${d.name}/restore`);
        }
    }
  } finally {
    native.close();
  }
});

test("row slot replacement preserves multi-row candidates, repeated UPSERT RETURNING and atomic rollback", async () => {
  const schema = [
    "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER CHECK(n<100),payload TEXT NOT NULL)",
    "CREATE INDEX ix ON t(n)",
  ];
  const operations = [
    {
      name: "all",
      sql: "UPDATE t SET n=n+1 WHERE id>=2 RETURNING id,n",
    },
    {
      name: "moveAll",
      sql: "UPDATE t SET id=id-1 RETURNING id,n",
    },
    {
      name: "repeat",
      sql: "INSERT INTO t VALUES(0,50,'first'),(0,60,'second'),(3,70,'last') ON CONFLICT(id) DO UPDATE SET n=excluded.n,payload=excluded.payload RETURNING id,n,payload",
    },
    {
      name: "badCheck",
      sql: "UPDATE t SET n=CASE WHEN id=2 THEN 100 ELSE n+1 END RETURNING id,n",
      error: /CHECK constraint/,
    },
    {
      name: "reuse",
      sql: "UPDATE t SET id=CASE WHEN id=2 THEN 0 ELSE id+10 END RETURNING id,n",
    },
    {
      name: "badPrimary",
      sql: "UPDATE t SET id=5 RETURNING id,n",
      error: /UNIQUE constraint/,
    },
    {
      name: "badNull",
      sql: "UPDATE t SET payload=NULL WHERE id=13 RETURNING id,n",
      error: /NOT NULL constraint/,
    },
    {
      name: "upsertMove",
      sql: "INSERT INTO t VALUES(0,80,'moved') ON CONFLICT(id) DO UPDATE SET id=14,n=excluded.n,payload=excluded.payload RETURNING id,n,payload",
    },
  ];
  const queries: Query[] = [
    {
      name: "seed",
      sql: "INSERT INTO t VALUES(1,10,'a'),(2,20,'b'),(3,30,'c'),(4,40,'d')",
      write: true,
    },
    { name: "rows", sql: "SELECT * FROM t ORDER BY id" },
    { name: "indexed", sql: "SELECT * FROM t WHERE n>=0 ORDER BY n" },
    ...operations.map(({ name, sql }) => ({ name, sql, write: true })),
  ];
  for (const driver of await engines(schema, queries)) {
    const native = new NodeDatabase(":memory:");
    try {
      for (const statement of schema) native.run(statement);
      native.run(queries[0]!.sql);
      driver.exec("seed");
      driver.exec("indexed");
      const image = driver.dump(),
        snapshot = driver.clone(),
        original = nativeValues(native, queries[1]!.sql);
      for (const op of operations) {
        driver.exec("indexed");
        const before = driver.dump();
        if (op.error) {
          assert.throws(() => nativeValues(native, op.sql), op.error);
          assert.throws(() => driver.exec(op.name), op.error);
          assert.equal(
            driver.dump(),
            before,
            `${driver.name}/${op.name}/rollback`,
          );
        } else {
          assert.deepEqual(
            driver.exec(op.name),
            nativeValues(native, op.sql),
            `${driver.name}/${op.name}/returning`,
          );
        }
        for (const name of ["rows", "indexed"]) {
          const query = queries.find((q) => q.name === name)!;
          assert.deepEqual(
            driver.exec(name),
            nativeValues(native, query.sql),
            `${driver.name}/${op.name}/${name}`,
          );
        }
        assert.equal(snapshot.dump(), image, `${driver.name}/snapshot image`);
        assert.deepEqual(
          snapshot.exec("rows"),
          original,
          `${driver.name}/snapshot rows`,
        );
      }
      driver.restore(image);
      assert.deepEqual(driver.exec("rows"), original, `${driver.name}/restore`);
    } finally {
      native.close();
    }
  }
});
