import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as raw from "../_build/js/release/build/mizchi/litestream/litestream.js";
import { ltxPageWasm } from "../src/ltx-pages-host.ts";
import { toBase64, fromBase64 } from "../src/aot-values.ts";
import { applyLtx } from "../src/ltx.ts";

type TestRuntime = Pick<
  typeof raw,
  "encode_ltx_pages" | "encode_ltx" | "ltx_info" | "ltx_data"
>;
function exercise(runtime: TestRuntime) {
  let state = "",
    before = new Uint8Array(),
    tx = 0;
  for (const name of ["base.sqlite", "grown.sqlite", "shrunk.sqlite"]) {
    const after = new Uint8Array(readFileSync("tests/fixtures/ltx/" + name));
    const size = (after[16]! << 8) | after[17]!,
      pages: number[] = [];
    const data: Uint8Array[] = [];
    for (let p = 0; p < after.length / size; p++)
      if (
        !before.length ||
        !Buffer.from(after.subarray(p * size, (p + 1) * size)).equals(
          before.subarray(p * size, (p + 1) * size),
        )
      ) {
        pages.push(p + 1);
        data.push(after.slice(p * size, (p + 1) * size));
      }
    const meta = {
      pageSize: size,
      pageCount: after.length / size,
      pages,
      min: String(tx + 1),
      max: String(tx + 1),
      timestamp: "0",
      snapshot: !state,
    };
    const result = runtime.encode_ltx_pages(
      state,
      JSON.stringify(meta),
      Buffer.concat(data),
    );
    const info = JSON.parse(runtime.ltx_info(result));
    assert.equal(info.error, undefined);
    const file = runtime.ltx_data(result);
    assert.deepEqual(applyLtx(before, String(tx), file, 3).data, after);
    const whole = runtime.encode_ltx(
      before,
      after,
      String(tx + 1),
      String(tx + 1),
      "0",
    );
    assert.deepEqual(file, runtime.ltx_data(whole));
    state = JSON.stringify(info.pageState);
    assert.ok(state.length < after.length);
    before = after;
    tx++;
  }
  const stable = state;
  const bad = runtime.encode_ltx_pages(
    state,
    JSON.stringify({
      pageSize: 4096,
      pageCount: 3,
      pages: [1, 1],
      min: "4",
      max: "4",
      timestamp: "0",
      snapshot: false,
    }),
    new Uint8Array(8192),
  );
  assert.match(JSON.parse(runtime.ltx_info(bad)).error, /page|size/);
  assert.equal(state, stable);
}
test("LTX page batches compute incremental checksums through snapshot, delta, shrink and restart on JS/Wasm", async () => {
  exercise(raw);
  const wasm = (
    await WebAssembly.instantiate(
      readFileSync(
        "_build/wasm-gc/release/build/mizchi/litestream/litestream.wasm",
      ),
      {},
      { builtins: ["js-string"], importedStringConstants: "_" },
    )
  ).instance.exports;
  const core = wasm as unknown as typeof raw;
  exercise({
    ...ltxPageWasm(wasm),
    encode_ltx: (
      b: Uint8Array,
      a: Uint8Array,
      min: string,
      max: string,
      time: string,
    ) => core.encode_ltx_base64(toBase64(b), toBase64(a), min, max, time),
  } as unknown as TestRuntime);
});
