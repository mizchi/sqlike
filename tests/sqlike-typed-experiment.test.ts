import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { aotBindings } from "../src/aot-values.ts";
import type { Value } from "../src/contract.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "./compatibility/native-values.ts";
import { parseLogicTest, differentialLogicTest } from "./compatibility/sqllogictest.ts";
import { differentialCorpus } from "./compatibility/differential-corpus.ts";
import { oracleDriver } from "./compatibility/differential-node.ts";
import { datum, value, runTrace, compareTraces, sqlError } from "./compatibility/differential-core.ts";
import { aotValue } from "../src/aot-values.ts";

const runtime = await import(pathToFileURL(resolve(
  "_build/js/release/build/mizchi/sqlike/experimental-typed/experimental-typed.js")).href) as {
  open(): unknown;
  exec(db: unknown, sql: string, bindings: string): string;
  prepare(db: unknown, sql: string): unknown;
  values(query: unknown, bindings: string): Value[][];
};
const execute = (db: unknown, sql: string, params: Value[] = []) => {
  const r = JSON.parse(runtime.exec(db, sql, aotBindings(params)));
  if (r.error) throw Error(r.error);
};

test("experimental native JS rows preserve classes, int64, duplicate positions and detached blobs", () => {
  const db = runtime.open();
  const native = new NodeDatabase(":memory:");
  const query = (sql: string, params: Value[] = []) => runtime.values(runtime.prepare(db, sql), aotBindings(params));
  try {
    const sql = "SELECT ? AS v,? AS v,? AS v,? AS v,? AS v";
    const params = [9223372036854775807n, -9223372036854775808n, 1.5, "a\0日本語", null];
    assert.deepEqual(query(sql, params), nativeValues(native, sql, params));
    assert.ok(Object.is(query("SELECT ?", [-0])[0]![0], -0));
    execute(db, "CREATE TABLE t(id INTEGER PRIMARY KEY,b BLOB)");
    execute(db, "INSERT INTO t VALUES(1,?)", [Uint8Array.of(0, 17, 255)]);
    const q = runtime.prepare(db, "SELECT b FROM t WHERE id=?");
    const result = runtime.values(q, aotBindings([1n]));
    (result[0]![0] as Uint8Array)[0] = 99;
    assert.deepEqual(runtime.values(q, aotBindings([1n])), [[Uint8Array.of(0, 17, 255)]]);
    assert.throws(() => runtime.values(q, "[]"), /binding count/);
    assert.throws(() => query("DELETE FROM t"), /read.only|SELECT/i);
    assert.deepEqual(query("SELECT count(*) FROM t"), [[1n]]);
  } finally { native.close(); }
});

test("experimental native JS results match all 1000 upstream queries", () => {
  const db = runtime.open(), native = new NodeDatabase(":memory:");
  try {
    assert.deepEqual(differentialLogicTest(
      parseLogicTest(readFileSync("tests/fixtures/sqllogictest/select1.test", "utf8")),
      { execute: sql => native.run(sql), query: sql => nativeValues(native, sql) },
      { execute: sql => execute(db, sql), query: sql => runtime.values(runtime.prepare(db, sql), "[]") },
    ), { statements: 31, queries: 1000 });
  } finally { native.close(); }
});


test("the native-result bridge is absent from default SQL and AOT runtimes", () => {
  for (const path of ["sqlike/sqlike", "litestream-example/runtime/runtime"])
    assert.doesNotMatch(readFileSync(`_build/js/release/build/mizchi/${path}.js`, "utf8"), /query__prepared__values|NativeValue/);
});

test("experimental SELECT results preserve the complete supported differential corpus", () => {
  const cases = differentialCorpus();
  assert.ok(cases.length >= 586, "the differential corpus must not shrink");
  for (const c of cases) {
    const native = oracleDriver(), db = runtime.open();
    try {
      const expected = runTrace(c, native);
      const actual = runTrace(c, {
        close() {},
        execute(op) {
          try {
            const bindings = aotBindings((op.params ?? []).map(value));
            try {
              return { kind: "rows", rows: runtime.values(runtime.prepare(db, op.sql), bindings).map(row => row.map(datum)) };
            } catch (e) {
              if (!(e instanceof Error) || !/typed results accept SELECT only/.test(e.message)) throw e;
            }
            const result = JSON.parse(runtime.exec(db, op.sql, bindings));
            if (result.error) throw Object.assign(Error(result.error), { code: result.code });
            return { kind: "rows", rows: result.rows.map((row: any) =>
              (Array.isArray(row) ? row : Object.values(row)).map(aotValue).map(datum)) };
          } catch (e) { return sqlError(e); }
        },
      });
      assert.deepEqual(compareTraces(expected, actual), [], c.id);
    } finally { native.close(); }
  }
});
