import assert from "node:assert/strict";
import { sourceHashes, engineSourcePaths } from "./measurement-manifest.ts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, gzipSync, constants } from "node:zlib";
import {
  defineSqlike,
  allSqlikeFeatures,
  type SqlikeFeature,
} from "../src/sqlike-features.ts";
import { buildSqlikeRuntime } from "./build-sqlike-runtime.ts";
import { minifyRuntime } from "./oxc-runtime.ts";
const bytes = (b: Uint8Array) => ({
  raw: b.length,
  gzip: gzipSync(b, { level: 9 }).length,
  brotli: brotliCompressSync(b, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }).length,
});
const dir = await mkdtemp(join(tmpdir(), "sqlike-profile-sizes-"));
const results = [];
try {
  for (const mode of ["aot", "sql"] as const) {
    const base = allSqlikeFeatures.filter(
      (f) => !["binarySync", "ltx", "sqlitePages"].includes(f.name),
    );
    const profiles: [string, readonly SqlikeFeature[]][] = [
      ["minimal", []],
      ...base.map((f) => [f.name, [f]] as [string, SqlikeFeature[]]),
      ["all-execution", base],
      ...(mode === "aot"
        ? [
            [
              "all-with-pages-ltx",
              allSqlikeFeatures.filter((f) => f.name !== "binarySync"),
            ] as [string, SqlikeFeature[]],
          ]
        : [
            [
              "all-with-binary",
              allSqlikeFeatures.filter(
                (f) => !["ltx", "sqlitePages"].includes(f.name),
              ),
            ] as [string, SqlikeFeature[]],
          ]),
    ];
    for (const [name, features] of profiles) {
      const built = await buildSqlikeRuntime(defineSqlike({ mode, features }), {
        outDir: join(dir, mode, name),
        minify: false,
      });
      const js = await readFile(join(built.directory, "runtime.js")),
        wasm = await readFile(join(built.directory, "runtime.wasm"));
      const code = await minifyRuntime(
        join(built.directory, "runtime.js"),
        built.exports,
      );
      const absent = {
        triggerImplementation: !js.toString().includes("fire__trigger("),
        foreignKeyActions: !js
          .toString()
          .includes("foreign key cascade depth limit"),
        strictTypeChecks: !js.toString().includes("datatype constraint failed"),
        usingJoin: !js.toString().includes("cannot join using column"),
        primaryKeyMap: !js.toString().includes("primary__value__key("),
        sqlJson: !js.toString().includes("json__call("),
        dateTime: !js.toString().includes("datetime__call("),
        windows: !js.toString().includes("compute__windows("),
      };
      results.push({
        mode,
        name,
        features: built.profile.features,
        js: bytes(Buffer.from(code)),
        wasm: bytes(wasm),
        absent,
      });
      console.log(
        mode,
        name,
        results.at(-1)!.js.brotli,
        results.at(-1)!.wasm.brotli,
      );
    }
  }
  await writeFile(
    "measurements/sqlike-feature-profiles-current.json",
    JSON.stringify(
      {
        format: 1,
        sourceHashes: sourceHashes([
          ...engineSourcePaths(),
          "scripts/measure-sqlike-profiles.ts",
          "scripts/build-sqlike-runtime.ts",
          "scripts/oxc-runtime.ts",
          "src/sqlike-features.ts",
        ]),
        measuredAt: new Date().toISOString(),
        node: process.version,
        method:
          "Moon release static feature specialization; isolated builds. JS ESM all entry exports retained, Oxc client minification with compact whitespace and annotations preserved; absence checks use unminified source; gzip9/Brotli11. Wasm GC release without wasm-opt. Engine only: excludes host adapter, catalog and persistence. AOT excludes SQL parser. Minimal excludes optional JSON/date/window implementations; ordinary aggregates, CTE and secondary indexes remain in core.",
        results,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
