import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { brotliCompressSync, constants } from "node:zlib";
import { measureBrowserBundle, bundleSizeTable, replaceBundleSizeTable } from "../scripts/bundle-size.ts";

test("browser size includes split chunks, workers and Wasm, compressed separately", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sqlike-bundle-size-"));
  try {
    const wasm = Buffer.concat([Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]), Buffer.alloc(6000, 42)]);
    await writeFile(join(dir, "runtime.wasm"), wasm);
    await writeFile(join(dir, "optional.js"), "export const value = 42;");
    await writeFile(join(dir, "worker.js"), "self.onmessage = () => self.postMessage('worker-ready');");
    await writeFile(join(dir, "entry.js"), `
export const wasmURL = new URL('./runtime.wasm', import.meta.url).href;
export const optional = () => import('./optional.js');
export const worker = () => new Worker(new URL('./worker.js', import.meta.url), {type: 'module'});
`);
    const result = await measureBrowserBundle(join(dir, "entry.js"));
    assert.deepEqual([...result.exports].sort(), ["optional", "wasmURL", "worker"]);
    assert.ok(result.assets.filter((a) => a.file.endsWith(".js")).length >= 3, "entry, dynamic chunk and worker must all count");
    const wasmAsset = result.assets.find((a) => a.file.endsWith(".wasm"));
    assert.ok(wasmAsset);
    assert.deepEqual(result.files.get(wasmAsset.file), wasm);
    assert.equal(result.totals.raw, [...result.files.values()].reduce((n, bytes) => n + bytes.length, 0));
    assert.equal(result.totals.brotli, [...result.files.values()].reduce((n, bytes) => n + brotliCompressSync(bytes, {params: {[constants.BROTLI_PARAM_QUALITY]: 11}}).length, 0));
    assert.equal(result.assets.length, result.files.size, "never count a shared asset twice");
    for (const [file, bytes] of result.files) if (file.endsWith(".js"))
      assert.doesNotMatch(bytes.toString("utf8"), /["']\/assets\//, "measured bundles must load from their own directory");
    await writeFile(join(dir, "package.json"), '{"type":"module"}');
    for (const [file, bytes] of result.files) {
      const target = join(dir, "dist", file);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
    const module = await import(pathToFileURL(join(dir, "dist", result.entry)).href);
    assert.deepEqual(await readFile(new URL(module.wasmURL)), wasm, "entry must resolve the emitted Wasm, including when served from a subdirectory");
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("README sizes use KiB and updates preserve surrounding user documentation", () => {
  const table = bundleSizeTable([{name: "fixture", totals: {raw: 2048, brotli: 1024}}]);
  assert.match(table, /fixture \| 2\.00 KiB \| 1\.00 KiB/);
  assert.match(table, /minified/);
  const before = "intro\n<!-- bundle-size:start -->\nold\n<!-- bundle-size:end -->\noutro\n";
  const updated = replaceBundleSizeTable(before, table);
  assert.ok(updated.startsWith("intro\n<!-- bundle-size:start -->\n"));
  assert.ok(updated.endsWith("<!-- bundle-size:end -->\noutro\n"));
  assert.ok(!updated.includes("\nold\n"));
  assert.equal(replaceBundleSizeTable(updated, table), updated);
  assert.throws(() => replaceBundleSizeTable("missing", table), /markers/);
  assert.throws(() => replaceBundleSizeTable(before + before, table), /markers/);
});

test("English and Japanese bundle tables share values and use localized build names", () => {
  const rows = [{id: "defined-without-three-wasm", name: "SQLike 0.1.0 / 事前定義・JSON・日時・windowなし / Wasm GC", totals: {raw: 2048, brotli: 1024}}];
  const english = bundleSizeTable(rows, "en");
  const japanese = bundleSizeTable(rows, "ja");
  assert.match(english, /Build/);
  assert.match(english, /Predefined, no JSON\/date\/window/);
  assert.doesNotMatch(english, /[\u3040-\u30ff\u3400-\u9fff]/);
  assert.match(japanese, /ビルド/);
  assert.match(japanese, /事前定義/);
  for (const table of [english, japanese]) assert.match(table, /2\.00 KiB \| 1\.00 KiB/);
  assert.equal(bundleSizeTable(rows), english);
});
