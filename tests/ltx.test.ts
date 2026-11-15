import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyLtx, planLtx } from "../src/ltx.ts";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/ltx/${name}`, import.meta.url)));

test("apply real Litestream LTX files to the same bytes as official restore", () => {
  const files: string[] = JSON.parse(new TextDecoder().decode(fixture("litestream.json")));
  let image = new Uint8Array(); let txid = "0";
  for (const file of files) {
    const result = applyLtx(image, txid, fixture(file), 3);
    image = result.data; txid = result.info.maxTXID;
  }
  assert.deepEqual(image, fixture("litestream-restored.sqlite"));
});

test("reference encoder: checksummed snapshot, delta, shrink and legacy LZ4 frame", () => {
  const snapshot = applyLtx(new Uint8Array(), "0", fixture("snapshot.ltx"), 3);
  assert.deepEqual(snapshot.data, fixture("base.sqlite"));
  const delta = applyLtx(snapshot.data, snapshot.info.maxTXID, fixture("delta.ltx"), 3);
  assert.deepEqual(delta.data, fixture("grown.sqlite"));
  const shrink = applyLtx(delta.data, delta.info.maxTXID, fixture("shrink.ltx"), 3);
  assert.deepEqual(shrink.data, fixture("shrunk.sqlite"));
  assert.ok(shrink.data.length < delta.data.length);
  assert.deepEqual(applyLtx(new Uint8Array(), "0", fixture("legacy-frame.ltx"), 3).data, snapshot.data);
});

test("reject gaps, repeated files, corrupt pages/index/checksums and preserve base bytes", () => {
  const snapshot = applyLtx(new Uint8Array(), "0", fixture("snapshot.ltx"), 3);
  const original = snapshot.data.slice();
  assert.throws(() => applyLtx(new Uint8Array(), "0", fixture("delta.ltx"), 3), /gap|snapshot/i);
  assert.throws(() => applyLtx(snapshot.data, snapshot.info.maxTXID, fixture("snapshot.ltx"), 3), /stale|repeated/i);
  assert.throws(() => applyLtx(snapshot.data, snapshot.info.maxTXID, fixture("shrink.ltx"), 3), /gap/i);
  for (const position of [0, 4, 12, 104, 120, fixture("delta.ltx").length - 25, fixture("delta.ltx").length - 1]) {
    const corrupted = fixture("delta.ltx"); corrupted[position] = corrupted[position]! ^ 1;
    assert.throws(() => applyLtx(snapshot.data, snapshot.info.maxTXID, corrupted, 3));
    assert.deepEqual(snapshot.data, original);
  }
  const bytes = fixture("delta.ltx");
  for (const size of [0, 99, 106, bytes.length - 1]) assert.throws(() => applyLtx(snapshot.data, "1", bytes.subarray(0, size), 3));
  assert.throws(() => applyLtx(snapshot.data, "1", bytes, 2), /version/i);
  const wrongBase = snapshot.data.slice(); wrongBase[500] = wrongBase[500]! ^ 1;
  assert.throws(() => applyLtx(wrongBase, "1", bytes, 3), /checksum/i);
});

test("compacted overlapping ranges are applied with post-state validation; TXID stays uint64", () => {
  const snapshot = applyLtx(new Uint8Array(), "0", fixture("snapshot.ltx"), 3);
  const grown = applyLtx(snapshot.data, "1", fixture("delta.ltx"), 3);
  assert.deepEqual(applyLtx(grown.data, "2", fixture("overlap.ltx"), 3).data, fixture("shrunk.sqlite"));
  const high = applyLtx(snapshot.data, "9007199254740993", fixture("high-txid.ltx"), 3);
  assert.equal(high.info.maxTXID, "9007199254740994");
});

test("restore planning spans compacted levels and rejects missing ranges", () => {
  const file = (id: string, minTXID: string, maxTXID: string, size = 100) => ({ id, minTXID, maxTXID, size });
  const catalog = [file("snapshot", "1", "4"), file("l0-5", "5", "5"), file("l1", "4", "7"), file("l0-8", "8", "8")];
  assert.deepEqual(planLtx(catalog, "0", "8"), ["snapshot", "l1", "l0-8"]);
  assert.deepEqual(planLtx(catalog, "7", "8"), ["l0-8"]);
  assert.throws(() => planLtx([file("snapshot", "1", "4"), file("gap", "6", "7")], "0", "7"), /gap/i);
  assert.deepEqual(planLtx(catalog, "8", "8"), []);
});
