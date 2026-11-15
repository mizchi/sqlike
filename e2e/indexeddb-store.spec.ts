import { test, expect } from "@playwright/test";
import { build } from "vite";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import type * as Store from "../adapters/indexeddb-store.ts";

let code = "";
test.beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: "error",
    build: {
      write: false,
      lib: { entry: "adapters/indexeddb-store.ts", formats: ["es"] },
      minify: true,
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  for (const output of outputs)
    if ("output" in output)
      for (const item of output.output)
        if (item.type === "chunk") code += item.code;
  if (!code) throw new Error("missing IndexedDB probe bundle");
  const raw = Buffer.from(code);
  const report = {
    scope:
      "storage-only prototype; no SQL parser/evaluator, changeset codec or LTX reader",
    raw: raw.length,
    gzip: gzipSync(raw, { level: 9 }).length,
    brotli: brotliCompressSync(raw, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).length,
  };
  await mkdir("measurements", { recursive: true });
  await writeFile(
    "measurements/indexeddb-store.json",
    JSON.stringify(report, null, 2) + "\n",
  );
});
test("IndexedDB prototype atomically persists data and outbox, rejects stale writers and rolls back queued writes", async ({
  browser,
}) => {
  const context = await browser.newContext({ serviceWorkers: "block" });
  let wasmRequests = 0;
  context.on("request", (r) => {
    if (/\.wasm(?:$|\?)/.test(r.url())) wasmRequests++;
  });
  await context.route("**/idb-probe", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>IndexedDB storage probe</title>",
    }),
  );
  await context.route("**/idb-store.js", (r) =>
    r.fulfill({ contentType: "text/javascript", body: code }),
  );
  try {
    const page = await context.newPage();
    await page.goto("/idb-probe");
    const result = await page.evaluate(async () => {
      const path = "/idb-store.js";
      const { IndexedReplicaStore } = (await import(path)) as typeof Store;
      const a = await IndexedReplicaStore.open("compatibility");
      const b = await IndexedReplicaStore.open("compatibility");
      const state = (id: string): Store.IndexedReplica => ({
        snapshot: {
          revision: 0,
          schemaStamp: {
            epoch: "00000000-0000-0000-0000-000000000001",
            generation: 0,
            signature: "0".repeat(64),
          },
          schema: [],
          tables: [
            {
              name: "notes",
              sql: "CREATE TABLE notes(id INTEGER PRIMARY KEY,title TEXT)",
              columns: ["id", "title"],
              rows: [
                [
                  { t: "integer", v: "9223372036854775807" },
                  { t: "text", v: id },
                ],
              ],
            },
          ],
        },
        outbox: [
          {
            id,
            base: 0,
            mode: "sql",
            status: "pending",
            statements: [],
            frame: [0, 255],
          },
        ],
      });
      await a.commit(0, state("first"));
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (
        ...args: Parameters<typeof original>
      ) {
        original.apply(this, args);
        throw new Error("injected failure after put was queued");
      };
      let rolledBack = false;
      try {
        await a.commit(1, state("broken"));
      } catch {
        rolledBack = true;
      } finally {
        IDBObjectStore.prototype.put = original;
      }
      const afterFailure = await a.read();
      const writes = await Promise.allSettled([
        a.commit(1, state("left")),
        b.commit(1, state("right")),
      ]);
      const afterRace = await a.read();
      a.close();
      b.close();
      return {
        rolledBack,
        afterFailure,
        writes: writes.map((r) =>
          r.status === "fulfilled" ? r.status : (r.reason as Error).name,
        ),
        afterRace,
      };
    });
    expect(result.rolledBack).toBe(true);
    expect(result.afterFailure.generation).toBe(1);
    expect(result.afterFailure.state!.outbox[0]!.id).toBe("first");
    expect(result.writes.sort()).toEqual(["ReplicaVersionError", "fulfilled"]);
    expect(result.afterRace.generation).toBe(2);
    const winner = result.afterRace.state!.outbox[0]!.id;
    expect(result.afterRace.state!.snapshot.tables[0]!.rows[0]![1]).toEqual({
      t: "text",
      v: winner,
    });
    await page.reload();
    const restored = await page.evaluate(async () => {
      const path = "/idb-store.js";
      const { IndexedReplicaStore } = (await import(path)) as typeof Store;
      const store = await IndexedReplicaStore.open("compatibility");
      try {
        return await store.read();
      } finally {
        store.close();
      }
    });
    expect(restored).toEqual(result.afterRace);
    expect(wasmRequests).toBe(0);
  } finally {
    await context.close();
  }
});
test("IndexedDB keys cannot directly provide SQLite int64 and BINARY collation semantics", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(() => {
    let bigintError = "";
    try {
      indexedDB.cmp(9223372036854775807n as unknown as IDBValidKey, 1);
    } catch (error) {
      bigintError = (error as DOMException).name;
    }
    return { bigintError, unicodeOrder: indexedDB.cmp("\ue000", "😀") };
  });
  expect(result.bigintError).toBe("DataError");
  expect(result.unicodeOrder).toBeGreaterThan(0);
});
