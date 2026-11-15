import assert from "node:assert/strict";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import { build } from "vite";
const bundled = await build({
  configFile: false,
  publicDir: false,
  logLevel: "silent",
  build: {
    write: false,
    minify: true,
    target: "esnext",
    lib: { entry: "src/search.ts", formats: ["es"] },
  },
});
const output = Array.isArray(bundled) ? bundled[0] : bundled;
assert.ok(output && "output" in output);
const chunk = output.output.find((x) => x.type === "chunk");
assert.ok(chunk && chunk.type === "chunk");
assert.deepEqual(chunk.imports, []);
const js = Buffer.from(chunk.code),
  wasm = readFileSync(
    "_build/wasm-gc/release/build/mizchi/sqlike/fts/fts.wasm",
  );
const sizes = (data: Uint8Array) => ({
  raw: data.length,
  gzip: gzipSync(data, { level: 9 }).length,
  brotli: brotliCompressSync(data, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }).length,
});
const hash = (x: Uint8Array) => createHash("sha256").update(x).digest("hex");
const report = {
  format: 1,
  measuredAt: new Date().toISOString(),
  method:
    "Optional SearchIndex wrapper + complete MoonBit FTS JS API, minified with Vite, gzip9/Brotli11. Wasm module only, without wrapper. Not added to SQL/AOT transfer.",
  js: { ...sizes(js), sha256: hash(js) },
  wasm: { ...sizes(wasm), sha256: hash(wasm) },
};
for (const dir of ["dist/assets", "dist/lite/assets"])
  for (const file of readdirSync(dir))
    if (file.endsWith(".js"))
      assert.ok(
        !readFileSync(`${dir}/${file}`, "utf8").includes("sqlike-search@1"),
        `optional FTS leaked: ${dir}/${file}`,
      );
writeFileSync(
  "measurements/search-current.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
