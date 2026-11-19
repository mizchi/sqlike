import { test, expect } from "@playwright/test";
import { build } from "vite";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import type * as Fixture from "./fixtures/aot-pager-checkpoint.ts";
import { applyLtx } from "../src/ltx.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { SqlAotLtxStore } from "../adapters/aot-ltx-store.ts";
import { AotLtxGateway, aotLtxResponse } from "../src/aot-ltx-gateway.ts";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const built = buildCatalog(
  {
    schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)"],
    queries: [
      { name: "add", sql: "INSERT INTO t VALUES(?,?)" },
      { name: "update", sql: "UPDATE t SET n=? WHERE id=?" },
      { name: "all", sql: "SELECT id,n FROM t ORDER BY id" },
    ],
  },
  { pageSize: 512 },
);
let code = "";
test.beforeAll(async () => {
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
  for (const out of Array.isArray(outputs) ? outputs : [outputs])
    if ("output" in out)
      for (const c of out.output) if (c.type === "chunk") code += c.code;
});
test.beforeEach(async ({ page }) => {
  await page.route("**/outbox-fixture.js", (r) =>
    r.fulfill({ contentType: "text/javascript", body: code }),
  );
  await page.route("**/outbox-fixture", (r) =>
    r.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.goto("/outbox-fixture");
});

test("128 pending files defer export while SQL stays durable, then one verified ACK enables a catch-up checkpoint", async ({
  page,
}) => {
  const result = await page.evaluate(
    async ({ artifact, hash }) => {
      const path = "/outbox-fixture.js",
        { AotDatabase, IndexedDbAotPageStore, toBase64 } = (await import(
          path
        )) as typeof Fixture;
      let store = await IndexedDbAotPageStore.open("aot-outbox-default"),
        db = await AotDatabase.withStore(artifact, hash, store, {
          sqlitePages: true,
        });
      await db.execute("add", [1n, 0n]);
      await db.checkpoint();
      for (let n = 1; n < 128; n++) {
        await db.execute("update", [BigInt(n), 1n]);
        await db.checkpoint();
      }
      const original = await db.pending(),
        head = await store.pages.head();
      const commit = store.commitWithPages.bind(store);
      let pagePublications = 0;
      store.commitWithPages = async (...args) => {
        pagePublications++;
        return commit(...args);
      };
      let deferred;
      for (let n = 128; n <= 160; n++) {
        await db.execute("update", [BigInt(n), 1n]);
        deferred = await db.checkpoint();
      }
      const generation = (await store.read()).generation;
      await db.checkpoint();
      const untouched =
        generation === (await store.read()).generation &&
        JSON.stringify(head) === JSON.stringify(await store.pages.head());
      const pending = await db.pending();
      const bytesUntouched =
        JSON.stringify(original.map((f) => f.sha256)) ===
        JSON.stringify(pending.map((f) => f.sha256));
      await db.close();
      store = await IndexedDbAotPageStore.open("aot-outbox-default");
      db = await AotDatabase.withStore(artifact, hash, store, {
        sqlitePages: true,
      });
      const recovered = (await db.inspect("all")).rows[0]![1],
        stillDeferred = await db.checkpoint();
      await db.execute("update", [161n, 1n]);
      await db.acknowledge("1", original[0]!.sha256);
      const resumed = await db.checkpoint(),
        last = (await db.pending()).at(-1)!;
      const noOp = await db.checkpoint(),
        image = toBase64(await db.exportSQLite());
      await db.close();
      return {
        deferred,
        stillDeferred,
        untouched,
        bytesUntouched,
        pagePublications,
        recovered,
        resumed,
        noOp,
        image,
        files: [...original, last].map((f) => ({
          ...f,
          data: toBase64(f.data),
        })),
      };
    },
    { artifact: built.artifact, hash: built.manifest.artifactSHA256 },
  );
  expect(result.deferred).toEqual({
    created: false,
    head: "128",
    deferred: { reason: "outbox-full", pending: 128, limit: 128 },
  });
  expect(result.stillDeferred).toEqual(result.deferred);
  expect(result.untouched && result.bytesUntouched).toBe(true);
  expect(result.pagePublications).toBe(0);
  expect(result.recovered).toBe(160n);
  expect(result.resumed.created).toBe(true);
  expect(result.resumed.head).toBe("129");
  expect(result.noOp).toEqual({ created: false, head: "129" });
  let image: Uint8Array = new Uint8Array(),
    head = "0";
  for (const f of result.files) {
    image = applyLtx(image, head, Buffer.from(f.data, "base64"), 3).data;
    head = f.maxTXID;
  }
  expect(Buffer.from(image)).toEqual(Buffer.from(result.image, "base64"));
  const dir = mkdtempSync(join(tmpdir(), "aot-outbox-"));
  try {
    const path = join(dir, "state.sqlite");
    writeFileSync(path, image);
    const sql = new DatabaseSync(path);
    try {
      expect(sql.prepare("PRAGMA integrity_check").get()!.integrity_check).toBe(
        "ok",
      );
      expect(sql.prepare("SELECT n FROM t").get()!.n).toBe(161);
    } finally {
      sql.close();
    }
    // A single native restore verifies the full history, including the skipped checkpoints.
    expect(process.env.LITESTREAM_BIN).toBeTruthy();
    const level = join(dir, "replica", "ltx", "0");
    mkdirSync(level, { recursive: true });
    for (const f of result.files)
      writeFileSync(join(level, f.name), Buffer.from(f.data, "base64"));
    const output = join(dir, "restored.sqlite");
    execFileSync(
      process.env.LITESTREAM_BIN!,
      ["restore", "-o", output, pathToFileURL(join(dir, "replica")).href],
      { stdio: "pipe" },
    );
    expect(readFileSync(output)).toEqual(Buffer.from(image));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sync recovers the full page outbox after remote ACK loss and sends the latest logical state", async ({
  page,
}) => {
  const remote = new NodeDatabase(":memory:"),
    store = new SqlAotLtxStore(remote),
    gateway = new AotLtxGateway(store);
  let lose = true;
  await page.route("**/aot-ltx/outbox/**", async (route) => {
    const request = route.request(),
      body = request.postDataBuffer(),
      response = await aotLtxResponse(
        gateway,
        new Request(request.url(), {
          method: request.method(),
          headers: request.headers(),
          body: body ? Uint8Array.from(body) : undefined,
        }),
      );
    if (lose) {
      lose = false;
      await route.abort();
      return;
    }
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
  try {
    const result = await page.evaluate(
      async ({ artifact, hash }) => {
        const path = "/outbox-fixture.js",
          { AotDatabase, IndexedDbAotPageStore, syncAotLtx, toBase64 } =
            (await import(path)) as typeof Fixture;
        const open = async () =>
          AotDatabase.withStore(
            artifact,
            hash,
            await IndexedDbAotPageStore.open("aot-outbox-sync"),
            { sqlitePages: true, outboxLimit: 2 },
          );
        let db = await open();
        for (let i = 1; i <= 2; i++) {
          await db.execute("add", [BigInt(i), 100n]);
          await db.checkpoint();
        }
        for (let i = 3; i <= 8; i++) await db.execute("add", [BigInt(i), 100n]);
        const deferred = await db.checkpoint(),
          endpoint = new URL("/aot-ltx/outbox", location.origin).href;
        let lost = false;
        try {
          await syncAotLtx(db, endpoint);
        } catch {
          lost = true;
        }
        const pending = (await db.pending()).length;
        await db.close();
        db = await open();
        const result = await syncAotLtx(db, endpoint),
          state = await db.inspect("all"),
          image = toBase64(await db.exportSQLite());
        await db.close();
        db = await open();
        const noOp = await db.checkpoint(),
          rows = (await db.inspect("all")).rows.length;
        await db.close();
        return { deferred, lost, pending, result, state, image, noOp, rows };
      },
      { artifact: built.artifact, hash: built.manifest.artifactSHA256 },
    );
    expect(result.lost).toBe(true);
    expect(result.pending).toBe(2);
    expect(result.deferred.deferred?.reason).toBe("outbox-full");
    expect(result.result.uploaded).toBe(3);
    expect(result.state.pending).toHaveLength(0);
    expect(result.state.acked).toBe("3");
    expect(result.rows).toBe(8);
    expect(result.noOp).toEqual({ created: false, head: "3" });
    expect(Buffer.from(await store.image())).toEqual(
      Buffer.from(result.image, "base64"),
    );
  } finally {
    remote.close();
  }
});

test("the Worker demo shows a deferred checkpoint as locally saved and recovers the unsent edit after reload", async ({
  page,
}) => {
  await page.goto(`/lite/?client=outbox${crypto.randomUUID()}`);
  await page.waitForFunction(() => window.liteDemo?.ready);
  await page.evaluate(async () => {
    const db = window.liteDemo;
    await db.execute("add", [1n, "offline", 0n]);
    await db.checkpoint();
    for (let n = 1; n < 128; n++) {
      await db.execute("edit", ["offline", BigInt(n), 1n]);
      await db.checkpoint();
    }
    await db.execute("edit", ["still writable", 128n, 1n]);
  });
  await page.getByRole("button", { name: "LTX を生成", exact: true }).click();
  await expect(page.locator("#status")).toContainText(
    "ローカル保存済み・次回同期で再試行",
  );
  await expect(page.locator("#error")).toBeEmpty();
  const state = await page.evaluate(() => window.liteDemo.state());
  expect(state.pending).toHaveLength(128);
  expect(state.head).toBe("128");
  expect(state.serial).toBeGreaterThan(state.checkpointSerial);
  await page.reload();
  await page.waitForFunction(() => window.liteDemo?.ready);
  await expect(page.locator("#status")).toContainText("送信待ちの更新あり");
  await expect(page.locator("#notes")).toContainText("still writable");
  await expect(page.locator("#error")).toBeEmpty();
  expect((await page.evaluate(() => window.liteDemo.state())).rows).toEqual([
    [1n, "still writable", 128n],
  ]);
});
