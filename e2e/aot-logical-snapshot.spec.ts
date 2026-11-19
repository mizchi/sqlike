import { test, expect } from "@playwright/test";
import { build } from "vite";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import type * as Fixture from "./fixtures/aot-pager-checkpoint.ts";

test("legacy JSON migrates to chunk checkpoint; abort and lost ACK recover logical/pages/LTX together", async ({
  page,
}) => {
  const built = buildCatalog(
    {
      schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER,s TEXT)"],
      queries: [
        { name: "add", sql: "INSERT INTO t VALUES(?,?,?)" },
        { name: "update", sql: "UPDATE t SET n=? WHERE id=?" },
        { name: "all", sql: "SELECT id,n FROM t ORDER BY id" },
      ],
    },
    { pageSize: 512 },
  );
  const outputs = await build({
    configFile: false,
    logLevel: "error",
    build: {
      write: false,
      target: "esnext",
      lib: { entry: "e2e/fixtures/aot-pager-checkpoint.ts", formats: ["es"] },
      rolldownOptions: { output: { codeSplitting: false } },
    },
  });
  let code = "";
  for (const output of Array.isArray(outputs) ? outputs : [outputs])
    if ("output" in output)
      for (const c of output.output) if (c.type === "chunk") code += c.code;
  await page.route("**/logical-chunks.js", (r) =>
    r.fulfill({ contentType: "text/javascript", body: code }),
  );
  await page.route("**/logical-chunks", (r) =>
    r.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.goto("/logical-chunks");
  const result = await page.evaluate(
    async ({ artifact, hash }) => {
      const path = "/logical-chunks.js";
      const { AotDatabase, IndexedDbAotPageStore } = (await import(
        path
      )) as typeof Fixture;
      let store = await IndexedDbAotPageStore.open("aot-logical-chunks");
      Object.defineProperty(store, "commitCheckpoint", {
        value: undefined,
        configurable: true,
      });
      Object.defineProperty(store, "commitSnapshot", {
        value: undefined,
        configurable: true,
      });
      let db = await AotDatabase.withStore(artifact, hash, store, {
        sqlitePages: true,
      });
      for (let i = 1; i <= 150; i++)
        await db.execute("add", [BigInt(i), 100n, "payload " + i]);
      await db.checkpoint();
      const legacy = await store.read();
      await db.close();
      store = await IndexedDbAotPageStore.open("aot-logical-chunks");
      db = await AotDatabase.withStore(artifact, hash, store, {
        sqlitePages: true,
      });
      await db.execute("update", [101n, 75n]);
      const before = await store.read(),
        head = await store.pages.head();
      store.checkpointNeeded = () => true;
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (
        ...args: Parameters<typeof put>
      ) {
        const result = put.apply(this, args);
        if (this.name === "image" && Array.isArray(args[1]))
          this.transaction.abort();
        return result;
      };
      let aborted = false;
      try {
        await db.checkpoint();
      } catch {
        aborted = true;
      } finally {
        IDBObjectStore.prototype.put = put;
      }
      const unchanged =
        JSON.stringify(before) === JSON.stringify(await store.read()) &&
        JSON.stringify(head) === JSON.stringify(await store.pages.head());
      await db.close();
      store = await IndexedDbAotPageStore.open("aot-logical-chunks");
      db = await AotDatabase.withStore(artifact, hash, store, {
        sqlitePages: true,
      });
      store.checkpointNeeded = () => true;
      const commit = store.commitWithPages.bind(store);
      store.commitWithPages = async (...args) => {
        await commit(...args);
        throw Error("chunk durable ACK lost");
      };
      let lost = false;
      try {
        await db.checkpoint();
      } catch (e) {
        lost = String(e).includes("ACK lost");
      }
      await db.close();
      store = await IndexedDbAotPageStore.open("aot-logical-chunks");
      const saved = await store.read();
      db = await AotDatabase.withStore(artifact, hash, store, {
        sqlitePages: true,
      });
      const rows = (await db.execute("all")).rows;
      const noop = await db.checkpoint();
      await db.execute("update", [102n, 76n]);
      await db.checkpoint();
      const pending = await db.pending();
      await db.close();
      store = await IndexedDbAotPageStore.open("aot-logical-chunks");
      db = await AotDatabase.withStore(artifact, hash, store, {
        sqlitePages: true,
      });
      const replayed = (await db.execute("all")).rows[75]![1];
      await db.close();
      // A missing part must fail closed, rather than opening an empty/partial DB.
      const raw = await new Promise<IDBDatabase>((resolve) => {
        const r = indexedDB.open(
          "browser-litestream-moonbit-aot-logical-chunks",
          4,
        );
        r.onsuccess = () => resolve(r.result);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = raw.transaction("image", "readwrite");
        const images = tx.objectStore("image"),
          request = images.get("snapshot");
        request.onsuccess = () => {
          const manifest = request.result;
          if (manifest.format === "moon-snapshot-parts@2") {
            const ref = manifest.refs[0];
            images.delete(["part", ref.generation, ref.index]);
          } else images.delete(["chunk", 0]);
        };
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      raw.close();
      let missing = false;
      try {
        await AotDatabase.withStore(
          artifact,
          hash,
          await IndexedDbAotPageStore.open("aot-logical-chunks"),
          { sqlitePages: true },
        );
      } catch {
        missing = true;
      }
      return {
        legacy: !!legacy.image,
        aborted,
        unchanged,
        lost,
        parts: saved.snapshot?.chunks.length,
        imageBytes: JSON.parse(saved.snapshot!.text).image.length,
        row: rows[74]![1],
        count: rows.length,
        noop: noop.created,
        pending: pending.length,
        replayed,
        missing,
      };
    },
    { artifact: built.artifact, hash: built.manifest.artifactSHA256 },
  );
  expect(result).toMatchObject({
    legacy: true,
    aborted: true,
    unchanged: true,
    lost: true,
    imageBytes: 0,
    row: 101n,
    count: 150,
    noop: false,
    replayed: 102n,
    missing: true,
  });
  expect(result.parts).toBeGreaterThan(1);
  expect(result.pending).toBe(3);
});
