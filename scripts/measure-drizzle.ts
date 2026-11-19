import assert from "node:assert/strict";
import { build } from "vite";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { engineSourcePaths, sourceHashes } from "./measurement-manifest.ts";
interface Asset {
  path: string;
  sha256: string;
  raw: number;
  gzip: number;
  brotli: number;
}
interface Result {
  name: string;
  entry: string;
  drizzleModules: number;
  assets: Asset[];
  totals: Record<string, number>;
}
const results: Result[] = [];
for (const [name, entry] of [
  ["SQLike adapter", "adapters/moon-database.ts"],
  ["SQLike + Drizzle + migrator", "scripts/fixtures/drizzle-runtime.ts"],
]) {
  const modules = new Set<string>();
  const output = await build({
    configFile: false,
    publicDir: false,
    logLevel: "error",
    plugins: [
      {
        name: "drizzle-graph",
        moduleParsed(m) {
          modules.add(m.id);
        },
      },
    ],
    worker: { format: "es" },
    build: {
      write: false,
      minify: true,
      target: "esnext",
      lib: { entry: entry!, formats: ["es"] },
    },
  });
  const assets: Asset[] = [];
  for (const b of Array.isArray(output) ? output : [output])
    if ("output" in b)
      for (const f of b.output) {
        const data = Buffer.from(f.type === "chunk" ? f.code : f.source);
        if (f.type === "chunk")
          assert.ok(f.imports.every((p) => !p.startsWith("node:")));
        assets.push({
          path: f.fileName,
          sha256: createHash("sha256").update(data).digest("hex"),
          raw: data.length,
          gzip: gzipSync(data, { level: 9 }).length,
          brotli: brotliCompressSync(data, {
            params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
          }).length,
        });
      }
  results.push({
    name: name!,
    entry: entry!,
    drizzleModules: [...modules].filter((p) => p.includes("/drizzle-orm/"))
      .length,
    assets,
    totals: Object.fromEntries(
      ["raw", "gzip", "brotli"].map((k) => [
        k,
        assets.reduce((n, a) => n + a[k as "raw" | "gzip" | "brotli"], 0),
      ]),
    ),
  });
}
assert.equal(results[0]!.drizzleModules, 0);
assert.ok(results[1]!.drizzleModules > 0);
const delta = Object.fromEntries(
  ["raw", "gzip", "brotli"].map((k) => [
    k,
    results[1]!.totals[k]! - results[0]!.totals[k]!,
  ]),
);
writeFileSync(
  "measurements/drizzle-size-current.json",
  JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      sourceHashes: sourceHashes([
        ...engineSourcePaths(),
        "scripts/measure-drizzle.ts",
        "scripts/fixtures/drizzle-runtime.ts",
        "adapters/drizzle.ts",
        "adapters/drizzle-migrator.ts",
        "src/migration-statements.ts",
        "adapters/moon-database.ts",
        "_build/js/release/build/mizchi/sqlike/full/full.js",
      ]),
      method:
        "All exported API retained, minified ES, includes dynamic persistence chunks/workers; compressed per asset then summed; paired build, not demo initial transfer or ORM performance",
      orm: "0.45.4",
      kit: "0.31.11",
      results,
      delta,
    },
    null,
    2,
  ) + "\n",
);
console.log({
  results: results.map(({ name, totals }) => ({ name, ...totals })),
  delta,
});
