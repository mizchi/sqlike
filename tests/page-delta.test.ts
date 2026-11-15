import { test } from "node:test";
import assert from "node:assert/strict";
import { pageDelta, applyPageDelta } from "../adapters/page-delta.ts";
test("binary page edits preserve exact bytes through overwrite, growth, shrink and empty images", () => {
  let before = new Uint8Array(4096 * 3).fill(7);
  for (const size of [4096 * 3, 4096 * 4 + 5, 4096 + 3, 0, 4096]) {
    const next = new Uint8Array(size).fill(7);
    if (size) next[Math.floor(size / 2)] = 19;
    const stable = before.slice();
    const delta = pageDelta(before, next, 4096);
    assert.deepEqual(applyPageDelta(before, delta), next);
    assert.deepEqual(before, stable);
    assert.ok(delta.blobs!.every((b) => b.buffer.byteLength === b.byteLength));
    before = next;
  }
});
test("a one-byte edit submits one owned page and malformed page batches leave the source unchanged", () => {
  const before = new Uint8Array(4096 * 8),
    next = before.slice();
  next[4097] = 1;
  const delta = pageDelta(before, next, 4096);
  assert.equal(delta.blobs!.length, 1);
  assert.equal(delta.blobs![0]!.byteLength, 4096);
  assert.deepEqual(applyPageDelta(before, delta), next);
  const bad = structuredClone(delta);
  bad.blobs![0] = new Uint8Array(1);
  assert.throws(() => applyPageDelta(before, bad), /page/);
  assert.deepEqual(before, new Uint8Array(4096 * 8));
  assert.throws(() => pageDelta(before, next, 1000), /page/);
});
