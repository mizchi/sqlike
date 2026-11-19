import { test } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as js from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import { aotBindings, fromBase64, toBase64 } from "../src/aot-values.ts";
const check = (text: string) => {
  const value = JSON.parse(text);
  if (value.error) throw Error(value.error);
  return value;
};
async function runtimes() {
  const raw = (
    await WebAssembly.instantiate(
      readFileSync(
        "_build/wasm-gc/release/build/mizchi/litestream-example/runtime/runtime.wasm",
      ),
      {},
      { builtins: ["js-string"], importedStringConstants: "_" },
    )
  ).instance.exports as any;
  return [
    js,
    {
      ...raw,
      sqlite_data: (r: unknown) => fromBase64(raw.sqlite_data_base64(r)),
      aot_snapshot_supply: (r: unknown, data: Uint8Array) =>
        raw.aot_snapshot_supply_base64(r, toBase64(data)),
    },
  ] as any[];
}
const artifact = buildCatalog({
  schema: [
    "CREATE TABLE t(id INTEGER PRIMARY KEY AUTOINCREMENT,n INTEGER,s TEXT,b BLOB, g INTEGER GENERATED ALWAYS AS (n+1) VIRTUAL)",
    "CREATE TABLE empty(k TEXT PRIMARY KEY) WITHOUT ROWID",
  ],
  queries: [
    { name: "add", sql: "INSERT INTO t(n,s,b) VALUES(?,?,?)" },
    { name: "update", sql: "UPDATE t SET n=? WHERE id=?" },
    { name: "delete", sql: "DELETE FROM t WHERE id=?" },
    { name: "begin", sql: "BEGIN" },
    { name: "rollback", sql: "ROLLBACK" },
  ],
}).artifact;
test("logical chunks preserve frozen rows, holes, sequence, generated values and metadata on JS/Wasm", async () => {
  for (const r of await runtimes()) {
    const db = r.aot_open(artifact, "");
    for (let i = 0; i < 150; i++)
      check(
        r.aot_execute(
          db,
          "add",
          aotBindings([
            BigInt(i),
            "日本語🦀" + i,
            new Uint8Array([0, 255, i % 256]),
          ]),
        ),
      );
    check(r.aot_execute(db, "delete", aotBindings([70n])));
    const expected = JSON.parse(r.aot_dump(db));
    const snapshot = r.aot_snapshot_open(db),
      header = check(r.aot_snapshot_info(snapshot));
    assert.equal(header.format, "moon-aot-chunks@1");
    assert.ok(header.parts >= 3);
    check(r.aot_execute(db, "update", aotBindings([900n, 1n])));
    const chunks: Uint8Array[] = Array.from(
      { length: header.parts },
      (_, i) => {
        const v = r.aot_snapshot_chunk(snapshot, i);
        check(r.sqlite_info(v));
        return r.sqlite_data(v);
      },
    );
    const restored = r.aot_open(artifact, ""),
      reader = r.aot_snapshot_restore(restored, JSON.stringify(header));
    for (const c of chunks) check(r.aot_snapshot_supply(reader, c));
    check(r.aot_snapshot_finish(reader));
    assert.deepEqual(JSON.parse(r.aot_dump(restored)), expected);
    check(r.aot_execute(restored, "add", aotBindings([1n, "next", null])));
    const dumped = JSON.parse(r.aot_dump(restored));
    assert.equal(dumped.state.last_rowid, "151");
    const before = r.aot_dump(restored);
    for (const variant of [
      chunks.slice(1),
      [chunks[1], chunks[0], ...chunks.slice(2)],
      [
        Uint8Array.from(chunks[0]!, (b, i) => (i === 30 ? b ^ 1 : b)),
        ...chunks.slice(1),
      ],
    ]) {
      const reader = r.aot_snapshot_restore(restored, JSON.stringify(header));
      let failed = false;
      for (const c of variant) {
        if (JSON.parse(r.aot_snapshot_supply(reader, c)).error) {
          failed = true;
          break;
        }
      }
      assert.ok(JSON.parse(r.aot_snapshot_finish(reader)).error || failed);
      assert.equal(r.aot_dump(restored), before);
    }
    const stale = r.aot_snapshot_restore(restored, JSON.stringify(header));
    for (const c of chunks) check(r.aot_snapshot_supply(stale, c));
    check(r.aot_execute(restored, "update", aotBindings([901n, 1n])));
    assert.ok(JSON.parse(r.aot_snapshot_finish(stale)).error);
    check(r.aot_execute(restored, "begin", "[]"));
    assert.ok(
      JSON.parse(r.aot_snapshot_info(r.aot_snapshot_open(restored))).error,
    );
    check(r.aot_execute(restored, "rollback", "[]"));
  }
});

