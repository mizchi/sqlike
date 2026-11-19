import { readFile, writeFile } from "node:fs/promises";
import { brotliCompressSync, constants } from "node:zlib";
import { assertFileHashes, sourceHashes } from "./measurement-manifest.ts";

// Use the exact artifacts that were timed, without rebuilding or changing them.
const benchmark = JSON.parse(
  await readFile("measurements/in-list-paired.json", "utf8"),
);
assertFileHashes(benchmark.sources);
assertFileHashes(benchmark.artifacts);
const rows = [];
for (const kind of ["scalar", "row"])
  for (const enabled of [false, true]) {
    const directory = `generated/in-list-bench/${kind}-100000-${enabled}`;
    for (const target of ["js", "wasm"]) {
      const path = `${directory}/runtime.${target}`;
      const bytes = await readFile(path);
      rows.push({
        kind,
        enabled,
        target,
        path,
        sha256: benchmark.artifacts[path],
        bytes: bytes.length,
        brotli: brotliCompressSync(bytes, {
          params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
        }).length,
      });
    }
  }
await writeFile(
  "measurements/in-list-size-current.json",
  JSON.stringify(
    {
      format: "sqlike-in-list-sizes@1",
      measuredAt: new Date().toISOString(),
      benchmarkMeasuredAt: benchmark.measuredAt,
      scope:
        "The same 100k scalar/row AOT artifacts used by bench-in-list; one engine, four exports, same catalog and other optimizers within each pair; host/catalog excluded; OXC-minified JS or raw Wasm GC, Brotli quality 11.",
      rows,
      sources: {
        ...benchmark.sources,
        ...sourceHashes(["scripts/measure-in-list-size.ts"]),
      },
    },
    null,
    2,
  ) + "\n",
);
console.table(
  rows.map(({ kind, enabled, target, bytes, brotli }) => ({
    kind,
    enabled,
    target,
    KiB: (bytes / 1024).toFixed(2),
    BrotliKiB: (brotli / 1024).toFixed(2),
  })),
);
