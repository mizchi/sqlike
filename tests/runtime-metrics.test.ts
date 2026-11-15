import { test } from "node:test";
import assert from "node:assert/strict";
import { wasmSections, allocationProbe } from "../scripts/runtime-metrics.ts";
import { runInNewContext } from "node:vm";

test("Wasm section accounting includes headers and rejects truncated sections", () => {
  const bytes = Uint8Array.from([
    0, 97, 115, 109, 1, 0, 0, 0, 0, 7, 3, 100, 98, 103, 1, 2, 3, 10, 1, 0,
  ]);
  const sections = wasmSections(bytes);
  assert.equal(
    sections.reduce((n, s) => n + s.totalBytes, 8),
    bytes.length,
  );
  assert.equal(sections[0]?.customName, "dbg");
  assert.equal(sections[1]?.name, "code");
  assert.throws(() => wasmSections(bytes.slice(0, -1)), /truncated/);
});
test("memory probe records shared linear memory and observes growth", () => {
  const context = {
    WebAssembly: { Memory: WebAssembly.Memory },
    SharedArrayBuffer,
  };
  const snapshot = runInNewContext(
    `(${allocationProbe.toString()})();const m=new WebAssembly.Memory({initial:2,maximum:4,shared:true});const a=new SharedArrayBuffer(1024);m.grow(1);globalThis.__runtimeAllocationSnapshot()`,
    context,
  );
  assert.equal(snapshot.linearBytes, 3 * 65536);
  assert.equal(snapshot.memories[0].shared, true);
  assert.equal(snapshot.memories.length, 1);
});
