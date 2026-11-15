import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as aot from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import { MoonDatabase } from "../adapters/moon-database.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { wasmRuntime } from "./compatibility/feature-runtime.ts";
import { nativeValues } from "./compatibility/native-values.ts";
import { aotBindings, aotValue } from "../src/aot-values.ts";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import type { Cell, Value } from "../src/contract.ts";

const schema = [
  "CREATE TABLE items(id INTEGER PRIMARY KEY,n INTEGER,title TEXT COLLATE NOCASE)",
  "CREATE TABLE shadow(id INTEGER PRIMARY KEY,rowid TEXT,_rowid_ TEXT,oid TEXT)",
  "CREATE TABLE wr(a TEXT,b INTEGER,PRIMARY KEY(a,b)) WITHOUT ROWID",
  "CREATE TABLE limits(id INTEGER PRIMARY KEY,n INTEGER)",
  "CREATE VIEW visible AS SELECT id,n,title FROM items",
  "CREATE TABLE nonalias(pk INTEGER PRIMARY KEY,id INTEGER)",
];
const seeds = [
  "INSERT INTO items VALUES(9,20,'b'),(2,30,'A'),(7,10,'a'),(1,40,'z'),(9007199254740993,50,'large')",
  "INSERT INTO shadow VALUES(2,'first','one','x'),(1,'second','two','y')",
  "INSERT INTO wr VALUES('z',1),('a',2),('a',1)",
  "INSERT INTO limits VALUES(1,1),(2,-9223372036854775808)",
  "INSERT INTO nonalias VALUES(1,9),(5,1)",
];
const cases: { sql: string; params: Value[] }[] = [
  ...[
    2n,
    4n,
    null,
    2,
    "2",
    "2tail",
    9007199254740993n,
    new Uint8Array([50]),
  ].map((value) => ({
    sql: "SELECT id,n,title FROM items WHERE id=?",
    params: [value],
  })),
  { sql: "SELECT id FROM items WHERE ?=id", params: [7n] },
  { sql: "SELECT x.id,x.title FROM items x WHERE x.id=?", params: [9n] },
  ...["rowid", "_rowid_", "oid"].map((key) => ({
    sql: `SELECT id FROM items WHERE ${key}=?`,
    params: [2n],
  })),
  { sql: "SELECT id,n,title FROM items ORDER BY id LIMIT 2", params: [] },
  { sql: "SELECT id,n,title FROM items ORDER BY id DESC LIMIT 2", params: [] },
  { sql: "SELECT id,n,title FROM items ORDER BY 1 LIMIT 2", params: [] },
  { sql: "SELECT n AS id,title FROM items ORDER BY id LIMIT 2", params: [] },
  { sql: "SELECT *,pk AS id FROM nonalias ORDER BY id LIMIT 1", params: [] },
  {
    sql: "SELECT nonalias.*,pk AS id FROM nonalias ORDER BY id LIMIT 1",
    params: [],
  },
  { sql: "SELECT id AS n,n AS id FROM items ORDER BY id LIMIT 2", params: [] },
  {
    sql: "SELECT title FROM items ORDER BY title COLLATE NOCASE,id LIMIT 3",
    params: [],
  },
  ...[
    [0n, 0n],
    [-1n, 2n],
    [2n, -1n],
    [2n, 1n],
  ].map((params) => ({
    sql: "SELECT * FROM items ORDER BY rowid LIMIT ? OFFSET ?",
    params,
  })),
  { sql: "SELECT id FROM items WHERE id>1 ORDER BY id LIMIT 2", params: [] },
  { sql: "SELECT id FROM items ORDER BY id LIMIT 1+1", params: [] },
  {
    sql: "SELECT id,42,'text',NULL,x'ff',rowid FROM items ORDER BY id LIMIT 2",
    params: [],
  },
  {
    sql: "SELECT o.id,(SELECT o.n FROM items i WHERE i.id=o.id LIMIT 1) FROM items o ORDER BY o.id LIMIT 2",
    params: [],
  },
  { sql: "SELECT * FROM shadow ORDER BY id LIMIT 1", params: [] },
  { sql: "SELECT id FROM shadow WHERE rowid=?", params: ["first"] },
  { sql: "SELECT a,b FROM wr ORDER BY a,b LIMIT 2", params: [] },
  { sql: "SELECT id,title FROM visible ORDER BY id LIMIT 2", params: [] },
  {
    sql: "WITH items AS (SELECT 8 AS id) SELECT id FROM items LIMIT 1",
    params: [],
  },
  {
    sql: "SELECT a.id,b.id FROM items a JOIN items b ON a.id=b.id ORDER BY a.id LIMIT 2",
    params: [],
  },
  {
    sql: "SELECT o.id,(SELECT n FROM items i WHERE i.id=o.id) FROM items o ORDER BY o.id LIMIT 2",
    params: [],
  },
];
async function runtimes() {
  const { instance } = await WebAssembly.instantiate(
    readFileSync(
      "_build/wasm-gc/release/build/mizchi/litestream-example/runtime/runtime.wasm",
    ),
    {},
    { builtins: ["js-string"], importedStringConstants: "_" },
  );
  return {
    aot: [aot, instance.exports as unknown as typeof aot],
    dynamic: [
      new MoonDatabase(),
      new MoonDatabase(undefined, undefined, await wasmRuntime()),
    ],
  };
}

