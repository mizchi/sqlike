import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { brotliCompressSync, constants } from "node:zlib";
import { createHash } from "node:crypto";
import { buildSqlikeRuntime } from "./build-sqlike-runtime.ts";
import { defineSqlike, type SqlikeFeature } from "../src/sqlike-features.ts";
import { buildCatalog } from "./aot-compiler.ts";
import { buildDefinedCatalog } from "./defined-compiler.ts";
import { openCompiled } from "../src/sqlike-runtime.ts";
import { createDefinedDatabase } from "../adapters/defined-database-core.ts";
import { engineSourcePaths, sourceHashes } from "./measurement-manifest.ts";
import type { CatalogSource } from "../src/aot-contract.ts";
import type { Value } from "../src/contract.ts";

export async function measureOptionalFeature({ id, feature, catalog, expected, runner }: {
  id: string; feature: SqlikeFeature; catalog: CatalogSource; expected: Value[][]; runner: string;
}) {
  assert.match(id, /^[a-z-]+$/);
  const results: {
    mode: "aot" | "defined"; enabled: boolean; features: readonly string[]; exports: string[];
    minifiedBytes: number; brotliBytes: number; sha256: string;
  }[] = [];
  for (const mode of ["aot", "defined"] as const) {
    for (const enabled of [false, true]) {
      const built = await buildSqlikeRuntime(defineSqlike({ mode, features: enabled ? [feature] : [] }), {
        outDir: join(`generated/${id}`, mode, String(enabled)), targets: ["js"],
      });
      const path = join(built.directory, "runtime.js");
      const bytes = await readFile(path);
      const raw = await import(pathToFileURL(path).href);
      const open = async () => mode === "aot"
        ? openCompiled(raw, buildCatalog(catalog).artifact)
        : await createDefinedDatabase(raw).memory(buildDefinedCatalog(catalog));
      if (enabled) {
        const db = await open();
        try { assert.deepEqual((await db.execute("q")).rows, expected); }
        finally { if ("close" in db && typeof db.close === "function") await db.close(); }
      } else { await assert.rejects(open(), /feature disabled|required feature/); }
      results.push({
        mode, enabled, features: built.profile.features, exports: [...built.exports].sort(),
        minifiedBytes: bytes.byteLength,
        brotliBytes: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    const [off, on] = results.filter(r => r.mode === mode);
    assert.deepEqual(off!.exports, on!.exports);
  }
  await writeFile(`measurements/${id}-size-current.json`, JSON.stringify({
    format: `sqlike-${id}-size@1`, measuredAt: new Date().toISOString(), node: process.version,
    scope: "Standalone Oxc-minified JS engines; identical manual-profile exports; no host adapter/catalog; Brotli quality 11",
    feature: feature.name, catalog,
    sources: sourceHashes([...engineSourcePaths(), runner, "scripts/measure-optional-feature.ts", "scripts/build-sqlike-runtime.ts", "scripts/oxc-runtime.ts", "src/sqlike-features.ts"]),
    results,
  }, null, 2) + "\n");
  console.table(results.map(({ mode, enabled, minifiedBytes, brotliBytes }) => ({ mode, enabled, minifiedBytes, brotliBytes })));
}
