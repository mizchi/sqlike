import { test, expect } from "@playwright/test";
import { build } from "vite";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import type * as Fixture from "./fixtures/aot-pager-checkpoint.ts";

test("warm checkpoints reuse unchanged row blocks, compact journals and recover after reload", async ({
  page,
}) => {
  const built = buildCatalog(
    {
      schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER,s TEXT)"],
      queries: [
        { name: "add", sql: "INSERT INTO t VALUES(?,?,?)" },
        { name: "update", sql: "UPDATE t SET n=? WHERE id=?" },
        { name: "delete", sql: "DELETE FROM t WHERE id=?" },
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
  await page.route("**/diff-snapshot.js", (r) =>
    r.fulfill({ contentType: "text/javascript", body: code }),
  );
  await page.route("**/diff-snapshot", (r) =>
    r.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.goto("/diff-snapshot");
  const result = await page.evaluate(
    async ({ artifact, hash }) => {
      const path = "/diff-snapshot.js",
        { AotDatabase, IndexedDbAotPageStore } = (await import(
          path
        )) as typeof Fixture;
      let store = await IndexedDbAotPageStore.open("aot-diff-snapshot");
      // Seed a legacy v1 chunk image, then migrate to the independently reusable wire format.
      Object.defineProperty(store, "commitCheckpoint", {
        value: undefined,
        configurable: true,
      });
      let db = await AotDatabase.withStore(artifact, hash, store, {
        sqlitePages: true,
      });
      store.checkpointNeeded = () => false;
      for (let i = 1; i <= 150; i++)
        await db.execute("add", [BigInt(i), 100n, "text"]);
      store.checkpointNeeded = () => true;
      await db.execute("update", [101n, 70n]);
      await db.checkpoint();
      const legacy = JSON.parse((await store.read()).snapshot!.text).logical;
      await db.close();
      store = await IndexedDbAotPageStore.open("aot-diff-snapshot");
      db = await AotDatabase.withStore(artifact, hash, store, {
        sqlitePages: true,
      });
      store.checkpointNeeded = () => true;
      const commit = store.commitCheckpoint.bind(store),
        calls: { bytes: number; refs: number }[] = [];
      store.commitCheckpoint = async (g, v) => {
        calls.push({
          bytes: v.chunks.filter((c) => typeof c !== "number").length,
          refs: v.chunks.filter((c) => typeof c === "number").length,
        });
        return commit(g, v);
      };
      await db.execute("update", [102n, 70n]); // cold: encode all
      await db.execute("update", [103n, 71n]); // warm: one block
      await db.execute("delete", [1n]); // same ordinal mapping with holes
      const put = IDBObjectStore.prototype.put;
      let writes = 0;
      IDBObjectStore.prototype.put = function (
        ...args: Parameters<typeof put>
      ) {
        if (this.name === "image" && Array.isArray(args[1])) writes++;
        return put.apply(this, args);
      };
      try {
        await db.checkpoint();
      } finally {
        IDBObjectStore.prototype.put = put;
      }
      const noRowWrites = writes === 0;
      const before = await store.read(),
        head = await store.pages.head();
      const raw = await new Promise<IDBDatabase>((resolve) => {
        const r = indexedDB.open(
          "browser-litestream-moonbit-aot-diff-snapshot",
          4,
        );
        r.onsuccess = () => resolve(r.result);
      });
      const keys = await new Promise<IDBValidKey[]>((resolve) => {
        const r = raw.transaction("image").objectStore("image").getAllKeys();
        r.onsuccess = () => resolve(r.result);
      });
      raw.close();
      const stableCalls = [...calls],
        durable = store.commitCheckpoint.bind(store);
      let lost = false,
        mixed = false;
      store.commitCheckpoint = async (g, v) => {
        mixed =
          v.chunks.some((c) => typeof c === "number") &&
          v.chunks.some((c) => typeof c !== "number");
        await durable(g, v);
        throw Error("warm checkpoint ACK lost");
      };
      try {
        await db.execute("update", [107n, 75n]);
      } catch (e) {
        lost = String(e).includes("ACK lost");
      }
      await db.close();
      store = await IndexedDbAotPageStore.open("aot-diff-snapshot");
      db = await AotDatabase.withStore(artifact, hash, store, {
        sqlitePages: true,
      });
      const rows = (await db.execute("all")).rows;
      store.checkpointNeeded = () => true;
      await db.execute("update", [104n, 72n]); // fresh baseline after reopen
      await db.execute("update", [105n, 73n]);
      await db.checkpoint();
      const final = await store.read();
      await db.close();
      store = await IndexedDbAotPageStore.open("aot-diff-snapshot");
      db = await AotDatabase.withStore(artifact, hash, store, {
        sqlitePages: true,
      });
      const next = (await db.execute("all")).rows;
      await db.close();
      return {
        legacy: JSON.parse(legacy).format,
        calls: stableCalls,
        lost,
        mixed,
        recovered: rows.find((r) => r[0] === 75n)![1],
        noRowWrites,
        parts: before.snapshot!.chunks.length,
        records: keys.filter(Array.isArray).length,
        deltas: before.deltas?.length ?? 0,
        head: head!.serial,
        count: rows.length,
        n: rows.find((r) => r[0] === 71n)![1],
        next: next.find((r) => r[0] === 73n)![1],
        format: JSON.parse(JSON.parse(final.snapshot!.text).logical).format,
      };
    },
    { artifact: built.artifact, hash: built.manifest.artifactSHA256 },
  );
  expect(result.legacy).toBe("moon-aot-chunks@1");
  expect(result.calls).toEqual([
    { bytes: 3, refs: 0 },
    { bytes: 1, refs: 2 },
    { bytes: 1, refs: 2 },
  ]);
  expect(result.lost && result.mixed).toBe(true);
  expect(result.recovered).toBe(107n);
  expect(result.noRowWrites).toBe(true);
  expect(result.records).toBe(result.parts);
  expect(result.deltas).toBe(0);
  expect(result.count).toBe(149);
  expect(result.n).toBe(103n);
  expect(result.next).toBe(105n);
  expect(result.format).toBe("moon-aot-chunks@2");
});
