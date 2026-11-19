import assert from "node:assert/strict";
import { sourceHashes } from "./measurement-manifest.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  gzipSync,
  gunzipSync,
  brotliCompressSync,
  brotliDecompressSync,
  constants,
} from "node:zlib";
import { buildOxcBundle } from "./oxc-runtime.ts";

const hash = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
function sizes(value: Uint8Array) {
  const data = Buffer.from(value);
  const gzip = gzipSync(data, { level: 9 });
  const brotli = brotliCompressSync(data, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  });
  assert.deepEqual(gunzipSync(gzip), data);
  assert.deepEqual(brotliDecompressSync(brotli), data);
  return { raw: data.length, gzip: gzip.length, brotli: brotli.length };
}
const results = [];
for (const [name, module] of [
  ["AOT + SQLite writer + LTX", "mizchi/litestream-example/runtime/runtime"],
  ["SQLike dynamic SQL", "mizchi/sqlike/full/full"],
  ["Litestream", "mizchi/litestream/litestream"],
]) {
  const jsPath = `_build/js/release/build/${module}.js`;
  const wasmPath = `_build/wasm-gc/release/build/${module}.wasm`;
  const js = readFileSync(jsPath),
    wasm = readFileSync(wasmPath);
  const bundled = await buildOxcBundle(resolve(jsPath));
  const output = Array.isArray(bundled) ? bundled[0] : bundled;
  assert.ok(output && "output" in output);
  assert.equal(output.output.length, 1);
  const chunk = output.output[0]!;
  assert.equal(chunk.type, "chunk");
  if (chunk.type !== "chunk") throw Error("expected JS module");
  assert.deepEqual(chunk.imports, []);
  const minified = Buffer.from(chunk.code);
  const compiled = await WebAssembly.compile(wasm, {
    builtins: ["js-string"],
    importedStringConstants: "_",
  });
  assert.deepEqual(WebAssembly.Module.imports(compiled), []);
  const exports = WebAssembly.Module.exports(compiled)
    .map((item) => item.name)
    .sort();
  assert.deepEqual([...chunk.exports].sort(), exports);
  results.push({
    name,
    exports,
    js: {
      path: jsPath,
      sha256: hash(js),
      generated: sizes(js),
      minified: sizes(minified),
      minifiedSHA256: hash(minified),
    },
    wasm: {
      path: wasmPath,
      sha256: hash(wasm),
      bytes: sizes(wasm),
      nameSections: WebAssembly.Module.customSections(compiled, "name").length,
    },
  });
}
writeFileSync(
  "measurements/wasm-build-size-current.json",
  JSON.stringify(
    {
      format: 1,
      sourceHashes: sourceHashes([
        "scripts/measure-build-size.ts",
        "scripts/oxc-runtime.ts",
      ]),
      measuredAt: new Date().toISOString(),
      node: process.version,
      method:
        "Moon release JS / Wasm GC with exactly matching full export names. JS minified via Oxc client build, configFile=false, target=esnext, annotations and all entry exports retained, whitespace compacted. Wasm release output without additional wasm-opt. gzip level 9 / Brotli quality 11; round-trip verified. Standalone engine artifacts only; excludes HTML, loader/adapters, workers, application catalog and storage. Not an application transfer measurement.",
      results,
    },
    null,
    2,
  ) + "\n",
);
console.table(
  results.map((r) => ({
    name: r.name,
    jsBrotliKiB: (r.js.minified.brotli / 1024).toFixed(2),
    wasmBrotliKiB: (r.wasm.bytes.brotli / 1024).toFixed(2),
  })),
);
