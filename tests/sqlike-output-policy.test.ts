import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as js from "../_build/js/release/build/mizchi/sqlike/sqlike.js";
import * as aot from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import * as compiler from "../_build/js/release/build/mizchi/sqlike/compiler/compiler.js";
import { aotValue, aotBindings } from "../src/aot-values.ts";
import { typedRows } from "./compatibility/feature-audit.ts";
import { outputPolicyCases } from "./compatibility/output-policy-corpus.ts";
function state(image: string) {
  const s = JSON.parse(image).state;
  delete s.changes;
  delete s.last_rowid;
  return JSON.stringify(s);
}
test("successful outputs agree with SQLite; explicit rejections leave data and schema unchanged", async () => {
  const wasm = async (path: string) =>
    (
      await WebAssembly.instantiate(
        readFileSync(path),
        {},
        { builtins: ["js-string"], importedStringConstants: "_" },
      )
    ).instance.exports;
  const wr = (await wasm(
    "_build/wasm-gc/release/build/mizchi/sqlike/sqlike.wasm",
  )) as unknown as typeof js;
  const wa = (await wasm(
    "_build/wasm-gc/release/build/mizchi/litestream-example/runtime/runtime.wasm",
  )) as unknown as typeof aot;
  for (const c of outputPolicyCases()) {
    const n = new DatabaseSync(":memory:");
    n.exec("PRAGMA foreign_keys=ON");
    try {
      for (const sql of [...c.schema, ...c.seed]) n.exec(sql);
      const observeNative = () =>
        (c.observe ?? []).map((sql) => {
          const q = n.prepare(sql);
          q.setReadBigInts(true);
          q.setReturnArrays(true);
          return typedRows(q.all() as never);
        });
      const initialObservations = observeNative();
      let expected: unknown,
        nativeError = false;
      try {
        const s = n.prepare(c.sql);
        s.setReadBigInts(true);
        s.setReturnArrays(true);
        expected = s.all(...(c.params ?? []));
      } catch {
        nativeError = true;
      }
      if (c.mustSucceed) assert.equal(nativeError, false, c.sql);
      const observations = observeNative();
      for (const [name, r] of [
        ["js", js],
        ["wasm", wr],
      ] as const) {
        const d = r.database_open();
        for (const sql of [...c.schema, ...c.seed])
          assert.equal(
            JSON.parse(r.database_exec(d, sql, "[]", false)).error,
            undefined,
          );
        const before = state(r.database_dump(d));
        const res = JSON.parse(
          r.database_is_readonly(c.sql)
            ? r.database_query_values(d, c.sql, aotBindings(c.params ?? []))
            : r.database_exec(d, c.sql, aotBindings(c.params ?? []), false),
        );
        if (res.error) {
          assert.ok(!c.mustSucceed, `${name}: ${c.sql}: ${res.error}`);
          assert.equal(state(r.database_dump(d)), before, c.sql);
          if (!nativeError) assert.match(res.error, /unsupported/i, c.sql);
        } else {
          assert.equal(c.mustReject, false, `${name} must reject ${c.sql}`);
          assert.equal(
            nativeError,
            false,
            `${name} accepted invalid SQL ${c.sql}`,
          );
          assert.equal(
            typedRows(
              res.rows.map((v: any) =>
                (Array.isArray(v) ? v : Object.values(v)).map(aotValue),
              ),
            ),
            typedRows(expected as never),
            `${name}: ${c.sql}`,
          );
        }
        for (const [i, sql] of (c.observe ?? []).entries()) {
          const rows = JSON.parse(r.database_query_values(d, sql, "[]"));
          assert.equal(rows.error, undefined, sql);
          assert.equal(
            typedRows(rows.rows.map((row: any[]) => row.map(aotValue))),
            (res.error ? initialObservations : observations)[i],
            `${name}: state after ${c.sql}`,
          );
        }
      }
      const artifact = compiler.compile_program(
        JSON.stringify({
          schema: c.schema,
          queries: [
            ...c.seed.map((sql, i) => ({ name: `seed${i}`, sql })),
            { name: "probe", sql: c.sql },
            ...(c.observe ?? []).map((sql, i) => ({
              name: `observe${i}`,
              sql,
            })),
          ],
        }),
      );
      if (JSON.parse(artifact).error) {
        assert.ok(!c.mustSucceed, `${c.sql}: ${JSON.parse(artifact).error}`);
        assert.ok(
          nativeError || /unsupported/i.test(JSON.parse(artifact).error),
        );
        continue;
      }
      for (const r of [aot, wa]) {
        const d = r.aot_open(artifact, "");
        assert.equal(JSON.parse(r.aot_info(d)).error, undefined);
        for (let i = 0; i < c.seed.length; i++)
          assert.equal(
            JSON.parse(r.aot_execute(d, `seed${i}`, "[]")).error,
            undefined,
          );
        const before = state(r.aot_dump(d));
        const res = JSON.parse(
          r.aot_execute(d, "probe", aotBindings(c.params ?? [])),
        );
        if (res.error) {
          assert.ok(!c.mustSucceed, `${c.sql}: ${res.error}`);
          assert.equal(state(r.aot_dump(d)), before, c.sql);
          if (!nativeError) assert.match(res.error, /unsupported/i, c.sql);
        } else {
          assert.equal(c.mustReject, false, c.sql);
          assert.equal(nativeError, false, c.sql);
          assert.equal(
            typedRows(res.rows.map((v: any[]) => v.map(aotValue))),
            typedRows(expected as never),
            c.sql,
          );
        }
        for (const [i, sql] of (c.observe ?? []).entries()) {
          const rows = JSON.parse(r.aot_execute(d, `observe${i}`, "[]"));
          assert.equal(rows.error, undefined, sql);
          assert.equal(
            typedRows(rows.rows.map((row: any[]) => row.map(aotValue))),
            (res.error ? initialObservations : observations)[i],
            `AOT state after ${c.sql}`,
          );
        }
      }
    } finally {
      n.close();
    }
  }
});

