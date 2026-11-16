import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";
import { build } from "vite";

export interface BundleBytes { raw: number; brotli: number }
export interface BundleAsset extends BundleBytes { file: string; sha256: string }

/** Browser distribution assets, including emitted workers and lazy chunks. */
export async function measureBrowserBundle(entry: string) {
  const built = await build({
    configFile: false, publicDir: false, logLevel: "silent", base: "./", input: entry,
    worker: { format: "es" },
    build: {
      write: false, assetsInlineLimit: 0, minify: "oxc", target: "esnext",
      rolldownOptions: {
        preserveEntrySignatures: "strict",
        output: { format: "es", comments: { annotation: true, legal: true, jsdoc: false } },
      },
    },
  });
  const outputs = (Array.isArray(built) ? built : [built]).flatMap((b) => "output" in b ? b.output : []);
  const entries = outputs.filter((o) => o.type === "chunk" && o.isEntry);
  assert.equal(entries.length, 1, "expected one public browser entry");
  const entryChunk = entries[0]!;
  assert.ok(entryChunk.type === "chunk");
  const files = new Map<string, Buffer>();
  for (const output of outputs) {
    const bytes = Buffer.from(output.type === "chunk" ? output.code : output.source);
    if (files.has(output.fileName)) assert.deepEqual(files.get(output.fileName), bytes);
    files.set(output.fileName, bytes);
  }
  assert.ok(files.size > 0);
  for (const output of outputs) if (output.type === "chunk")
    for (const imported of [...output.imports, ...output.dynamicImports])
      assert.ok(files.has(imported), `unbundled import: ${imported}`);
  const assets: BundleAsset[] = [...files].sort(([a], [b]) => a.localeCompare(b)).map(([file, bytes]) => {
    const compressed = brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
    assert.deepEqual(brotliDecompressSync(compressed), bytes);
    return { file, raw: bytes.length, brotli: compressed.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  const totals = assets.reduce((a, b) => ({ raw: a.raw + b.raw, brotli: a.brotli + b.brotli }), { raw: 0, brotli: 0 });
  return { entry: entryChunk.fileName, exports: entryChunk.exports, assets, totals, files };
}

export function bundleSizeTable(rows: readonly { name: string; totals: BundleBytes }[]): string {
  const kib = (bytes: number) => `${(bytes / 1024).toFixed(2)} KiB`;
  return [
    "| ビルド | minified・未圧縮 | Brotli |",
    "| --- | ---: | ---: |",
    ...rows.map((r) => `| ${r.name} | ${kib(r.totals.raw)} | ${kib(r.totals.brotli)} |`),
  ].join("\n");
}

export function replaceBundleSizeTable(markdown: string, table: string): string {
  const start = "<!-- bundle-size:start -->", end = "<!-- bundle-size:end -->";
  assert.equal(markdown.split(start).length, 2, "README size markers must occur exactly once");
  assert.equal(markdown.split(end).length, 2, "README size markers must occur exactly once");
  const begin = markdown.indexOf(start) + start.length, finish = markdown.indexOf(end);
  assert.ok(begin < finish, "README size markers are reversed");
  return markdown.slice(0, begin) + "\n" + table + "\n" + markdown.slice(finish);
}
