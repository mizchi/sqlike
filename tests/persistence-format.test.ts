import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as sql from "../_build/js/release/build/mizchi/sqlike/sqlike.js";
import * as aot from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import { aotBindings, aotValue } from "../src/aot-values.ts";
import type { ResultCell, Value } from "../src/contract.ts";

const legacy = JSON.parse(readFileSync("tests/fixtures/persistence/v1.json", "utf8"));
const schema = [legacy.snapshot.state.tables[0].sql as string];
const queries = [
  { name: "rows", sql: "SELECT id,n,typeof(n),hex(body) FROM t ORDER BY id" },
  { name: "edit", sql: "UPDATE t SET n=? WHERE id=?" },
];
const { artifact } = buildCatalog({ schema, queries });
const parse = (text: string) => {
  const value = JSON.parse(text);
  if (value.error) throw Error(value.error);
  return value;
};
async function wasm(path: string) {
  return (await WebAssembly.instantiate(readFileSync(path), {}, {
    builtins: ["js-string"], importedStringConstants: "_",
  })).instance.exports;
}
interface Driver {
  apply(text: string): string;
  wrap(data: unknown): string;
  edit(value: Value, id: bigint): void;
  rows(): Value[][];
  delta(): string;
  ack(): void;
  dump(): string;
}
const factories: { target: string; open(): Driver }[] = [];
for (const [target, r] of [
  ["JS", sql],
  ["Wasm", await wasm("_build/wasm-gc/release/build/mizchi/sqlike/sqlike.wasm") as unknown as typeof sql],
] as const) factories.push({
  target: `dynamic ${target}`,
  open() {
    const db = r.database_open();
    return {
      apply: text => r.database_apply_delta(db, text),
      wrap: JSON.stringify,
      edit: (value, id) => { parse(r.database_exec(db, queries[1]!.sql, aotBindings([value, id]), false)); },
      rows: () => parse(r.database_query_values(db, queries[0]!.sql, "[]")).rows.map((row: ResultCell[]) => row.map(aotValue)),
      delta: () => r.database_delta(db, false),
      ack: () => { parse(r.database_ack_delta(db, r.database_serial(db))); },
      dump: () => r.database_dump(db),
    };
  },
});
for (const [target, r] of [
  ["JS", aot],
  ["Wasm", await wasm("_build/wasm-gc/release/build/mizchi/litestream-example/runtime/runtime.wasm") as unknown as typeof aot],
] as const) factories.push({
  target: `AOT ${target}`,
  open() {
    const db = r.aot_open(artifact, ""), info = () => parse(r.aot_info(db));
    return {
      apply: text => r.aot_apply_delta(db, text),
      wrap: data => JSON.stringify({ format: "aot-flush@1", programId: info().programId, data }),
      edit: (value, id) => { parse(r.aot_execute(db, "edit", aotBindings([value, id]))); },
      rows: () => parse(r.aot_execute(db, "rows", "[]")).rows.map((row: ResultCell[]) => row.map(aotValue)),
      delta: () => r.aot_delta(db, false),
      ack: () => { parse(r.aot_ack_delta(db, info().serial)); },
      dump: () => r.aot_dump(db),
    };
  },
});

for (const { target, open } of factories) {
  test(`v1 snapshot/after-image replays before v2 patches (${target})`, () => {
    const source = open(), receiver = open();
    for (const db of [source, receiver]) {
      parse(db.apply(db.wrap(legacy.snapshot)));
      parse(db.apply(db.wrap(legacy.delta)));
    }
    assert.deepEqual(source.rows(), [
      [2n, 2n, "integer", "1234"], [9n, 2.5, "real", "00FF"],
    ]);
    source.ack();
    for (const value of [0, -0, 0n, null, Uint8Array.of(0, 255)] as Value[]) {
      source.edit(value, 9n);
      parse(receiver.apply(source.delta()));
      assert.deepEqual(receiver.rows(), source.rows());
      assert.equal(receiver.dump(), source.dump());
      source.ack();
    }
  });

  test(`malformed column patches reject atomically, including a late error (${target})`, () => {
    const source = open(), receiver = open();
    for (const db of [source, receiver]) {
      parse(db.apply(db.wrap(legacy.snapshot)));
      parse(db.apply(db.wrap(legacy.delta)));
    }
    source.ack();
    source.edit(3n, 9n);
    const outer = JSON.parse(source.delta()), body = outer.data ?? outer;
    assert.equal(body.format, "sqlike-flush@2");
    assert.deepEqual(body.edits, [["PatchRow", "t", "9", "9", [[1, ["Integer", "3"]]]]]);
    const stable = receiver.dump();
    const corruptions = [
      (v: any) => { v.edits[0][4].push(v.edits[0][4][0]); },
      (v: any) => { v.edits[0][4] = [[2, ["Null"]], [1, ["Null"]]]; },
      (v: any) => { v.edits[0][4][0][0] = -1; },
      (v: any) => { v.edits[0][4][0][0] = 3; },
      (v: any) => { v.edits[0][4][0][0] = 1.5; },
      (v: any) => { v.edits[0][4] = [[0, ["Integer", "1"]]]; },
      (v: any) => { v.edits[0][4][0][1] = ["Real", "NaN"]; },
      (v: any) => { v.format = "sqlike-flush@1"; },
      (v: any) => { v.format = "sqlike-flush@3"; },
      (v: any) => { v.serial += 0.5; },
      (v: any) => { v.base += 0.5; },
      (v: any) => { v.meta.cookie += 0.5; },
      (v: any) => { v.meta.changes += 0.5; },
      (v: any) => { v.edits.push(["DeleteRow", "t", "missing"]); },
      (v: any) => { v.edits.push(["DeleteRow", "t", "999"]); },
    ];
    for (const damage of corruptions) {
      const next = structuredClone(body);
      damage(next);
      assert.ok(JSON.parse(receiver.apply(receiver.wrap(next))).error, JSON.stringify(next.edits));
      assert.equal(receiver.dump(), stable);
    }
    parse(receiver.apply(source.delta()));
    assert.deepEqual(receiver.rows(), source.rows());
    assert.ok(JSON.parse(receiver.apply(source.delta())).error);
  });
}