test("compiled expressions cannot silently fall back for unknown operators or collations", () => {
  for (const expression of [
    [
      "Binary",
      "unknown",
      ["Literal", ["Integer", "1"]],
      ["Literal", ["Integer", "2"]],
    ],
    ["Unary", "unknown", ["Literal", ["Integer", "1"]]],
    ["Collate", ["Literal", ["Text", "a"]], "unknown"],
    ["Cast", ["Literal", ["Integer", "1"]], "unknown"],
  ]) {
    const artifact = JSON.parse(
      compiler.compile_program(
        JSON.stringify({
          schema: [],
          queries: [{ name: "q", sql: "SELECT 1" }],
        }),
      ),
    );
    artifact.queries[0].statement[1].projections[0].expression = expression;
    const db = aot.aot_open(JSON.stringify(artifact), "");
    assert.match(JSON.parse(aot.aot_info(db)).error, /unsupported/);
  }
});

test("UTF-16 TEXT hex agrees with SQLite and unverified binary coercions reject", async () => {
  for (const encoding of ["UTF-16le", "UTF-16be"]) {
    const n = new DatabaseSync(":memory:");
    const d = js.database_open();
    try {
      for (const sql of [
        `PRAGMA encoding='${encoding}'`,
        "CREATE TABLE t(v TEXT)",
        "INSERT INTO t VALUES('A')",
      ]) {
        n.exec(sql);
        assert.equal(
          JSON.parse(js.database_exec(d, sql, "[]", false)).error,
          undefined,
        );
      }
      for (const sql of [
        "SELECT hex('A'),hex(v),hex(upper(v)),hex(42) FROM t",
        "SELECT v,length(v),octet_length(v) FROM t",
      ]) {
        const s = n.prepare(sql);
        s.setReadBigInts(true);
        s.setReturnArrays(true);
        const result = JSON.parse(js.database_query_values(d, sql, "[]"));
        assert.equal(result.error, undefined);
        assert.equal(
          typedRows(result.rows.map((r: any[]) => r.map(aotValue))),
          typedRows(s.all() as never),
        );
      }
      for (const sql of [
        "SELECT hex(CAST('A' AS BLOB))",
        "SELECT hex(CAST(x'4100' AS TEXT))",
        "SELECT hex(lower(x'4100'))",
      ])
        assert.match(
          JSON.parse(js.database_query_values(d, sql, "[]")).error,
          /unsupported SQL/,
        );
    } finally {
      n.close();
    }
  }
});

test("legacy dynamic images recover declaration spelling without rewriting stored bytes", () => {
  const db = js.database_open();
  assert.equal(
    JSON.parse(
      js.database_exec(
        db,
        "CREATE TABLE t(a REAL DEFAULT 1e2,b TEXT DEFAULT NULL,c TEXT)",
        "[]",
        false,
      ),
    ).error,
    undefined,
  );
  const old = JSON.parse(js.database_dump(db));
  for (const col of old.state.tables[0].columns) delete col.default_source;
  const legacy = JSON.stringify(old);
  const restored = js.database_open();
  assert.equal(
    JSON.parse(js.database_restore(restored, legacy)).error,
    undefined,
  );
  const info = JSON.parse(
    js.database_query_values(restored, "PRAGMA table_info(t)", "[]"),
  );
  assert.equal(info.error, undefined);
  assert.deepEqual(
    info.rows.map((row: any[]) => aotValue(row[4])),
    ["1e2", "NULL", null],
  );
  assert.equal(js.database_dump(restored), legacy);
});
