import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import * as compiler from "../_build/js/release/build/mizchi/sqlike/compiler/compiler.js";
import { NodeDatabase } from "../adapters/node-database.ts";
import { aotBindings, aotValue } from "../src/aot-values.ts";
import type { Value } from "../src/contract.ts";
import { nativeValues } from "./compatibility/native-values.ts";
import { parseLogicTest, verifyLogicResult } from "./compatibility/sqllogictest.ts";
import { differentialCorpus } from "./compatibility/differential-corpus.ts";
import { oracleTraces } from "./compatibility/differential-node.ts";
import { value, datum, sqlError, runTrace, compareTraces } from "./compatibility/differential-core.ts";
import { buildSqlikeRuntime } from "../scripts/build-sqlike-runtime.ts";
import { defineSqlike, primaryKeyIndex, sqlitePages, ltx } from "../src/sqlike-features.ts";

const runtime = await import(pathToFileURL(resolve(
  "_build/js/release/build/mizchi/sqlike/experimental-aot-typed/experimental-aot-typed.js")).href) as {
  open(program: string, image: string): unknown;
  info(db: unknown): string;
  query_info(db: unknown, name: string): string;
  execute(db: unknown, name: string, bindings: string): string;
  prepare(db: unknown, name: string): unknown;
  values(query: unknown, bindings: string): Value[][];
  values_typed(query: unknown, bindings: readonly Value[]): Value[][];
  execute_typed(db: unknown, name: string, bindings: readonly Value[]): { names: string[]; rows: Value[][]; readonly: boolean; changes: number };
  finalize(query: unknown): string;
  snapshot(db: unknown): string;
  restore(db: unknown, image: string): string;
  set_clock(db: unknown, millis: string): string;
  clone(db: unknown): unknown;
};
const checked = (text: string) => { const r = JSON.parse(text); if (r.error) throw Object.assign(Error(r.error), { code: r.code }); return r; };
const compile = (schema: string[], queries: Record<string, string>) => {
  const program = compiler.compile_program(JSON.stringify({ schema,
    queries: Object.entries(queries).map(([name, sql]) => ({ name, sql })) }));
  checked(program); return program;
};

