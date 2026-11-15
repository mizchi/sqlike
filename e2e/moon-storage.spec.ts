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
