import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as sql from "../../_build/js/release/build/mizchi/sqlike/sqlike.js";
import * as aot from "../../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import { buildCatalog } from "../../scripts/aot-compiler.ts";
import { aotBindings, aotValue } from "../../src/aot-values.ts";
import { NodeDatabase } from "../../adapters/node-database.ts";
import { nativeValues } from "./native-values.ts";
import type { Cell, Value } from "../../src/contract.ts";
export function result(text: string): any {
  const r = JSON.parse(text);
  if (r.error) throw Error(r.error);
  return r;
}
export async function sqlikePaths(
  schema: string[],
  queries: { name: string; sql: string; write?: boolean }[],
) {
  const wasm = async (path: string) =>
    (
      await WebAssembly.instantiate(
        readFileSync(path),
        {},
        { builtins: ["js-string"], importedStringConstants: "_" },
      )
    ).instance.exports;
  const built = buildCatalog({ schema, queries }),
    paths = [];
  for (const r of [
    sql,
    (await wasm(
      "_build/wasm-gc/release/build/mizchi/sqlike/sqlike.wasm",
    )) as unknown as typeof sql,
  ]) {
    const db = r.database_open();
    for (const s of schema) result(r.database_exec(db, s, "[]", false));
    paths.push({
      exec: (name: string, params: Value[] = []) => {
        const q = queries.find((q) => q.name === name)!;
        return result(
          q.write
            ? r.database_exec(db, q.sql, aotBindings(params), false)
            : r.database_query_values(db, q.sql, aotBindings(params)),
        ).rows.map((row: Cell[] | Record<string, Cell>) =>
          (Array.isArray(row) ? row : Object.values(row)).map(aotValue),
        );
      },
      dump: () => r.database_dump(db),
      restore: (s: string) => result(r.database_restore(db, s)),
    });
  }
  for (const r of [
    aot,
    (await wasm(
      "_build/wasm-gc/release/build/mizchi/litestream-example/runtime/runtime.wasm",
    )) as unknown as typeof aot,
  ]) {
    const db = r.aot_open(built.artifact, "");
    result(r.aot_info(db));
    paths.push({
      exec: (name: string, params: Value[] = []) =>
        result(r.aot_execute(db, name, aotBindings(params))).rows.map(
          (r: Cell[]) => r.map(aotValue),
        ),
      dump: () => r.aot_dump(db),
      restore: (s: string) => result(r.aot_restore(db, s)),
    });
  }
  return paths;
}
export async function compareQueries(
  queries: string[],
  schema: string[] = [],
  seed: string[] = [],
) {
  const names = queries.map((sql, i) => ({ name: `q${i}`, sql, write: /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql) }));
  const seeds = seed.map((sql, i) => ({ name: `seed${i}`, sql, write: true }));
  const paths = await sqlikePaths(schema, [...seeds, ...names]);
  const native = new NodeDatabase(":memory:");
  try {
    for (const s of schema) native.raw.exec(s);
    for (const s of seeds) {
      native.raw.exec(s.sql);
      for (const p of paths) p.exec(s.name);
    }
    for (const q of names) {
      const expected = nativeValues(native, q.sql);
      for (const [i, p] of paths.entries())
        assert.deepEqual(p.exec(q.name), expected, `${i}: ${q.sql}`);
    }
  } finally {
    native.close();
  }
}