test("optimized SELECT preserves typed results, scope, rowid aliases and fallback paths on JS/Wasm dynamic/AOT", async () => {
  const native = new NodeDatabase(":memory:"),
    engines = await runtimes();
  try {
    for (const sql of [...schema, ...seeds]) {
      native.run(sql);
      for (const db of engines.dynamic) db.run(sql);
    }
    const { artifact } = buildCatalog({
      schema,
      queries: [
        ...seeds.map((sql, i) => ({ name: `seed${i}`, sql })),
        ...cases.map(({ sql }, i) => ({ name: `q${i}`, sql })),
      ],
    });
    for (const runtime of engines.aot) {
      const db = runtime.aot_open(artifact, "");
      for (let i = 0; i < seeds.length; i++)
        assert.equal(
          JSON.parse(runtime.aot_execute(db, `seed${i}`, "[]")).error,
          undefined,
        );
      for (const [i, c] of cases.entries()) {
        const response = JSON.parse(
          runtime.aot_execute(db, `q${i}`, aotBindings(c.params)),
        ) as { error?: string; rows: Cell[][] };
        assert.equal(response.error, undefined, c.sql);
        assert.deepEqual(
          response.rows.map((row) => row.map(aotValue)),
          nativeValues(native, c.sql, c.params),
          c.sql,
        );
      }
    }
    for (const db of engines.dynamic)
      for (const c of cases)
        assert.deepEqual(
          db.queryValues(c.sql, c.params),
          nativeValues(native, c.sql, c.params),
          c.sql,
        );
    for (const sql of [
      "SELECT missing FROM items LIMIT 0",
      "SELECT missing FROM items WHERE id=999",
      "SELECT id FROM items LIMIT 'bad'",
    ]) {
      assert.throws(() => nativeValues(native, sql));
      for (const db of engines.dynamic)
        assert.throws(() => db.queryValues(sql), sql);
    }
  } finally {
    native.close();
  }
});

test("LIMIT stops evaluating later rows while preserving preparation errors", async () => {
  const sql =
    "SELECT id FROM limits WHERE id=1 OR abs(n)>0 ORDER BY id LIMIT 1";
  const native = new NodeDatabase(":memory:"),
    engines = await runtimes();
  try {
    native.run(schema[3]!);
    native.run(seeds[3]!);
    const expected = nativeValues(native, sql);
    for (const db of engines.dynamic) {
      db.run(schema[3]!);
      db.run(seeds[3]!);
      assert.deepEqual(db.queryValues(sql), expected);
    }
    const { artifact } = buildCatalog({
      schema: [schema[3]!],
      queries: [
        { name: "seed", sql: seeds[3]! },
        { name: "read", sql },
      ],
    });
    for (const runtime of engines.aot) {
      const db = runtime.aot_open(artifact, "");
      runtime.aot_execute(db, "seed", "[]");
      const result = JSON.parse(runtime.aot_execute(db, "read", "[]"));
      assert.equal(result.error, undefined);
      assert.deepEqual(
        (result.rows as Cell[][]).map((row) => row.map(aotValue)),
        expected,
      );
    }
  } finally {
    native.close();
  }
});

