import { test, expect } from "@playwright/test";
import { build } from "vite";
import type * as Store from "../adapters/moon-image-store.ts";
let code = "";
test.beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: "error",
    build: {
      write: false,
      lib: { entry: "adapters/moon-image-store.ts", formats: ["es"] },
      minify: true,
    },
  });
  for (const output of Array.isArray(result) ? result : [result])
    if ("output" in output)
      for (const item of output.output)
        if (item.type === "chunk") code += item.code;
});
test("Moon image commits roll back queued writes and reject stale concurrent writers", async ({
  browser,
}) => {
  const context = await browser.newContext({ serviceWorkers: "block" });
  await context.route("**/moon-store-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Moon persistence test</title>",
    }),
  );
  await context.route("**/moon-store-test.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: code }),
  );
  try {
    const page = await context.newPage();
    await page.goto("/moon-store-test");
    const result = await page.evaluate(async () => {
      const path = "/moon-store-test.js";
      const { MoonImageStore } = (await import(path)) as typeof Store;
      const a = await MoonImageStore.open("durability-test");
      const b = await MoonImageStore.open("durability-test");
      await a.commit(0, JSON.stringify({ data: "old", outbox: "old" }));
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (
        ...args: Parameters<typeof put>
      ) {
        put.apply(this, args);
        throw new Error("failure after put was queued");
      };
      let aborted = false;
      try {
        await a.commit(
          1,
          JSON.stringify({ data: "partial", outbox: "partial" }),
        );
      } catch {
        aborted = true;
      } finally {
        IDBObjectStore.prototype.put = put;
      }
      const afterFailure = await a.read();
      const race = await Promise.allSettled([
        a.commit(1, JSON.stringify({ data: "a", outbox: "a" })),
        b.commit(1, JSON.stringify({ data: "b", outbox: "b" })),
      ]);
      const winner = await a.read();
      a.close();
      b.close();
      return { aborted, afterFailure, winner, race: race.map((r) => r.status) };
    });
    expect(result.aborted).toBe(true);
    expect(result.afterFailure).toEqual({
      generation: 1,
      image: JSON.stringify({ data: "old", outbox: "old" }),
    });
    expect(result.race.sort()).toEqual(["fulfilled", "rejected"]);
    expect(result.winner.generation).toBe(2);
    const winner = JSON.parse(result.winner.image!);
    expect(winner.data).toBe(winner.outbox);
    await page.reload();
    expect(
      await page.evaluate(async () => {
        const path = "/moon-store-test.js";
        const { MoonImageStore } = (await import(path)) as typeof Store;
        const db = await MoonImageStore.open("durability-test");
        try {
          return await db.read();
        } finally {
          db.close();
        }
      }),
    ).toEqual(result.winner);
  } finally {
    await context.close();
  }
});

test("incremental image records migrate v1 snapshots and publish delta plus generation atomically", async ({
  page,
}) => {
  await page.route("**/moon-delta-test", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.route("**/moon-store-test.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: code }),
  );
  await page.goto("/moon-delta-test");
  const actual = await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open("browser-litestream-moonbit-legacy-delta", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("image");
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const tx = req.result.transaction("image", "readwrite");
        tx.objectStore("image").put(
          { format: 1, generation: 7, image: "legacy" },
          "root",
        );
        tx.oncomplete = () => {
          req.result.close();
          resolve();
        };
        tx.onabort = () => reject(tx.error);
      };
    });
    const path = "/moon-store-test.js";
    const { MoonImageStore } = (await import(path)) as typeof Store;
    const a = await MoonImageStore.open("legacy-delta");
    const before = await a.read();
    const delta = { text: "row edit", blobs: [new Uint8Array([0, 255])] };
    await a.commitDelta(7, delta);
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      const result = put.apply(this, args);
      if (this.name === "delta") throw Error("delta abort after put");
      return result;
    };
    let aborted = false;
    try {
      await a.commitDelta(8, { text: "not durable" });
    } catch {
      aborted = true;
    } finally {
      IDBObjectStore.prototype.put = put;
    }
    const after = await a.read();
    a.close();
    const b = await MoonImageStore.open("legacy-delta");
    const reopened = await b.read();
    await b.commit(8, "compacted");
    const compacted = await b.read();
    b.close();
    return { before, after, reopened, compacted, aborted };
  });
  expect(actual.before).toEqual({ generation: 7, image: "legacy" });
  expect(actual.aborted).toBe(true);
  expect(actual.after).toEqual({
    generation: 8,
    image: "legacy",
    deltas: [{ text: "row edit", blobs: [new Uint8Array([0, 255])] }],
  });
  expect(actual.reopened).toEqual(actual.after);
  expect(actual.compacted).toEqual({ generation: 9, image: "compacted" });
});

