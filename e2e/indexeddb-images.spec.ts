import { test, expect } from "@playwright/test";
import { build } from "vite";
import type * as Images from "../adapters/indexeddb-images.ts";
let code = "";
test.beforeAll(async () => {
  const built = await build({
    configFile: false,
    logLevel: "error",
    build: {
      write: false,
      minify: true,
      lib: { entry: "adapters/indexeddb-images.ts", formats: ["es"] },
    },
  });
  for (const output of Array.isArray(built) ? built : [built])
    if ("output" in output)
      for (const item of output.output)
        if (item.type === "chunk") code += item.code;
});
test("IDB replica images atomically publish, reopen, prune and read legacy storage through an injected provider", async ({
  page,
}) => {
  await page.route("**/images-test", (r) =>
    r.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.route("**/images-test.js", (r) =>
    r.fulfill({ contentType: "text/javascript", body: code }),
  );
  await page.goto("/images-test");
  const result = await page.evaluate(async () => {
    const path = "/images-test.js";
    const { IndexedDbImages } = (await import(path)) as typeof Images;
    const first = "image-00000000-0000-0000-0000-000000000001.sqlite",
      second = "image-00000000-0000-0000-0000-000000000002.sqlite";
    let fallbackReads = 0;
    const storage = await IndexedDbImages.open("images-test", async () => ({
      read: async () => {
        fallbackReads++;
        return new Uint8Array([7, 8]);
      },
      write: async () => {},
      prune: async () => {},
    }));
    await storage.write(first, new Uint8Array([1, 2, 3]));
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      put.apply(this, args);
      throw Error("abort queued image");
    };
    let aborted = false;
    try {
      await storage.write(first, new Uint8Array([9]));
    } catch {
      aborted = true;
    } finally {
      IDBObjectStore.prototype.put = put;
    }
    const before = Array.from(await storage.read(first));
    const migrated = Array.from(await storage.read(second));
    await storage.prune(second);
    // The fallback remains external and is not pruned by the new cache.
    const reopened = await IndexedDbImages.open("images-test");
    let missing = false;
    try {
      await reopened.read(first);
    } catch {
      missing = true;
    }
    const after = Array.from(await reopened.read(second));
    return { aborted, before, migrated, after, missing, fallbackReads };
  });
  expect(result).toEqual({
    aborted: true,
    before: [1, 2, 3],
    migrated: [7, 8],
    after: [7, 8],
    missing: true,
    fallbackReads: 1,
  });
});