test("candidate DML preserves affinity, rowid changes, cascades, atomic failures and AOT snapshots", async () => {
  const ddl = [
    "CREATE TABLE p(id INTEGER PRIMARY KEY,n INTEGER UNIQUE)",
    "CREATE TABLE c(id INTEGER PRIMARY KEY,pid INTEGER REFERENCES p(id) ON DELETE CASCADE)",
  ];
  const initial = [
    "INSERT INTO p VALUES(3,30),(1,10),(2,20)",
    "INSERT INTO c VALUES(1,1),(2,2)",
  ];
  const operations = [
    {
      name: "change",
      sql: "UPDATE p SET n=? WHERE id=? RETURNING id,n",
      params: [21n, 2n],
      error: false,
    },
    {
      name: "duplicate",
      sql: "UPDATE p SET n=? WHERE id=? RETURNING id,n",
      params: [10n, 2n],
      error: true,
    },
    {
      name: "move",
      sql: "UPDATE p SET id=? WHERE id=? RETURNING id,n",
      params: [9n, 3n],
      error: false,
    },
    {
      name: "text",
      sql: "UPDATE p SET n=? WHERE id=? RETURNING id,n",
      params: [25n, "2"],
      error: false,
    },
    {
      name: "delete",
      sql: "DELETE FROM p WHERE id=? RETURNING id",
      params: [1n],
      error: false,
    },
    {
      name: "miss",
      sql: "DELETE FROM p WHERE id=? RETURNING id",
      params: [99n],
      error: false,
    },
  ];
  const reads = [
    "SELECT id,n FROM p ORDER BY id",
    "SELECT id,pid FROM c ORDER BY id",
  ];
  const engines = await runtimes(),
    { artifact } = buildCatalog({
      schema: ddl,
      queries: [
        ...initial.map((sql, i) => ({ name: `seed${i}`, sql })),
        ...operations.map(({ name, sql }) => ({ name, sql })),
        ...reads.map((sql, i) => ({ name: `read${i}`, sql })),
      ],
    });
  for (const db of engines.dynamic) {
    const native = new NodeDatabase(":memory:");
    try {
      for (const sql of [...ddl, ...initial]) {
        native.run(sql);
        db.run(sql);
      }
      for (const op of operations) {
        if (op.error) {
          assert.throws(() => nativeValues(native, op.sql, op.params));
          assert.throws(() => db.all(op.sql, op.params));
        } else {
          const expected = nativeValues(native, op.sql, op.params);
          const actual = db
            .all(op.sql, op.params)
            .map((row) => Object.values(row));
          assert.deepEqual(actual, expected, op.name);
        }
        for (const sql of reads)
          assert.deepEqual(
            db.queryValues(sql),
            nativeValues(native, sql),
            op.name,
          );
      }
    } finally {
      native.close();
    }
  }
  for (const runtime of engines.aot) {
    const native = new NodeDatabase(":memory:"),
      db = runtime.aot_open(artifact, "");
    try {
      for (const sql of [...ddl, ...initial]) native.run(sql);
      for (let i = 0; i < initial.length; i++)
        assert.equal(
          JSON.parse(runtime.aot_execute(db, `seed${i}`, "[]")).error,
          undefined,
        );
      const snapshot = runtime.aot_clone(db),
        image = runtime.aot_dump(snapshot);
      for (const op of operations) {
        const response = JSON.parse(
          runtime.aot_execute(db, op.name, aotBindings(op.params)),
        ) as { error?: string; rows: Cell[][] };
        if (op.error) {
          assert.throws(() => nativeValues(native, op.sql, op.params));
          assert.match(response.error ?? "", /UNIQUE constraint/);
        } else {
          assert.equal(response.error, undefined);
          assert.deepEqual(
            response.rows.map((row) => row.map(aotValue)),
            nativeValues(native, op.sql, op.params),
            op.name,
          );
        }
        for (const [i, sql] of reads.entries()) {
          const rows = JSON.parse(runtime.aot_execute(db, `read${i}`, "[]"))
            .rows as Cell[][];
          assert.deepEqual(
            rows.map((row) => row.map(aotValue)),
            nativeValues(native, sql),
            op.name,
          );
        }
        assert.equal(runtime.aot_dump(snapshot), image);
      }
    } finally {
      native.close();
    }
  }
});
