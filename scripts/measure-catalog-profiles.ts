import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";
import { createHash } from "node:crypto";
import { buildSqlikeRuntime } from "./build-sqlike-runtime.ts";
import { analyzeCatalogRequirements } from "./analyze-catalog.ts";
import { buildCatalog } from "./aot-compiler.ts";
import { buildDefinedCatalog } from "./defined-compiler.ts";
import { defineSqlike, primaryKeyIndex } from "../src/sqlike-features.ts";
import { openCompiled } from "../src/sqlike-runtime.ts";
import { createDefinedDatabase } from "../adapters/defined-database-core.ts";
import { definedWasm } from "../adapters/defined-wasm.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "../tests/compatibility/native-values.ts";
import { sourceHashes, engineSourcePaths } from "./measurement-manifest.ts";
import type { CatalogSource } from "../src/aot-contract.ts";
import type { Value } from "../src/contract.ts";

const fixtures: { id: string; source: CatalogSource; runs: [string, Value[]][] }[] = [
  {
    id: "readonly",
    source: {
      schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,body TEXT)"],
      queries: [{ name: "get", sql: "SELECT id,body FROM t WHERE id=?" }],
    },
    runs: [["get", [1n]]],
  },
  {
    id: "scalar-read",
    source: { schema: [], queries: [{ name: "q", sql: "SELECT glob('[a-z]','a'),char(65)" }] },
    runs: [["q", []]],
  },
  {
    id: "notes",
    source: JSON.parse(await readFile("examples/notes/catalog.json", "utf8")),
    runs: [
      ["add", [1n, "Alpha", 3n]],
      ["list", []],
      ["edit", ["Beta", 4n, 1n]],
      ["get", [1n]],
      ["count", []],
      ["erase", [1n]],
      ["count", []],
    ],
  },
];
const directory = resolve("generated/catalog-profiles");
await mkdir(directory, { recursive: true });
async function size(path: string) {
  const bytes = await readFile(path);
  const compressed = brotliCompressSync(bytes, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  });
  assert.deepEqual(brotliDecompressSync(compressed), bytes);
  return {
    path: path.replace(resolve(".") + "/", ""),
    raw: bytes.length,
    brotli: compressed.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
const results = [];
for (const fixture of fixtures) {
  const requirements = analyzeCatalogRequirements(fixture.source);
  for (const mode of ["aot", "defined"] as const) {
    const profile = defineSqlike({
      mode,
      features: [primaryKeyIndex, ...requirements.features.map((name) => ({ name }))],
    });
    const builds = {
      baseline: await buildSqlikeRuntime(profile, {
        outDir: join(directory, fixture.id, mode, "baseline"),
      }),
      selected: await buildSqlikeRuntime(profile, {
        catalog: fixture.source,
        outDir: join(directory, fixture.id, mode, "selected"),
      }),
    };
    assert.deepEqual(builds.baseline.profile, builds.selected.profile);
    const assets = {} as Record<
      keyof typeof builds,
      { js: Awaited<ReturnType<typeof size>>; wasm: Awaited<ReturnType<typeof size>> }
    >;
    for (const [kind, built] of Object.entries(builds) as [
      keyof typeof builds,
      (typeof builds)["baseline"],
    ][]) {
      const js = await import(pathToFileURL(join(built.directory, "runtime.js")).href);
      assert.deepEqual(Object.keys(js).sort(), [...built.exports].sort());
      const wasm = (
        await WebAssembly.instantiate(
          await readFile(join(built.directory, "runtime.wasm")),
          {},
          { builtins: ["js-string"], importedStringConstants: "_" },
        )
      ).instance.exports;
      for (const [target, raw] of [
        ["js", js],
        ["wasm", wasm],
      ] as const) {
        const native = new NodeDatabase(":memory:");
        const db =
          mode === "aot"
            ? openCompiled(raw as any, buildCatalog(fixture.source).artifact)
            : await createDefinedDatabase(target === "js" ? (raw as any) : definedWasm(raw)).memory(
                buildDefinedCatalog(fixture.source),
              );
        try {
          for (const ddl of fixture.source.schema) native.raw.exec(ddl);
          for (const [name, params] of fixture.runs) {
            const sql = fixture.source.queries.find((q) => q.name === name)!.sql;
            assert.deepEqual(
              (await db.execute(name, params)).rows,
              nativeValues(native, sql, params),
              `${fixture.id}/${mode}/${kind}/${target}/${name}`,
            );
          }
        } finally {
          native.close();
          if ("close" in db && typeof db.close === "function") await db.close();
        }
      }
      assets[kind] = {
        js: await size(join(built.directory, "runtime.js")),
        wasm: await size(join(built.directory, "runtime.wasm")),
      };
    }
    assert.ok(
      assets.selected.js.raw < assets.baseline.js.raw,
      "catalog specialization must remove code",
    );
    results.push({
      id: fixture.id,
      mode,
      source: fixture.source,
      profile,
      requirements,
      exports: builds.selected.exports,
      verified: true,
      operations: fixture.runs.length,
      assets,
    });
    console.log(
      fixture.id,
      mode,
      "JS Brotli",
      assets.baseline.js.brotli,
      "->",
      assets.selected.js.brotli,
      "Wasm Brotli",
      assets.baseline.wasm.brotli,
      "->",
      assets.selected.wasm.brotli,
    );
  }
}
await writeFile(
  "measurements/catalog-profiles-current.json",
  JSON.stringify(
    {
      format: "sqlike-catalog-profiles@1",
      measuredAt: new Date().toISOString(),
      node: process.version,
      nativeSQLite: process.versions.sqlite,
      method:
        "Runtime assets only. Identical semantic feature profiles, exports and primary-key-index setting. Baseline retains all core function/statement implementations; selected runtime infers the complete schema/query closure. Oxc minified ESM, release Wasm GC; Brotli quality 11 per asset with round trip. Excludes host, IndexedDB wrappers, catalog data and compiler. Native typed results verified for baseline/selected JS/Wasm on every fixture. Not an additive app-download estimate or a speed measurement.",
      sourceHashes: sourceHashes([
        ...engineSourcePaths(),
        "scripts/measure-catalog-profiles.ts",
        "scripts/build-sqlike-runtime.ts",
        "scripts/analyze-catalog.ts",
        "scripts/generate-runtime-capabilities.ts",
        "scripts/generate-binary-codecs.ts",
        "scripts/oxc-runtime.ts",
        "scripts/aot-compiler.ts",
        "scripts/defined-compiler.ts",
        "src/runtime-capabilities.json",
        "src/binary-wire.json",
        "src/catalog-capabilities.ts",
        "src/catalog-requirements-contract.ts",
        "src/sqlike-features.ts",
        "src/sqlike-runtime.ts",
        "adapters/defined-database-core.ts",
        "adapters/defined-wasm.ts",
        "adapters/node-database.ts",
        "tests/compatibility/native-values.ts",
        "examples/notes/catalog.json",
      ]),
      results,
    },
    null,
    2,
  ) + "\n",
);
