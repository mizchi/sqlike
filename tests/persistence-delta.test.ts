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
const schema = [
  "CREATE TABLE p(id INTEGER PRIMARY KEY)",
  "CREATE TABLE t(id INTEGER PRIMARY KEY,n BLOB,b BLOB,title TEXT UNIQUE COLLATE NOCASE,pid INTEGER REFERENCES p(id) ON DELETE CASCADE)",
];
const queries = [
  { name: "parents", sql: "INSERT INTO p VALUES(1),(2)", write: true },
  { name: "insert", sql: "INSERT INTO t VALUES(?,?,?,?,?)", write: true },
  {
    name: "update",
    sql: "UPDATE t SET id=?,n=?,b=?,title=? WHERE id=?",
    write: true,
  },
  {
    name: "upsert",
    sql: "INSERT INTO t VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET n=excluded.n,b=excluded.b,title=excluded.title",
    write: true,
  },
  { name: "bad", sql: "UPDATE t SET title='same'", write: true },
  { name: "cascade", sql: "DELETE FROM p WHERE id=?", write: true },
  {
    name: "rows",
    sql: "SELECT id,n,typeof(n),hex(b),title,pid FROM t ORDER BY id",
  },
  { name: "ps", sql: "SELECT id FROM p ORDER BY id" },
];
interface Driver {
  exec(name: string, args?: Value[]): Value[][];
  flush(full: boolean): string;
  ack(): void;
  apply(text: string): string;
  dump(): string;
}
const parse = (text: string) => {
  const r = JSON.parse(text);
  if (r.error) throw Error(r.error);
  return r;
};
async function wasm(path: string) {
  return (
    await WebAssembly.instantiate(
      readFileSync(path),
      {},
      { builtins: ["js-string"], importedStringConstants: "_" },
    )
  ).instance.exports;
}
for (const mode of ["dynamic", "aot"] as const)
  test(`${mode} materialized journal replays across JS/Wasm with native types, atomic errors and cascades`, async () => {
    const built = buildCatalog({ schema, queries });
    const factories: (() => Driver)[] = [];
    if (mode === "dynamic")
      for (const r of [
        sql,
        (await wasm(
          "_build/wasm-gc/release/build/mizchi/sqlike/sqlike.wasm",
        )) as unknown as typeof sql,
      ])
        factories.push(() => {
          const db = r.database_open();
          return {
            exec(name, args = []) {
              const q = queries.find((q) => q.name === name)!;
              const result = parse(
                q.write
                  ? r.database_exec(db, q.sql, aotBindings(args), false)
                  : r.database_query_values(db, q.sql, aotBindings(args)),
              );
              return q.write
                ? []
                : result.rows.map((row: Cell[]) => row.map(aotValue));
            },
            flush: (full) => r.database_delta(db, full),
            ack: () => {
              parse(r.database_ack_delta(db, r.database_serial(db)));
            },
            apply: (text) => r.database_apply_delta(db, text),
            dump: () => r.database_dump(db),
          };
        });
    else
      for (const r of [
        aot,
        (await wasm(
          "_build/wasm-gc/release/build/mizchi/litestream-example/runtime/runtime.wasm",
        )) as unknown as typeof aot,
      ])
        factories.push(() => {
          const db = r.aot_open(built.artifact, "");
          parse(r.aot_info(db));
          return {
            exec: (name, args = []) =>
              parse(r.aot_execute(db, name, aotBindings(args))).rows.map(
                (row: Cell[]) => row.map(aotValue),
              ),
            flush: (full) => r.aot_delta(db, full),
            ack: () => {
              parse(r.aot_ack_delta(db, parse(r.aot_info(db)).serial));
            },
            apply: (text) => r.aot_apply_delta(db, text),
            dump: () => r.aot_dump(db),
          };
        });
    const sources = factories.map((f) => f()),
      targets = factories.map((f) => f()),
      native = new NodeDatabase(":memory:");
    const operations: { name: string; args: Value[]; error?: boolean }[] = [
      {
        name: "update",
        args: [9n, 2.25, new Uint8Array([15]), "東🐕\0tail", 1n],
      },
      { name: "bad", args: [], error: true },
      {
        name: "upsert",
        args: [2n, 9223372036854775807n, new Uint8Array(), "B", 2n],
      },
      { name: "cascade", args: [1n] },
    ];
    try {
      for (const statement of schema) native.run(statement);
      // Dynamic sources start with a normal logical snapshot of the same schema.
      if (mode === "dynamic") {
        const base = sql.database_open();
        for (const statement of schema)
          parse(sql.database_exec(base, statement, "[]", false));
        const full = sql.database_delta(base, true);
        for (const d of sources) parse(d.apply(full));
      }
      const seed: [string, Value[]][] = [
        ["parents", []],
        ["insert", [1n, 9007199254740993n, new Uint8Array([0, 255]), "A", 1n]],
        ["insert", [2n, 2.5, new Uint8Array(4096).fill(7), "b", 2n]],
      ];
      for (const [name, args] of seed) {
        native.run(queries.find((q) => q.name === name)!.sql, args);
        for (const d of sources) d.exec(name, args);
      }
      assert.equal(sources[0]!.flush(true), sources[1]!.flush(true));
      for (const d of targets) parse(d.apply(sources[0]!.flush(true)));
      for (const d of sources) d.ack();
      for (const op of operations) {
        const q = queries.find((q) => q.name === op.name)!;
        const pending = sources.map((d) => d.flush(false));
        if (op.error) {
          assert.throws(() => native.run(q.sql, op.args));
          for (const [i, d] of sources.entries()) {
            assert.throws(() => d.exec(op.name, op.args));
            assert.equal(d.flush(false), pending[i]);
          }
          continue;
        }
        native.run(q.sql, op.args);
        for (const d of sources) d.exec(op.name, op.args);
        const delta = sources[0]!.flush(false);
        assert.equal(delta, sources[1]!.flush(false));
        for (const d of targets) {
          const before = d.dump();
          const damaged = JSON.parse(delta);
          const body = mode === "aot" ? damaged.data : damaged;
          body.meta.sequences[0][0] = "wrong-table";
          assert.ok(JSON.parse(d.apply(JSON.stringify(damaged))).error);
          assert.equal(
            d.dump(),
            before,
            "late replay failure must not publish earlier row edits",
          );
          parse(d.apply(delta));
          const stable = d.dump();
          assert.ok(JSON.parse(d.apply(delta)).error);
          assert.equal(d.dump(), stable);
          for (const name of ["rows", "ps"]) {
            assert.deepEqual(
              d.exec(name),
              nativeValues(native, queries.find((q) => q.name === name)!.sql),
            );
          }
          assert.equal(d.dump(), sources[0]!.dump());
        }
        for (const d of sources) d.ack();
      }
      const stable = targets[0]!.dump();
      assert.ok(JSON.parse(targets[0]!.apply('{"format":"invalid"}')).error);
      assert.equal(targets[0]!.dump(), stable);
    } finally {
      native.close();
    }
  });
