import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as compiler from "../_build/js/release/build/mizchi/sqlike/compiler/compiler.js";
import * as js from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import * as binary from "../_build/js/release/build/mizchi/sqlike/defined/defined.js";
import { definedWasm } from "../adapters/defined-wasm.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "./compatibility/native-values.ts";
import { aotBindings, aotValue } from "../src/aot-values.ts";
import type { ResultCell, Value } from "../src/contract.ts";

async function wasm(path: string) {
  return (
    await WebAssembly.instantiate(
      readFileSync(path),
      {},
      {
        builtins: ["js-string"],
        importedStringConstants: "_",
      },
    )
  ).instance.exports;
}
const aotWasm = await wasm(
  "_build/wasm-gc/release/build/mizchi/litestream-example/runtime/runtime.wasm",
);
const binaryWasm = definedWasm(
  await wasm("_build/wasm-gc/release/build/mizchi/sqlike/defined/defined.wasm"),
);
type Response = { error?: string; names: string[]; rows: ResultCell[][]; changes: number };
const checked = (text: string) => {
  const result = JSON.parse(text);
  assert.equal(result.error, undefined, text);
  return result;
};
for (const [target, raw, defined] of [
  ["aot/js", js, false],
  ["aot/wasm", aotWasm, false],
  ["defined/js", binary, true],
  ["defined/wasm", binaryWasm, true],
] as const) {
  // The same artifact feeds both wire formats; schema metadata must never be
  // retained from a connection, including after a failed write replaces Store.
  const open = (artifact: string) => {
    const r = raw as typeof js & typeof binary;
    const packed = compiler.pack_program_binary(artifact);
    const db = defined
      ? r.defined_open(
          compiler.binary_catalog_schema(packed),
          compiler.binary_catalog_statements(packed),
          new Uint8Array(),
        )
      : r.aot_open(artifact, "");
    checked(defined ? r.defined_info(db) : r.aot_info(db));
    const wrap = (handle: typeof db) => ({
      execute: (name: string, params: Value[] = []) =>
        JSON.parse(
          defined
            ? r.defined_execute(handle, name, aotBindings(params))
            : r.aot_execute(handle, name, aotBindings(params)),
        ) as Response,
      clock: (ms: number) =>
        checked(
          defined ? r.defined_set_clock(handle, String(ms)) : r.aot_set_clock(handle, String(ms)),
        ),
      snapshot: () => {
        if (!defined) return r.aot_dump(handle);
        const image = r.defined_snapshot(handle);
        checked(r.binary_info(image));
        return r.binary_data(image);
      },
      restore: (image: string | Uint8Array) =>
        checked(
          defined
            ? r.defined_restore(handle, image as Uint8Array)
            : r.aot_restore(handle, image as string),
        ),
      clone: () => wrap(defined ? r.defined_clone(handle) : r.aot_clone(handle)),
    });
    return wrap(db);
  };

  test(`UPDATE metadata preserves live values, triggers, FK and atomic rollback (${target})`, () => {
    const schema = [
      "CREATE TABLE t(id INTEGER PRIMARY KEY,label TEXT COLLATE NOCASE UNIQUE,other TEXT,balance REAL NOT NULL CHECK(balance>=0),body BLOB,stamp TEXT)",
      "CREATE INDEX balance_idx ON t(balance)",
      "CREATE TABLE child(id INTEGER PRIMARY KEY,pid INTEGER REFERENCES t(id) ON UPDATE CASCADE)",
      "CREATE TABLE audit(id INTEGER PRIMARY KEY,pid INTEGER,balance REAL)",
      "CREATE TRIGGER log_update AFTER UPDATE ON t BEGIN INSERT INTO audit(pid,balance) VALUES(new.id,new.balance); END",
    ];
    const queries = {
      seed: "INSERT INTO t VALUES(1,'One','Uno',5,x'00',NULL),(2,'Two','Dos',1,NULL,NULL)",
      child: "INSERT INTO child VALUES(1,1)",
      set: "UPDATE t SET balance=balance+?,body=?,stamp=CURRENT_TIMESTAMP WHERE id=? AND label=? RETURNING id AS same,balance AS same,label,body,_rowid_,stamp",
      move: "UPDATE t SET id=? WHERE id=? RETURNING id,balance",
      swap: "UPDATE t SET label=other,other=label WHERE id=? RETURNING label,other",
      duplicate: "UPDATE t SET balance=balance+?,balance=balance+? WHERE id=? RETURNING balance",
      sourced:
        "UPDATE t SET body=(SELECT body FROM t WHERE id=?) WHERE id=? AND EXISTS(SELECT 1 FROM child WHERE pid=t.id) RETURNING body",
      all: "UPDATE t SET balance=balance+? RETURNING id,balance",
      scan: "SELECT * FROM t ORDER BY id",
      audit: "SELECT pid,balance FROM audit ORDER BY id",
      children: "SELECT * FROM child ORDER BY id",
      counters: "SELECT changes(),last_insert_rowid()",
      begin: "SAVEPOINT s",
      rollback: "ROLLBACK TO s",
      release: "RELEASE s",
    };
    const artifact = compiler.compile_program(
      JSON.stringify({
        schema,
        queries: Object.entries(queries).map(([name, sql]) => ({ name, sql })),
      }),
    );
    const db = open(artifact),
      native = new NodeDatabase(":memory:");
    let clock = 0;
    function compare(name: keyof typeof queries, params: Value[] = []) {
      const result = db.execute(name, params);
      assert.equal(result.error, undefined, `${name}: ${result.error}`);
      const sql = queries[name].replaceAll(
        "CURRENT_TIMESTAMP",
        `datetime(${clock / 1000},'unixepoch')`,
      );
      assert.deepEqual(
        result.names,
        native.raw
          .prepare(sql)
          .columns()
          .map((c) => c.name),
        name,
      );
      assert.deepEqual(
        result.rows.map((row) => row.map(aotValue)),
        nativeValues(native, sql, params),
        name,
      );
      return result;
    }
    const state = () => {
      compare("scan");
      compare("audit");
      compare("children");
      compare("counters");
    };
    const reject = (name: keyof typeof queries, params: Value[]) => {
      const before = db.execute("scan").rows,
        audit = db.execute("audit").rows;
      assert.ok(db.execute(name, params).error, name);
      assert.throws(() => nativeValues(native, queries[name], params), /./, name);
      assert.deepEqual(db.execute("scan").rows, before, name);
      assert.deepEqual(db.execute("audit").rows, audit, name);
      state();
    };
    try {
      schema.forEach((sql) => native.run(sql));
      db.clock(clock);
      compare("seed");
      compare("child");
      // Affinity/coercion, NOCASE, residual predicates, empty candidates and a
      // parameter changing class must all be evaluated on each invocation.
      for (const id of ["1", 1, 1n, null, Uint8Array.of(1), 99n]) {
        compare("set", [0n, Uint8Array.of(0, 255), id, "oNE"]);
        state(); // Same-value UPDATE still fires the trigger and counts changes.
      }
      compare("set", [0n, null, 1n, "not-one"]);
      clock = 86400000;
      db.clock(clock);
      compare("set", ["2.5", Uint8Array.of(9), 1n, "ONE"]);
      state();
      compare("sourced", [2n, 1n]);
      compare("sourced", [1n, 2n]);
      state();
      reject("set", [-100n, null, 1n, "One"]);
      reject("move", [2n, 1n]);
      reject("move", [1.5, 1n]);
      // First row can be written before the second fails: undo both it and its trigger.
      reject("all", [-2n]);
      compare("duplicate", [100n, 1n, 1n]);
      compare("swap", [1n]);
      compare("begin");
      compare("move", [9007199254740993n, 1n]);
      state();
      compare("rollback");
      compare("release");
      state();
      native.run("SAVEPOINT image");
      const image = db.snapshot(),
        clone = db.clone(),
        original = db.execute("scan").rows;
      compare("move", [3n, 1n]);
      state();
      assert.deepEqual(clone.execute("scan").rows, original);
      db.restore(image);
      native.run("ROLLBACK TO image");
      native.run("RELEASE image");
      assert.deepEqual(db.execute("scan").rows, original);
      // Restored Store and independent connection both reuse the plan safely.
      compare("move", [3n, 1n]);
      assert.equal(clone.execute("move", [4n, 1n]).error, undefined);
      assert.notDeepEqual(db.execute("scan").rows, clone.execute("scan").rows);
    } finally {
      native.close();
    }
  });

  test(`bound slots preserve affinity/collation, truth literals and data-only binds (${target})`, () => {
    const schema = [
      "CREATE TABLE t(id INTEGER PRIMARY KEY,n NUMERIC,r REAL,s TEXT COLLATE NOCASE,b BLOB)",
      "CREATE TABLE flags(id INTEGER PRIMARY KEY,true TEXT,false INTEGER)",
    ];
    const expressions = [
      "n=?",
      "+n=?",
      "n=CAST(? AS NUMERIC)",
      "CAST(n AS TEXT)=?",
      "s=?",
      "s COLLATE binary=?",
      "s=? COLLATE rtrim",
      "(+s)=?",
      "r>=?",
      "n IS ?",
      "n IS NOT ?",
      "(n IS TRUE)=?",
      "(n IS FALSE)=?",
      "(n IS TRUE COLLATE binary)=?",
      "(NOT n)=?",
      "(n & 3)=?",
    ];
    const queries: Record<string, string> = {
      seed: "INSERT INTO t VALUES(1,1,1.5,'One',x'00ff')",
      flags: "INSERT INTO flags VALUES(1,'2',0)",
      scan: "SELECT * FROM t ORDER BY id",
      point: "SELECT * FROM t WHERE id=? LIMIT ? OFFSET ?",
      set: "UPDATE t SET n=n+?,r=-r+?,s=s||?,b=? WHERE id=? RETURNING *,n IS TRUE",
      shadow:
        "UPDATE flags SET true=?,false=? WHERE id=? RETURNING *,true IS TRUE,false IS FALSE,NOT true",
      compound: "SELECT id,n FROM t WHERE id=? UNION ALL SELECT id,n FROM t WHERE id=?",
      body: "UPDATE t SET b=? WHERE id=? RETURNING b",
    };
    expressions.forEach((e, i) => {
      queries[`q${i}`] = `SELECT id,n,s,b FROM t WHERE id=? AND (${e})`;
      queries[`u${i}`] = `UPDATE t SET b=? WHERE id=? AND (${e}) RETURNING id,n,s,b`;
    });
    const artifact = compiler.compile_program(
      JSON.stringify({
        schema,
        queries: Object.entries(queries).map(([name, sql]) => ({ name, sql })),
      }),
    );
    const db = open(artifact),
      native = new NodeDatabase(":memory:");
    function compare(name: string, params: Value[] = []) {
      const actual = db.execute(name, params);
      let expected: Value[][];
      try {
        expected = nativeValues(native, queries[name]!, params);
      } catch {
        assert.ok(actual.error, `${name} must reject`);
        return;
      }
      assert.equal(actual.error, undefined, `${name}: ${actual.error}`);
      assert.deepEqual(
        actual.names,
        native.raw
          .prepare(queries[name]!)
          .columns()
          .map((c) => c.name),
      );
      assert.deepEqual(
        actual.rows.map((row) => row.map(aotValue)),
        expected,
        `${name}: ${String(params)}`,
      );
    }
    try {
      schema.forEach((sql) => native.run(sql));
      compare("seed");
      compare("flags");
      const classes: Value[] = [
        1n,
        1,
        "1",
        "One",
        "oNE",
        "One ",
        null,
        Uint8Array.of(1),
        1.5,
        9007199254740993n,
      ];
      for (let i = 0; i < expressions.length; i++)
        for (const value of classes) {
          compare(`q${i}`, ["1", value]);
          compare(`u${i}`, [Uint8Array.of(i, 255), 1, value]);
        }
      for (const id of classes)
        for (const [limit, offset] of [
          [1n, 0n],
          [0n, 0n],
          [-1n, -1n],
          [1n, 1n],
          [1, 0],
          ["1", "0"],
          [null, 0n],
          ["bad", 0n],
        ] as Value[][])
          compare("point", [id, limit!, offset!]);
      compare("compound", [1n, 1n]);
      const payloads = [
        "x' OR 1=1; DROP TABLE t; --",
        '<img src=x onerror="globalThis.pwned=1">',
        "${globalThis.pwned=1}",
        "<script>alert(1)</script>\0",
      ];
      for (const payload of payloads) {
        compare("set", [1n, 2.5, payload, payload, 1n]);
        compare("body", [payload, 1n]);
        assert.deepEqual(
          db.execute("body", [payload, 1n]).rows.map((row) => row.map(aotValue)),
          [[payload]],
        );
        compare("point", [payload, 1n, 0n]);
        compare("shadow", [payload, 2n, 1n]);
      }
      assert.ok(db.execute("point; DROP TABLE t", [1n]).error);
      compare("scan");
    } finally {
      native.close();
    }
  });

  test(`UPDATE metadata respects STRICT, composite keys and shadowed rowid (${target})`, () => {
    for (const fixture of [
      {
        ddl: "CREATE TABLE t(id INTEGER PRIMARY KEY,n REAL,body BLOB) STRICT",
        seed: "INSERT INTO t VALUES(1,1,x'00')",
        update: "UPDATE t SET n=?,body=? WHERE id=? RETURNING *,_rowid_",
        params: [
          ["2.5", Uint8Array.of(9), "1"],
          [null, null, 1n],
        ],
        bad: ["bad", null, 1n],
      },
      {
        ddl: "CREATE TABLE t(k TEXT COLLATE NOCASE,n INTEGER,body BLOB,PRIMARY KEY(k,n)) WITHOUT ROWID",
        seed: "INSERT INTO t VALUES('A',1,x'00')",
        update: "UPDATE t SET body=?,n=? WHERE k=? AND n=? RETURNING *",
        params: [
          [Uint8Array.of(9), 2n, "a", "1"],
          [null, "3", "A", 2n],
        ],
        bad: [null, 0n, null, null],
      },
      {
        ddl: "CREATE TABLE t(k TEXT COLLATE NOCASE,n INTEGER,body BLOB,PRIMARY KEY(k,n)) WITHOUT ROWID",
        seed: "INSERT INTO t VALUES('A',1,x'00')",
        update: "UPDATE t SET body=?,n=n+? WHERE k=? RETURNING *",
        params: [
          [Uint8Array.of(9), 1n, "a"],
          [null, 0n, "A"],
        ],
        bad: [null, 0n, null],
      },
      {
        ddl: "CREATE TABLE t(rowid TEXT,_rowid_ TEXT,id INTEGER PRIMARY KEY,n NUMERIC)",
        seed: "INSERT INTO t VALUES('shadow','also',1,1)",
        update: "UPDATE t SET n=?,rowid=? WHERE oid=? RETURNING *,oid",
        params: [
          ["2.5", "changed", 1n],
          [null, null, "1"],
        ],
        bad: [null, null, null],
      },
    ]) {
      const artifact = compiler.compile_program(
        JSON.stringify({
          schema: [fixture.ddl],
          queries: [
            { name: "seed", sql: fixture.seed },
            { name: "set", sql: fixture.update },
          ],
        }),
      );
      const db = open(artifact),
        native = new NodeDatabase(":memory:");
      try {
        native.run(fixture.ddl);
        native.run(fixture.seed);
        assert.equal(db.execute("seed").error, undefined);
        for (const params of fixture.params as Value[][]) {
          const result = db.execute("set", params);
          assert.equal(result.error, undefined);
          assert.deepEqual(
            result.names,
            native.raw
              .prepare(fixture.update)
              .columns()
              .map((c) => c.name),
          );
          assert.deepEqual(
            result.rows.map((row) => row.map(aotValue)),
            nativeValues(native, fixture.update, params),
          );
        }
        if (fixture.ddl.endsWith("STRICT")) {
          assert.ok(db.execute("set", fixture.bad as Value[]).error);
          assert.throws(() => nativeValues(native, fixture.update, fixture.bad as Value[]));
        }
      } finally {
        native.close();
      }
    }
  });
}
