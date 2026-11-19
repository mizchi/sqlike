import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as raw from "../_build/js/release/build/mizchi/litestream/litestream.js";
import { applyLtx } from "../src/ltx.ts";
import { toBase64, fromBase64 } from "../src/aot-values.ts";
interface Runtime {
  encode_ltx_pages_binary(
    state: string,
    metadata: string,
    data: Uint8Array,
    previous: Uint8Array,
  ): unknown;
  encode_ltx_pages(state: string, metadata: string, data: Uint8Array): unknown;
  encode_ltx(
    base: Uint8Array,
    data: Uint8Array,
    min: string,
    max: string,
    time: string,
  ): unknown;
  ltx_info(result: unknown): string;
  ltx_data(result: unknown): Uint8Array;
}
function exercise(core: Runtime) {
  for (const legacy of [false, true]) {
    let state = "",
      before: Uint8Array = new Uint8Array(),
      tx = 0;
    const crcs = new Map<number, Uint8Array>();
    for (const name of ["base.sqlite", "grown.sqlite", "shrunk.sqlite"]) {
      const after = Uint8Array.from(readFileSync("tests/fixtures/ltx/" + name)),
        size = (after[16]! << 8) | after[17]!,
        count = after.length / size,
        oldCount = before.length / size;
      const pages = Array.from({ length: count }, (_, i) => i + 1).filter(
        (p) =>
          !Buffer.from(after.subarray((p - 1) * size, p * size)).equals(
            before.subarray((p - 1) * size, p * size),
          ),
      );
      const snapshot = tx === 0;
      const meta = {
        pageSize: size,
        pageCount: count,
        pages,
        min: String(tx + 1),
        max: String(tx + 1),
        timestamp: "0",
        snapshot,
      };
      const data = Buffer.concat(
        pages.map((p) => after.subarray((p - 1) * size, p * size)),
      );
      if (legacy && tx === 0) {
        const first = core.encode_ltx_pages("", JSON.stringify(meta), data),
          info = JSON.parse(core.ltx_info(first));
        state = JSON.stringify(info.pageState);
      } else {
        const previous =
          state && JSON.parse(state).format === "ltx-page-state@2" && !snapshot
            ? Buffer.concat(
                [
                  ...pages.filter((p) => p <= oldCount),
                  ...Array.from(
                    { length: Math.max(oldCount - count, 0) },
                    (_, i) => count + 1 + i,
                  ),
                ].map((p) => {
                  const crc = crcs.get(p);
                  assert.ok(crc);
                  return crc;
                }),
              )
            : new Uint8Array();
        const inputState = state;
        const result = core.encode_ltx_pages_binary(
            inputState,
            JSON.stringify(meta),
            data,
            previous,
          ),
          info = JSON.parse(core.ltx_info(result));
        assert.equal(info.error, undefined);
        assert.equal(info.pageState.format, "ltx-page-state@2");
        assert.equal(info.pageState.pages, undefined);
        assert.ok(JSON.stringify(info.pageState).length < 256);
        const bytes = core.ltx_data(result),
          full = core.encode_ltx(
            before,
            after,
            String(tx + 1),
            String(tx + 1),
            "0",
          );
        assert.deepEqual(bytes, core.ltx_data(full));
        assert.deepEqual(applyLtx(before, String(tx), bytes, 3).data, after);
        const next = fromBase64(info.pageChecksums);
        assert.equal(next.length, pages.length * 8);
        // Legacy migration can seed its unchanged CRCs directly from the old catalog.
        if (legacy && tx === 1)
          for (const [p, n] of JSON.parse(state).pages) {
            const b = new Uint8Array(8);
            new DataView(b.buffer).setBigUint64(0, BigInt(n));
            crcs.set(p, b);
          }
        pages.forEach((p, i) => crcs.set(p, next.slice(i * 8, (i + 1) * 8)));
        for (const p of crcs.keys()) if (p > count) crcs.delete(p);
        state = JSON.stringify(info.pageState);
        const bad = core.encode_ltx_pages_binary(
          JSON.stringify({ ...info.pageState, checksum: "1" }),
          JSON.stringify({
            ...meta,
            min: String(tx + 2),
            max: String(tx + 2),
            snapshot: false,
          }),
          data,
          previous,
        );
        if (previous.length) {
          const truncated = core.encode_ltx_pages_binary(
            inputState,
            JSON.stringify(meta),
            data,
            previous.subarray(1),
          );
          assert.match(
            JSON.parse(core.ltx_info(truncated)).error,
            /trunc|payload/,
          );
        }
        const fractional = core.encode_ltx_pages_binary(
          state,
          JSON.stringify({ ...meta, pageCount: count + 0.5 }),
          data,
          previous,
        );
        assert.match(JSON.parse(core.ltx_info(fractional)).error, /integer/);
        assert.match(JSON.parse(core.ltx_info(bad)).error, /state|seal/);
        const noop = core.encode_ltx_pages_binary(
          state,
          JSON.stringify({
            ...meta,
            pages: [],
            min: String(tx + 2),
            max: String(tx + 2),
            snapshot: false,
          }),
          new Uint8Array(),
          new Uint8Array(),
        );
        assert.equal(JSON.parse(core.ltx_info(noop)).error, undefined);
        assert.deepEqual(
          core.ltx_data(noop),
          core.ltx_data(
            core.encode_ltx(after, after, String(tx + 2), String(tx + 2), "0"),
          ),
        );
      }
      before = after;
      tx++;
    }
  }
}
test("binary CRC deltas preserve exact LTX bytes through growth, shrink, legacy migration and JS/Wasm", async () => {
  exercise(raw as unknown as Runtime);
  const wasm = (
    await WebAssembly.instantiate(
      readFileSync(
        "_build/wasm-gc/release/build/mizchi/litestream/litestream.wasm",
      ),
      {},
      { builtins: ["js-string"], importedStringConstants: "_" },
    )
  ).instance.exports as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  exercise({
    encode_ltx_pages_binary: (s, m, d, p) =>
      wasm.encode_ltx_pages_binary_base64!(s, m, toBase64(d), toBase64(p)),
    encode_ltx_pages: (s, m, d) =>
      wasm.encode_ltx_pages_base64!(s, m, toBase64(d)),
    encode_ltx: (b, a, min, max, t) =>
      wasm.encode_ltx_base64!(toBase64(b), toBase64(a), min, max, t),
    ltx_info: (r) => wasm.ltx_info!(r) as string,
    ltx_data: (r) => fromBase64(wasm.ltx_data_base64!(r) as string),
  });
});