test("chunk snapshots capture buffers, publish with CAS, abort atomically and remove superseded chunks", async ({
  page,
}) => {
  await page.route("**/chunks-store-test", (r) =>
    r.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.route("**/chunks-store-test.js", (r) =>
    r.fulfill({ contentType: "text/javascript", body: code }),
  );
  await page.goto("/chunks-store-test");
  const result = await page.evaluate(async () => {
    const path = "/chunks-store-test.js";
    const { MoonImageStore } = (await import(path)) as typeof Store;
    const store = await MoonImageStore.open("chunks-test"),
      other = await MoonImageStore.open("chunks-test");
    await store.commit(0, "legacy");
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
    const published = store.commitSnapshot(1, { text: "header", chunks });
    chunks[0]!.fill(9);
    chunks.length = 0;
    await published;
    await store.commitDelta(2, { text: "delta" });
    const before = await store.read();
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      const result = put.apply(this, args);
      if (this.name === "image" && Array.isArray(args[1]))
        this.transaction.abort();
      return result;
    };
    let aborted = false;
    try {
      await store.commitSnapshot(3, {
        text: "new",
        chunks: [new Uint8Array([7])],
      });
    } catch {
      aborted = true;
    } finally {
      IDBObjectStore.prototype.put = put;
    }
    const unchanged =
      JSON.stringify(before) === JSON.stringify(await store.read());
    let stale = false;
    try {
      await other.commitSnapshot(2, { text: "stale", chunks: [] });
    } catch {
      stale = true;
    }
    await store.commitSnapshot(3, { text: "empty", chunks: [] });
    const empty = await store.read();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("browser-litestream-moonbit-chunks-test", 4);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const count = await new Promise<number>((resolve, reject) => {
      const r = db
        .transaction("image")
        .objectStore("image")
        .count(IDBKeyRange.bound(["chunk", 0], ["chunk", 100000]));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    db.close();
    store.close();
    other.close();
    return { before, aborted, unchanged, stale, empty, count };
  });
  expect(result.before.snapshot?.chunks.map((c) => Object.values(c))).toEqual([
    [1, 2, 3],
    [4, 5],
  ]);
  expect(result.before.deltas).toEqual([{ text: "delta" }]);
  expect(result.aborted && result.unchanged && result.stale).toBe(true);
  expect(result.empty).toEqual({
    generation: 4,
    snapshot: { text: "empty", chunks: [] },
  });
  expect(result.count).toBe(0);
});

test("differential checkpoints reuse immutable parts, collect old parts atomically and validate hashes", async ({
  page,
}) => {
  await page.route("**/patch-store-test", (r) =>
    r.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.route("**/patch-store-test.js", (r) =>
    r.fulfill({ contentType: "text/javascript", body: code }),
  );
  await page.goto("/patch-store-test");
  const result = await page.evaluate(async () => {
    const path = "/patch-store-test.js",
      { MoonImageStore } = (await import(path)) as typeof Store;
    const a = await MoonImageStore.open("patch-test");
    const input = {
      text: "one",
      chunks: [new Uint8Array([1, 2]), new Uint8Array([3, 4])],
    };
    const first = a.commitCheckpoint(0, input);
    input.chunks[0]!.fill(9);
    await first;
    await a.commitDelta(1, { text: "journal" });
    const b = await MoonImageStore.open("patch-test");
    const put = IDBObjectStore.prototype.put,
      touched: unknown[] = [];
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      if (this.name === "image") touched.push(args[1]);
      return put.apply(this, args);
    };
    await a.commitCheckpoint(2, {
      base: 1,
      text: "two",
      chunks: [0, new Uint8Array([5, 6])],
    });
    IDBObjectStore.prototype.put = put;
    const saved = await a.read();
    let stale = false,
      badBase = false;
    try {
      await b.commitCheckpoint(2, { base: 1, text: "stale", chunks: [0] });
    } catch {
      stale = true;
    }
    try {
      await a.commitCheckpoint(3, { base: 1, text: "wrong", chunks: [0] });
    } catch {
      badBase = true;
    }
    let invalid = 0;
    for (const chunks of [[9], [0, 0], [0.5]]) {
      try {
        await a.commitCheckpoint(3, { base: 3, text: "invalid", chunks });
      } catch {
        invalid++;
      }
    }
    const before = JSON.stringify(saved);
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      const req = put.apply(this, args);
      if (this.name === "image" && Array.isArray(args[1]))
        this.transaction.abort();
      return req;
    };
    let aborted = false;
    try {
      await a.commitCheckpoint(3, {
        base: 3,
        text: "abort",
        chunks: [new Uint8Array([7]), 1],
      });
    } catch {
      aborted = true;
    } finally {
      IDBObjectStore.prototype.put = put;
    }
    const unchanged = before === JSON.stringify(await a.read());
    const db = await new Promise<IDBDatabase>((resolve) => {
      const req = indexedDB.open("browser-litestream-moonbit-patch-test", 4);
      req.onsuccess = () => resolve(req.result);
    });
    const keys = await new Promise<IDBValidKey[]>((resolve) => {
      const req = db.transaction("image").objectStore("image").getAllKeys();
      req.onsuccess = () => resolve(req.result);
    });
    await new Promise<void>((resolve) => {
      const tx = db.transaction("image", "readwrite");
      tx.objectStore("image").put(new Uint8Array([8, 8]), ["part", 1, 0]);
      tx.oncomplete = () => resolve();
    });
    const manifest = await new Promise<any>((resolve) => {
      const r = db.transaction("image").objectStore("image").get("snapshot");
      r.onsuccess = () => resolve(r.result);
    });
    await new Promise<void>((resolve) => {
      const tx = db.transaction("image", "readwrite");
      tx.objectStore("image").put({ ...manifest, text: "bad" }, "snapshot");
      tx.oncomplete = () => resolve();
    });
    let badManifest = false;
    try {
      await a.read();
    } catch (e) {
      badManifest = String(e).includes("manifest checksum");
    }
    await new Promise<void>((resolve) => {
      const tx = db.transaction("image", "readwrite");
      tx.objectStore("image").put(manifest, "snapshot");
      tx.oncomplete = () => resolve();
    });
    let corrupt = false;
    try {
      await a.read();
    } catch {
      corrupt = true;
    }
    a.close();
    b.close();
    db.close();
    return {
      saved,
      touched,
      stale,
      badBase,
      aborted,
      unchanged,
      keys,
      corrupt,
      invalid,
      badManifest,
    };
  });
  expect(result.saved.snapshot?.chunks.map((x) => Object.values(x))).toEqual([
    [1, 2],
    [5, 6],
  ]);
  expect(result.saved.deltas).toBeUndefined();
  expect(result.touched.filter(Array.isArray)).toEqual([["part", 3, 1]]);
  expect(result.keys.filter(Array.isArray)).toEqual([
    ["part", 1, 0],
    ["part", 3, 1],
  ]);
  expect(result.invalid).toBe(3);
  expect(result.badManifest).toBe(true);
  expect(
    result.stale &&
      result.badBase &&
      result.aborted &&
      result.unchanged &&
      result.corrupt,
  ).toBe(true);
});