test("empty logical snapshots finalize once and reject wrong identity, invalid counts and extra parts", async () => {
  for (const r of await runtimes()) {
    const db = r.aot_open(artifact, "");
    const s = r.aot_snapshot_open(db),
      text = r.aot_snapshot_info(s),
      h = check(text);
    assert.equal(h.parts, 0);
    const reader = r.aot_snapshot_restore(db, text);
    check(r.aot_snapshot_finish(reader));
    assert.ok(JSON.parse(r.aot_snapshot_finish(reader)).error);
    assert.ok(JSON.parse(r.sqlite_info(r.aot_snapshot_chunk(s, 0))).error);
    assert.ok(JSON.parse(r.sqlite_info(r.aot_snapshot_chunk(s, -1))).error);
    for (const header of [
      { ...h, programId: "wrong" },
      { ...h, parts: 1 },
      { ...h, rows: [1, 0] },
      { ...h, serial: -1 },
      { ...h, blocks: [2147483647, 0] },
    ]) {
      const before = r.aot_dump(db),
        reader = r.aot_snapshot_restore(db, JSON.stringify(header));
      assert.ok(JSON.parse(r.aot_snapshot_finish(reader)).error);
      assert.equal(r.aot_dump(db), before);
    }
  }
});

test("valid binary checksums cannot hide invalid logical row constraints", async () => {
  for (const r of await runtimes()) {
    const source = r.aot_open(artifact, "");
    for (let i = 0; i < 2; i++)
      check(
        r.aot_execute(source, "add", aotBindings([BigInt(i), "text", null])),
      );
    const snapshot = r.aot_snapshot_open(source),
      header = r.aot_snapshot_info(snapshot);
    const part = r.aot_snapshot_chunk(snapshot, 0);
    check(r.sqlite_info(part));
    const bytes = Uint8Array.from(r.sqlite_data(part) as Uint8Array);
    let offset = 16;
    const uint = () => {
      let n = 0,
        shift = 0,
        b: number;
      do {
        b = bytes[offset++]!;
        n |= (b & 127) << shift;
        shift += 7;
      } while (b & 128);
      return n;
    };
    const strings = uint();
    for (let i = 0; i < strings; i++) {
      const length = uint();
      offset += length;
    }
    uint(); // header seal string reference
    uint(); // chunk ordinal
    assert.equal(uint(), 2);
    const first = offset;
    offset += 8;
    const columns = uint();
    for (let i = 0; i < columns; i++) {
      const tag = uint();
      if (tag === 1 || tag === 2) offset += 8;
      else if (tag === 3) uint();
      else if (tag === 4) {
        const length = uint();
        offset += length;
      } else assert.equal(tag, 0);
    }
    // Duplicate a rowid, then reseal the frame: structural/checksum validation passes.
    bytes.set(bytes.slice(first, first + 8), offset);
    bytes.set(
      createHash("sha256")
        .update(bytes.subarray(0, bytes.length - 32))
        .digest(),
      bytes.length - 32,
    );
    const target = r.aot_open(artifact, ""),
      before = r.aot_dump(target),
      reader = r.aot_snapshot_restore(target, header);
    check(r.aot_snapshot_supply(reader, bytes));
    assert.ok(JSON.parse(r.aot_snapshot_finish(reader)).error);
    assert.equal(r.aot_dump(target), before);
  }
});

