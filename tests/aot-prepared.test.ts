import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as compiler from "../_build/js/release/build/mizchi/sqlike/compiler/compiler.js";
import * as js from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "./compatibility/native-values.ts";
import { aotBindings, aotValue } from "../src/aot-values.ts";
import type { ResultCell, Value } from "../src/contract.ts";

const schema = [
  "CREATE TABLE t(id INTEGER PRIMARY KEY,body BLOB,n INTEGER UNIQUE)",
];
const queries = {
  add: "INSERT INTO t VALUES(?,?,?) RETURNING id,body",
  point: "SELECT body AS same,id AS same,t.*,_rowid_ FROM t WHERE id=?",
  limited: "SELECT id,body FROM t ORDER BY id LIMIT ? OFFSET ?",
  residual: "SELECT id,body FROM t WHERE id=? AND n>?",
  nested:
    "WITH a AS (SELECT * FROM t WHERE n>?) SELECT id,(SELECT length(t.body)) AS size FROM a AS t ORDER BY id",
  clock:
    "SELECT CURRENT_TIMESTAMP AS moment,changes() AS changed,last_insert_rowid() AS last",
  set: "UPDATE t SET body=?,n=? WHERE id=? RETURNING id,body,n",
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
assert.equal(JSON.parse(artifact).error, undefined);

const { instance } = await WebAssembly.instantiate(
  readFileSync(
    "_build/wasm-gc/release/build/mizchi/litestream-example/runtime/runtime.wasm",
  ),
  {},
  { builtins: ["js-string"], importedStringConstants: "_" },
);
for (const [target, runtime] of [
  ["js", js],
  ["wasm", instance.exports as unknown as typeof js],
] as const) {
  test(`prepared metadata stays valid across bind changes, errors and store replacement (${target})`, () => {
    const db = runtime.aot_open(artifact, ""),
      native = new NodeDatabase(":memory:");
    function execute(
      handle: typeof db,
      name: keyof typeof queries,
      params: Value[] = [],
    ) {
      const { error, names, rows } = JSON.parse(
        runtime.aot_execute(handle, name, aotBindings(params)),
      ) as {
        error?: string;
        names: string[];
        rows: ResultCell[][];
      };
      return { error, names, rows };
    }
    function compare(name: keyof typeof queries, params: Value[] = []) {
      const actual = execute(db, name, params);
      assert.equal(actual.error, undefined, name);
      const statement = native.raw.prepare(queries[name]);
      assert.deepEqual(
        actual.names,
        statement.columns().map((c) => c.name),
        name,
      );
      assert.deepEqual(
        actual.rows.map((row) => row.map(aotValue)),
        nativeValues(native, queries[name], params),
        name,
      );
      return actual;
    }
    try {
      for (const sql of schema) native.run(sql);
      compare("add", [1n, Uint8Array.of(0, 255), 10n]);
      compare("add", [2n, null, 20n]);
      for (const id of [1n, "1", 1, null, 9007199254740993n, Uint8Array.of(1), 2n])
        compare("point", [id]);
      for (const params of [
        [1n, 0n], [0n, 0n], [-1n, 1n], [2n, -1n],
      ] as Value[][])
        compare("limited", params);
      compare("residual", [1n, 5n]);
      compare("residual", [1n, 15n]);
      compare("nested", [0n]);
      for (const milliseconds of [0, 86400000]) {
        assert.equal(
          JSON.parse(runtime.aot_set_clock(db, String(milliseconds))).error,
          undefined,
        );
        const clock = execute(db, "clock");
        assert.equal(clock.error, undefined);
        assert.deepEqual(
          clock.rows.map((row) => row.map(aotValue)),
          nativeValues(native,
            "SELECT datetime(?,'unixepoch'),changes(),last_insert_rowid()",
            [milliseconds / 1000],
          ),
        );
      }

      // Invalid bindings and failed writes must not poison the next invocation.
      for (const bindings of [
        "[]", "null", '[{"t":"blob","v":[256]}]', "[",
      ])
        assert.ok(JSON.parse(runtime.aot_execute(db, "point", bindings)).error);
      assert.ok(execute(db, "limited", ["invalid", 0n]).error);
      assert.ok(execute(db, "set", [Uint8Array.of(99), 20n, 1n]).error);
      assert.throws(() =>
        nativeValues(native, queries.set, [Uint8Array.of(99), 20n, 1n]),
      );
      compare("point", [1n]);
      compare("limited", [2n, 0n]);

      const image = runtime.aot_dump(db),
        clone = runtime.aot_clone(db);
      compare("begin");
      compare("set", [Uint8Array.of(7, 8), 11n, 1n]);
      compare("point", [1n]);
      compare("rollback");
      compare("release");
      const original = compare("point", [1n]);
      compare("set", [Uint8Array.of(9), 11n, 1n]);
      assert.deepEqual(execute(clone, "point", [1n]), original);
      assert.equal(JSON.parse(runtime.aot_restore(db, image)).error, undefined);
      assert.deepEqual(execute(db, "point", [1n]), original);
      // The old image and Program remain readable after warming the cache.
      const reopened = runtime.aot_open(artifact, image);
      assert.deepEqual(execute(reopened, "point", [1n]), original);
    } finally {
      native.close();
    }
  });
}
