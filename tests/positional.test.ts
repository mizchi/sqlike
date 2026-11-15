import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MoonDatabase,
  type MoonSqlRuntime,
} from "../adapters/moon-database.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import type { DrizzleClient } from "../src/drizzle-contract.ts";
import { readFileSync } from "node:fs";

test("mutable positional execution preserves duplicate names, RETURNING types and rollback on JS/Wasm", async () => {
  const wasm = (
    await WebAssembly.instantiate(
      readFileSync("_build/wasm-gc/release/build/mizchi/sqlike/sqlike.wasm"),
      {},
      { builtins: ["js-string"], importedStringConstants: "_" },
    )
  ).instance.exports as unknown as MoonSqlRuntime;
  for (const runtime of [undefined, wasm]) {
    const native = new NodeDatabase(":memory:"),
      moon = new MoonDatabase(undefined, undefined, runtime);
    const n = native as unknown as DrizzleClient,
      m = moon as unknown as DrizzleClient;
    try {
      for (const db of [n, m])
        db.run(
          "CREATE TABLE t(id INTEGER PRIMARY KEY,n ANY,title TEXT UNIQUE)",
        );
      for (const [sql, params] of [
        [
          "INSERT INTO t VALUES(?,?,?) RETURNING id,id+1 AS id,n,typeof(n),title",
          [9007199254740993n, 1, "\ufeffa\0b"],
        ],
        ["INSERT INTO t VALUES(2,2,'two') RETURNING *", []],
        [
          "SELECT a.id,b.id,a.title,b.title FROM t a JOIN t b ON a.id<>b.id ORDER BY a.id",
          [],
        ],
        ["UPDATE t SET n=n+1 WHERE id=2 RETURNING id,n,n+1 AS id", []],
        ["DELETE FROM t WHERE id=2 RETURNING id,title,id AS title", []],
      ] as const)
        assert.deepEqual(
          m.values(sql, [...params]),
          n.values(sql, [...params]),
          sql,
        );
      assert.throws(() =>
        m.values("UPDATE t SET title='x' RETURNING unknown(title)"),
      );
      assert.deepEqual(
        m.values("SELECT id,title FROM t"),
        n.values("SELECT id,title FROM t"),
      );
      assert.throws(() =>
        m.transaction(() => {
          m.values("INSERT INTO t VALUES(3,3,'three') RETURNING id");
          throw Error("rollback");
        }),
      );
      assert.deepEqual(
        m.values("SELECT id,title FROM t"),
        n.values("SELECT id,title FROM t"),
      );
      assert.throws(
        () =>
          moon.queryValues(
            "INSERT INTO t VALUES(4,4,'read only') RETURNING id",
          ),
        /read-only/,
      );
    } finally {
      moon.close();
      native.close();
    }
  }
});