test("incremental logical snapshots reuse only matching frozen blocks across metadata and table offsets", async () => {
  for (const r of await runtimes()) {
    const db = r.aot_open(artifact, "");
    for (let i = 0; i < 150; i++)
      check(r.aot_execute(db, "add", aotBindings([BigInt(i), "text", null])));
    const before = r.aot_snapshot_incremental(db),
      h = check(r.aot_snapshot_info(before));
    assert.equal(h.format, "moon-aot-chunks@2");
    const old = Array.from(
      { length: h.parts },
      (_, i) => r.sqlite_data(r.aot_snapshot_chunk(before, i)) as Uint8Array,
    );
    let offset = 16;
    const uint = () => {
      let value = 0,
        shift = 0,
        byte: number;
      do {
        byte = old[0]![offset++]!;
        value |= (byte & 127) << shift;
        shift += 7;
      } while (byte & 128);
      return value;
    };
    uint();
    const size = uint();
    assert.equal(
      new TextDecoder().decode(old[0]!.subarray(offset, offset + size)),
      h.programId,
    );
    check(r.aot_execute(db, "update", aotBindings([900n, 70n])));
    const after = r.aot_snapshot_incremental(db),
      header = r.aot_snapshot_info(after);
    assert.deepEqual(
      [0, 1, 2].map((i) => r.aot_snapshot_reuse(after, before, i)),
      [0, -1, 2],
    );
    const fresh = r.aot_open(artifact, ""),
      reader = r.aot_snapshot_restore(fresh, header);
    for (let i = 0; i < h.parts; i++) {
      const previous = r.aot_snapshot_reuse(after, before, i);
      check(
        r.aot_snapshot_supply(
          reader,
          previous < 0
            ? r.sqlite_data(r.aot_snapshot_chunk(after, i))
            : old[previous],
        ),
      );
    }
    check(r.aot_snapshot_finish(reader));
    assert.deepEqual(JSON.parse(r.aot_dump(fresh)), JSON.parse(r.aot_dump(db)));
    const third = r.aot_snapshot_incremental(db);
    assert.deepEqual(
      [0, 1, 2].map((i) => r.aot_snapshot_reuse(third, after, i)),
      [0, 1, 2],
    );
    assert.equal(r.aot_snapshot_reuse(after, r.aot_snapshot_open(db), 0), -1);
    // Wrong block locations and old snapshots remain distinguishable by the wire reader.
    const invalid = r.aot_snapshot_restore(fresh, header),
      unchanged = r.aot_dump(fresh);
    assert.ok(JSON.parse(r.aot_snapshot_supply(invalid, old[1])).error);
    assert.ok(JSON.parse(r.aot_snapshot_finish(invalid)).error);
    assert.equal(r.aot_dump(fresh), unchanged);
  }
});

test("incremental chunk references follow table/block identity when earlier tables grow", async () => {
  const program = buildCatalog({
    schema: [
      "CREATE TABLE a(id INTEGER PRIMARY KEY)",
      "CREATE TABLE b(id INTEGER PRIMARY KEY)",
    ],
    queries: [
      { name: "a", sql: "INSERT INTO a VALUES(?)" },
      { name: "b", sql: "INSERT INTO b VALUES(?)" },
    ],
  }).artifact;
  for (const r of await runtimes()) {
    const db = r.aot_open(program, "");
    for (let i = 1; i <= 64; i++)
      check(r.aot_execute(db, "a", aotBindings([BigInt(i)])));
    check(r.aot_execute(db, "b", aotBindings([1n])));
    const before = r.aot_snapshot_incremental(db);
    const old = [0, 1].map((i) =>
      r.sqlite_data(r.aot_snapshot_chunk(before, i)),
    );
    check(r.aot_execute(db, "a", aotBindings([65n])));
    const next = r.aot_snapshot_incremental(db);
    assert.deepEqual(
      [0, 1, 2].map((i) => r.aot_snapshot_reuse(next, before, i)),
      [0, -1, 1],
    );
    const target = r.aot_open(program, ""),
      reader = r.aot_snapshot_restore(target, r.aot_snapshot_info(next));
    for (let i = 0; i < 3; i++) {
      const reuse = r.aot_snapshot_reuse(next, before, i);
      check(
        r.aot_snapshot_supply(
          reader,
          reuse < 0 ? r.sqlite_data(r.aot_snapshot_chunk(next, i)) : old[reuse],
        ),
      );
    }
    check(r.aot_snapshot_finish(reader));
    assert.equal(r.aot_dump(target), r.aot_dump(db));
  }
});
