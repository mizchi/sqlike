import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { cpus } from "node:os";
import { execFileSync } from "node:child_process";
import { buildSqlikeRuntime } from "./build-sqlike-runtime.ts";
import { buildCatalog } from "./aot-compiler.ts";
import {
  defineSqlike,
  primaryKeyIndex,
  sqlitePages,
  ltx,
} from "../src/sqlike-features.ts";
import { SqlitePagerClient } from "../src/sqlite-pager.ts";
import { sqlitePagerWasm } from "../src/sqlite-pager-wasm.ts";
import { createPageLtxEncoder, ltxPageWasm } from "../src/ltx-pages-host.ts";
import { MemorySqlitePageStore } from "../adapters/sqlite-page-store.ts";
import { pageDelta } from "../adapters/page-delta.ts";
import { aotBindings, toBase64, fromBase64 } from "../src/aot-values.ts";
import {
  engineSourcePaths,
  sourceHashes,
  fileHash,
} from "./measurement-manifest.ts";
const checked = (text: string) => {
  const r = JSON.parse(text);
  if (r.error) throw Error(r.error);
  return r;
};
const rows: any[] = [],
  fixtures: any[] = [],
  artifacts: Record<string, string> = {};
const size = 4096,
  batch = 100;
for (const [count, payload] of [
  [5000, 32],
  [100000, 32],
  [5000, 4096],
]) {
  const source = {
    schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER,s TEXT)"],
    queries: [
      {
        name: "seed",
        sql:
          "INSERT INTO t VALUES " +
          Array.from(
            { length: batch },
            (_, i) => `(?${i + 1},100,'${"x".repeat(payload!)}')`,
          ).join(","),
      },
      { name: "update", sql: "UPDATE t SET n=?2 WHERE id=?1" },
    ],
  };
  const built = await buildSqlikeRuntime(
    defineSqlike({
      mode: "aot",
      features: [primaryKeyIndex, sqlitePages, ltx],
    }),
    {
      catalog: source,
      outDir: `generated/sqlite-pager-bench/${count}-${payload}`,
      apiCapabilities: [],
    },
  );
  const js = await import(
      pathToFileURL(join(built.directory, "runtime.js")).href
    ),
    wasm = (
      await WebAssembly.instantiate(
        await readFile(join(built.directory, "runtime.wasm")),
        {},
        { builtins: ["js-string"], importedStringConstants: "_" },
      )
    ).instance.exports;
  const w = wasm as any;
  const normalized = {
    ...w,
    ...sqlitePagerWasm(wasm),
    ...ltxPageWasm(wasm),
    sqlite_data: (r: any) => fromBase64(w.sqlite_data_base64(r)),
    encode_ltx: (
      b: Uint8Array,
      a: Uint8Array,
      min: string,
      max: string,
      t: string,
    ) => w.encode_ltx_base64(toBase64(b), toBase64(a), min, max, t),
  };
  fixtures.push({ count, payload, source });
  for (const target of ["js", "wasm"]) {
    const path = join(built.directory, `runtime.${target}`);
    artifacts[path] = fileHash(path);
  }
  for (const [target, raw] of [
    ["js", js],
    ["wasm", normalized],
  ] as const) {
    const full = raw.aot_open(buildCatalog(source).artifact, ""),
      incremental = raw.aot_open(buildCatalog(source).artifact, "");
    for (let start = 0; start < count!; start += batch) {
      const params = aotBindings(
        Array.from({ length: batch }, (_, i) => BigInt(start + i + 1)),
      );
      checked(raw.aot_execute(full, "seed", params));
      checked(raw.aot_execute(incremental, "seed", params));
    }
    const fullStore = new MemorySqlitePageStore(),
      pageStore = new MemorySqlitePageStore();
    let base = raw.sqlite_data(raw.aot_export_sqlite(full)) as Uint8Array,
      txid = 1;
    const initial = raw.encode_ltx(new Uint8Array(), base, "1", "1", "0");
    checked(raw.ltx_info(initial));
    const fullInfo = checked(raw.aot_info(full));
    await fullStore.commit(0, {
      programId: fullInfo.programId,
      pageSize: size,
      pageCount: base.length / size,
      serial: fullInfo.serial,
      snapshot: true,
      pages: Array.from({ length: base.length / size }, (_, i) => ({
        page: i + 1,
        data: base.slice(i * size, (i + 1) * size),
      })),
      metadata: "1",
      files: [{ name: "1.ltx", data: raw.ltx_data(initial) }],
    });
    const encoder = createPageLtxEncoder(raw);
    let incrementalLtxMs = 0;
    const client = await SqlitePagerClient.open(
      raw,
      pageStore,
      (p) => raw.aot_pager_prepare(incremental, p),
      {
        cachePages: 8,
        prepareCommit: (head, value) => {
          const start = performance.now(),
            state = head?.metadata ?? "",
            next = state ? BigInt(JSON.parse(state).txid) + 1n : 1n;
          const result = encoder.encode(
            state,
            value,
            String(next),
            String(next),
            "0",
          );
          incrementalLtxMs = performance.now() - start;
          return {
            metadata: result.state,
            files: [{ name: String(next) + ".ltx", data: result.data }],
          };
        },
      },
    );
    await client.flush();
    const samples: { full: any[]; incremental: any[] } = {
      full: [],
      incremental: [],
    };
    for (let index = 0; index < 4; index++) {
      const bindings = aotBindings([
        BigInt(1 + ((index * 7919) % count!)),
        BigInt(101 + index),
      ]);
      checked(raw.aot_execute(full, "update", bindings));
      checked(raw.aot_execute(incremental, "update", bindings));
      globalThis.gc?.();
      const before = process.memoryUsage(),
        start = performance.now();
      const sql = raw.aot_export_sqlite(full);
      checked(raw.sqlite_info(sql));
      const after = raw.sqlite_data(sql) as Uint8Array,
        t1 = performance.now();
      txid++;
      const ltxResult = raw.encode_ltx(
        base,
        after,
        String(txid),
        String(txid),
        "0",
      );
      checked(raw.ltx_info(ltxResult));
      const ltxData = raw.ltx_data(ltxResult) as Uint8Array,
        t2 = performance.now();
      const delta = pageDelta(base, after, size),
        numbers = JSON.parse(delta.text).pages as number[],
        t3 = performance.now();
      await fullStore.commit(txid - 1, {
        programId: fullInfo.programId,
        pageSize: size,
        pageCount: after.length / size,
        serial: checked(raw.aot_info(full)).serial,
        snapshot: false,
        pages: numbers.map((p, i) => ({ page: p + 1, data: delta.blobs![i]! })),
        metadata: String(txid),
        files: [{ name: String(txid) + ".ltx", data: ltxData }],
      });
      const end = performance.now(),
        observed = process.memoryUsage();
      globalThis.gc?.();
      const retained = process.memoryUsage();
      if (index)
        samples.full.push({
          milliseconds: end - start,
          writerMs: t1 - start,
          ltxMs: t2 - t1,
          comparisonMs: t3 - t2,
          generatedPages: after.length / size,
          writtenPages: numbers.length,
          bytesWritten: numbers.length * size,
          ltxBytes: ltxData.length,
          observedHeapDelta: observed.heapUsed - before.heapUsed,
          observedBackingDelta: observed.arrayBuffers - before.arrayBuffers,
          afterGcHeapDelta: retained.heapUsed - before.heapUsed,
          afterGcBackingDelta: retained.arrayBuffers - before.arrayBuffers,
        });
      base = after;
      globalThis.gc?.();
      const ibefore = process.memoryUsage(),
        istart = performance.now();
      const result = await client.flush(),
        iend = performance.now(),
        iobserved = process.memoryUsage();
      globalThis.gc?.();
      const iretained = process.memoryUsage();
      assert.equal(result.info.snapshot, false);
      assert.equal(result.info.changedRows, 1);
      assert.equal(result.commit!.pages.length, 2);
      if (index)
        samples.incremental.push({
          milliseconds: iend - istart,
          ltxMs: incrementalLtxMs,
          generatedPages: result.commit!.pages.length,
          writtenPages: result.commit!.pages.length,
          bytesWritten: result.commit!.pages.length * size,
          ltxBytes: result.commit!.files![0]!.data.length,
          reads: result.reads,
          logicalBlocks: result.info.logicalBlocks,
          cacheBytes: result.cacheBytes,
          observedHeapDelta: iobserved.heapUsed - ibefore.heapUsed,
          observedBackingDelta: iobserved.arrayBuffers - ibefore.arrayBuffers,
          afterGcHeapDelta: iretained.heapUsed - ibefore.heapUsed,
          afterGcBackingDelta: iretained.arrayBuffers - ibefore.arrayBuffers,
        });
    }
    const head = (await pageStore.head())!,
      image = new Uint8Array(head.pageCount * head.pageSize);
    for (let p = 1; p <= head.pageCount; p++)
      image.set(await pageStore.readPage(head.generation, p), (p - 1) * size);
    assert.deepEqual(image, base);
    for (const mode of ["full", "incremental"] as const) {
      const times = samples[mode]
        .map((s) => s.milliseconds)
        .sort((a, b) => a - b);
      rows.push({
        count,
        payload,
        target,
        mode,
        imageBytes: base.length,
        medianMs: times[1],
        samples: samples[mode],
      });
    }
    client.close();
    fullStore.close();
  }
}
await mkdir("measurements", { recursive: true });
await writeFile(
  "measurements/sqlite-pager-current.json",
  JSON.stringify(
    {
      format: "sqlike-pager-bench@1",
      measuredAt: new Date().toISOString(),
      node: process.version,
      cpu: cpus()[0]?.model,
      moon: execFileSync("moon", ["version"], { encoding: "utf8" }).trim(),
      scope:
        "Node in-memory page provider; same AOT engine/catalog/exports. Full export + full-buffer page comparison + whole-image LTX versus incremental pager + incremental LTX state. Both publish pages/file/state through generation CAS. One warmup, three changing-row samples, setup/seed/GC/verification excluded. Wasm includes its existing explicit base64 ABI. No IndexedDB/network time. Heap observations are after calls, not peak/RSS or total Wasm memory. SQLike still retains logical rows; initial snapshots/fallbacks remain whole-image.",
      fixtures,
      rows,
      artifacts,
      sources: sourceHashes([
        ...engineSourcePaths(),
        "scripts/bench-sqlite-pager.ts",
        "src/sqlite-pager.ts",
        "src/sqlite-pager-contract.ts",
        "src/sqlite-pager-wasm.ts",
        "src/ltx-pages-host.ts",
        "adapters/sqlite-page-store.ts",
        "adapters/page-delta.ts",
        "scripts/build-sqlike-runtime.ts",
        "scripts/sqlike-runtime-declarations.ts",
        "src/sqlike-features.ts",
        "src/sqlike-build-graph.json",
      ]),
    },
    null,
    2,
  ) + "\n",
);
console.table(
  rows.map(({ count, payload, target, mode, medianMs }) => ({
    count,
    payload,
    target,
    mode,
    ms: medianMs.toFixed(3),
  })),
);