test("native AOT SELECT handles preserve values, live state, ownership and failure recovery", () => {
  const schema = ["CREATE TABLE t(id INTEGER PRIMARY KEY,body BLOB,n,v)"];
  const queries = {
    add: "INSERT INTO t VALUES(?,?,?,?) RETURNING id",
    point: "SELECT id AS same,body AS same,n,v FROM t WHERE id=?",
    set: "UPDATE t SET body=?,v=? WHERE id=?",
    constants: "SELECT ?,?,?,?,?,?,?",
    limited: "SELECT id FROM t ORDER BY id LIMIT ?",
    clock: "SELECT CURRENT_TIMESTAMP,changes(),last_insert_rowid()",
  };
  const db = runtime.open(compile(schema, queries), ""), native = new NodeDatabase(":memory:");
  const handles: unknown[] = [];
  const prepare = (name: string) => { const q = runtime.prepare(db, name); handles.push(q); return q; };
  const execute = (name: keyof typeof queries, params: Value[]) => checked(runtime.execute(db, name, aotBindings(params)));
  try {
    checked(runtime.info(db)); native.run(schema[0]!);
    const row: Value[] = [1n, Uint8Array.of(0, 17, 255), 10n, "old"];
    execute("add", row); native.run(queries.add, row);
    const point = prepare("point"), constants = prepare("constants"), limited = prepare("limited");
    assert.deepEqual(checked(runtime.query_info(db, "point")).names, ["same", "same", "n", "v"]);
    const params = [9223372036854775807n, -9223372036854775808n, 1.5, -0, "a\0日本語", null, Uint8Array.of(0, 255)];
    assert.deepEqual(runtime.values(constants, aotBindings(params)), nativeValues(native, queries.constants, params));
    const compare = () => assert.deepEqual(runtime.values(point, aotBindings([1n])), nativeValues(native, queries.point, [1n]));
    compare();
    const result = runtime.values(point, aotBindings([1n]));
    (result[0]![1] as Uint8Array)[0] = 99; result[0]![3] = "changed outside"; compare();
    for (const text of ["[]", "null", "[", '[{"t":"blob","v":[256]}]']) {
      assert.throws(() => runtime.values(point, text)); compare();
    }
    assert.throws(() => runtime.values(limited, aotBindings(["invalid"])));
    assert.deepEqual(runtime.values(limited, aotBindings([1n])), [[1n]]);
    checked(runtime.set_clock(db, "0"));
    const clock = prepare("clock");
    assert.deepEqual(runtime.values(clock, "[]"), nativeValues(native,
      "SELECT datetime(0,'unixepoch'),changes(),last_insert_rowid()"));
    const image = runtime.snapshot(db), beforeWrite = runtime.snapshot(db);
    assert.throws(() => runtime.values(prepare("add"), aotBindings([2n, null, 2n, "bad"])), /SELECT only/);
    assert.equal(runtime.snapshot(db), beforeWrite);
    const update: Value[] = [Uint8Array.of(7), "new", 1n]; execute("set", update); native.run(queries.set, update); compare();
    checked(runtime.restore(db, image));
    native.run(queries.set, [Uint8Array.of(0, 17, 255), "old", 1n]); compare();
    assert.ok(JSON.parse(runtime.restore(db, image.replace(/"programId":"[^"]+"/, '"programId":"wrong"'))).error);
    compare();
    const clone = runtime.clone(db), clonePoint = runtime.prepare(clone, "point"); handles.push(clonePoint);
    checked(runtime.execute(clone, "set", aotBindings([Uint8Array.of(8), "clone", 1n])));
    assert.deepEqual(runtime.values(clonePoint, aotBindings([1n])), [[1n, Uint8Array.of(8), 10n, "clone"]]); compare();
    assert.throws(() => runtime.values(prepare("missing"), "[]"), /query|missing/);
    checked(runtime.finalize(point)); checked(runtime.finalize(point));
    assert.throws(() => runtime.values(point, aotBindings([1n])), /finalized/);
    assert.deepEqual(runtime.values(limited, aotBindings([1n])), [[1n]]);
    const invalid = runtime.open("{}", "");
    assert.throws(() => runtime.values(runtime.prepare(invalid, "point"), "[]"));
  } finally { handles.forEach(q => checked(runtime.finalize(q))); native.close(); }
});

test("native AOT results match all 1000 upstream select1 queries", () => {
  const records = parseLogicTest(readFileSync("tests/fixtures/sqllogictest/select1.test", "utf8"));
  const statements = records.filter(r => r.kind === "statement"), queries = records.filter(r => r.kind === "query");
  const schema = statements.filter(s => /^CREATE TABLE /i.test(s.sql)), seeds = statements.filter(s => !schema.includes(s));
  const native = new NodeDatabase(":memory:");
  try {
    statements.forEach(s => native.run(s.sql));
    for (let offset = 0; offset < queries.length; offset += 100) {
      const batch = queries.slice(offset, offset + 100);
      const program = compile(schema.map(s => s.sql), Object.fromEntries([
        ...seeds.map((s, i) => [`seed${i}`, s.sql]), ...batch.map((q, i) => [`q${i}`, q.sql]),
      ]));
      const db = runtime.open(program, ""); checked(runtime.info(db));
      seeds.forEach((_, i) => checked(runtime.execute(db, `seed${i}`, "[]")));
      batch.forEach((q, i) => {
        const handle = runtime.prepare(db, `q${i}`);
        try {
          const actual = runtime.values(handle, "[]"), expected = nativeValues(native, q.sql);
          verifyLogicResult(q, actual); assert.deepEqual(actual, expected, `line ${q.line}`);
          assert.deepEqual(runtime.values_typed(handle, []), expected, `typed bind line ${q.line}`);
        } finally { checked(runtime.finalize(handle)); }
      });
    }
    assert.equal(queries.length, 1000);
  } finally { native.close(); }
});

for (const nativeBindings of [false,true]) test(`native AOT ${nativeBindings?"typed":"JSON"} bindings preserve the complete corpus and explicit compile boundaries`, () => {
  const cases = differentialCorpus(), oracle = oracleTraces(cases);
  const counts = { matched: 0, compileRejection: 0, notApplicable: 0 };
  for (const c of cases) {
    if (c.dynamicOnly) { counts.notApplicable++; continue; }
    const sqls = [...new Set([...(c.seed ?? []), ...c.steps, ...(c.observe ?? [])].map(op => op.sql))];
    const names = new Map(sqls.map((sql, i) => [sql, `q${i}`]));
    let program: string;
    try { program = compile(c.schema, Object.fromEntries(sqls.map(sql => [names.get(sql)!, sql]))); }
    catch (e) { assert.equal(oracle.compileErrors[c.id]?.kind, "error", c.id); counts.compileRejection++; continue; }
    const db = runtime.open(program, ""); checked(runtime.info(db));
    const plans = new Map(sqls.map(sql => [sql, runtime.prepare(db, names.get(sql)!)]));
    try {
      const actual = runTrace(c, {
        close() {},
        execute(op) {
          try {
            const name = names.get(op.sql)!, params = (op.params ?? []).map(value);
            const bindings = nativeBindings ? "" : aotBindings(params);
            const info = checked(runtime.query_info(db, name));
            try {
              const rows=nativeBindings?runtime.values_typed(plans.get(op.sql),params):runtime.values(plans.get(op.sql),bindings);
              return { kind: "rows", columns: info.names, rows: rows.map(row => row.map(datum)) };
            } catch (e) {
              if (!(e instanceof Error) || !/typed AOT results accept SELECT only/.test(e.message)) throw e;
            }
            if(nativeBindings) {
              const r=runtime.execute_typed(db,name,params);
              return {kind:"rows",columns:r.names,rows:r.rows.map(row=>row.map(datum))};
            }
            const r = checked(runtime.execute(db, name, bindings));
            return { kind: "rows", columns: r.names, rows: r.rows.map((row: any[]) => row.map(aotValue).map(datum)) };
          } catch (e) { return sqlError(e); }
        },
      }, { schema: false });
      const expected = oracle.traces[c.id]!;
      assert.deepEqual(compareTraces({ ...expected, setup: expected.setup.slice(c.schema.length) }, actual), [], c.id);
      counts.matched++;
    } finally { for (const plan of plans.values()) checked(runtime.finalize(plan)); }
  }
  assert.ok(cases.length >= 586, "the differential corpus must not shrink");
  assert.deepEqual(counts, { matched: cases.length - 4, compileRejection: 2, notApplicable: 2 });
});

test("native AOT runtime omits the SQL parser and default runtimes omit its bridge", () => {
  const code = readFileSync("_build/js/release/build/mizchi/sqlike/experimental-aot-typed/experimental-aot-typed.js", "utf8");
  assert.doesNotMatch(code, /function [^\n]*(parse__statement|database__prepare|prepare__sql__metadata)\(/);
  for (const path of ["sqlike/sqlike", "litestream-example/runtime/runtime"]) {
    const code = readFileSync(`_build/js/release/build/mizchi/${path}.js`, "utf8");
    assert.doesNotMatch(code, /aot__prepared__values|aot__prepare__values|native__result/);
  }
});

test("catalog-selected native AOT runtimes retain typed contracts and reject omitted capabilities", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sqlike-native-aot-selected-"));
  const catalog = { schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY)"], queries: [{ name: "q", sql: "SELECT ? AS v" }] };
  try {
    const built = await buildSqlikeRuntime(defineSqlike({ mode: "aot", features: [primaryKeyIndex] }), {
      outDir: dir, catalog, nativeResults: true,
    });
    const selected = await import(pathToFileURL(join(dir, "runtime.js")).href) as typeof runtime;
    const db = selected.open(compile(catalog.schema, { q: "SELECT ? AS v" }), ""); checked(selected.info(db));
    const query = selected.prepare(db, "q");
    assert.deepEqual(selected.values(query, aotBindings([9223372036854775807n])), [[9223372036854775807n]]);
    assert.deepEqual(selected.values_typed(query, [9223372036854775807n]), [[9223372036854775807n]]);
    assert.deepEqual(selected.execute_typed(db,"q",[-0]).rows,[[-0]]);
    checked(selected.finalize(query));
    const rejected = selected.open(compile(catalog.schema, { add: "INSERT INTO t VALUES(?)" }), "");
    assert.match(JSON.parse(selected.info(rejected)).error, /capability disabled/);
    assert.deepEqual(built.exports.toSorted(), Object.keys(runtime).toSorted());
    await writeFile(join(dir, "consumer.ts"), `import { open, prepare, values, finalize } from './runtime.js';
const db = open('', ''); const q = prepare(db, 'q');
const rows: (bigint | number | string | null | Uint8Array)[][] = values(q, '[]');
finalize(q);
// @ts-expect-error database handles are not statement handles
values(db, '[]');
void rows;\n`);
    execFileSync(resolve("node_modules/.bin/tsc"), ["--noEmit", "--skipLibCheck", "--target", "ES2023", "--module", "NodeNext", "--moduleResolution", "NodeNext", join(dir, "consumer.ts")], { cwd: dir, stdio: "pipe" });
    for (const options of [{ targets: ["wasm-gc"] as const }, {}]) {
      await assert.rejects(buildSqlikeRuntime(defineSqlike({ mode: options.targets ? "aot" : "sql" }), {
        outDir: join(dir, "invalid"), nativeResults: true, ...options,
      }), /native|JS|AOT/i);
    }
    await assert.rejects(buildSqlikeRuntime(defineSqlike({ mode: "aot", features: [sqlitePages, ltx] }), {
      outDir: join(dir, "ltx"), nativeResults: true,
    }), /native|export/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
