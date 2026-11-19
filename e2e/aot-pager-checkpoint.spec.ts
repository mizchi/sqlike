import { test, expect } from "@playwright/test";
import { build } from "vite";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import type * as Fixture from "./fixtures/aot-pager-checkpoint.ts";

test("AOT checkpoint co-publishes logical/page/LTX state through IDB abort, lost ACK, reload, upload and GC", async ({
  page,
  request,
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
    publicDir: false,
    logLevel: "error",
    build: {
      write: false,
      target: "esnext",
      lib: {
        entry: "e2e/fixtures/aot-pager-checkpoint.ts",
        formats: ["es"],
        fileName: () => "runtime.js",
      },
    },
  });
  const files = new Map<string, string>();
  for (const output of Array.isArray(outputs) ? outputs : [outputs])
    if ("output" in output)
      for (const c of output.output) {
        if (c.type === "chunk") files.set(c.fileName, c.code);
      }
  await page.route("**/aot-pager-fixture/**", (r) => {
    const name = new URL(r.request().url()).pathname.replace(
      "/aot-pager-fixture/",
      "",
    );
    return r.fulfill({
      contentType: "text/javascript",
      body: files.get(name) ?? 'throw Error("missing test chunk")',
    });
  });
  await page.route("**/aot-pager-test", (r) =>
    r.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.goto("/aot-pager-test");
  const input = {
    artifact: built.artifact,
    hash: built.manifest.artifactSHA256,
  };
  const first = await page.evaluate(async ({ artifact, hash }) => {
    const path = "/aot-pager-fixture/runtime.js";
    const { AotDatabase, IndexedDbAotPageStore, state } = (await import(
      path
    )) as typeof Fixture;
    const store = await IndexedDbAotPageStore.open("aot-joint-checkpoint");
    state.store = store;
    const db = await AotDatabase.withStore(artifact, hash, store, {
      sqlitePages: true,
      cachePages: 2,
    });
    state.db = db;
    for (let i = 1; i <= 80; i++)
      await db.execute("add", [BigInt(i), 100n, "x".repeat(32)]);
    const first = await db.checkpoint();
    await db.execute("update", [101n, 40n]);
    const before = await store.read(),
      head = await store.pages.head();
    let abort = true;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      const result = put.apply(this, args);
      if (abort && this.name === "sqlite-files") {
        abort = false;
        this.transaction.abort();
      }
      return result;
    };
    let failure = "";
    try {
      await db.checkpoint();
    } catch (e) {
      failure = String(e);
    } finally {
      IDBObjectStore.prototype.put = put;
    }
    const after = await store.read(),
      afterHead = await store.pages.head();
    await db.close();
    const resumedStore = await IndexedDbAotPageStore.open(
      "aot-joint-checkpoint",
    );
    state.store = resumedStore;
    const resumed = await AotDatabase.withStore(artifact, hash, resumedStore, {
      sqlitePages: true,
    });
    state.db = resumed;
    const recovered = await resumed.inspect("all");
    await resumed.checkpoint();
    await resumed.execute("update", [102n, 41n]);
    const commit = resumedStore.commitWithPages.bind(resumedStore);
    resumedStore.commitWithPages = async (...args) => {
      await commit(...args);
      throw Error("durable ACK lost");
    };
    let lost = "";
    try {
      await resumed.checkpoint();
    } catch (e) {
      lost = String(e);
    }
    await resumed.close();
    return {
      first: first.pages,
      failed: !!failure,
      unchanged:
        JSON.stringify(before) === JSON.stringify(after) &&
        JSON.stringify(head) === JSON.stringify(afterHead),
      recovered: recovered.rows[39]![1],
      lost,
    };
  }, input);
  expect(first.first?.snapshot).toBe(true);
  expect(first.failed).toBe(true);
  expect(first.unchanged).toBe(true);
  expect(first.recovered).toBe(101n);
  expect(first.lost).toContain("ACK lost");
  await page.reload();
  const durable = await page.evaluate(async ({ artifact, hash }) => {
    const path = "/aot-pager-fixture/runtime.js";
    const { AotDatabase, IndexedDbAotPageStore, state, toBase64 } =
      (await import(path)) as typeof Fixture;
    // Exercises the ordinary open API's optional provider selection and stored-mode detection.
    const db = await AotDatabase.open(
      "joint-checkpoint",
      artifact,
      hash,
      undefined,
      { sqlitePages: true },
    );
    state.db = db;
    const store = await IndexedDbAotPageStore.open("aot-joint-checkpoint");
    state.store = store;
    const logical = await store.read(),
      head = await store.pages.head();
    const pending = await db.pending();
    let stale = false;
    try {
      await store.commitWithPages(
        logical.generation,
        { delta: { text: "never visible" } },
        head!.generation - 1,
        { ...head!, files: undefined, snapshot: false, pages: [] },
      );
    } catch {
      stale = true;
    }
    const after = await store.read();
    return {
      head: (await db.inspect("all")).head,
      rows: (await db.inspect("all")).rows,
      pending: pending.map((f) => ({ ...f, data: toBase64(f.data) })),
      image: toBase64(await db.exportSQLite()),
      stale,
      logicalUnchanged: JSON.stringify(after) === JSON.stringify(logical),
      files: head!.files,
    };
  }, input);
  expect(durable.head).toBe("3");
  expect(durable.rows[40]![1]).toBe(102n);
  expect(durable.pending).toHaveLength(3);
  expect(durable.stale && durable.logicalUnchanged).toBe(true);
  const root = mkdtempSync(join(tmpdir(), "aot-pager-idb-"));
  try {
    const replica = join(root, "replica"),
      level = join(replica, "ltx", "0");
    mkdirSync(level, { recursive: true });
    for (const f of durable.pending) {
      const path = join(level, f.name);
      writeFileSync(path, Buffer.from(f.data, "base64"));
      execFileSync("go", ["run", "-mod=mod", ".", "verify", path], {
        cwd: "scripts/ltx-reference",
        stdio: "pipe",
      });
    }
    expect(process.env.LITESTREAM_BIN).toBeTruthy();
    const output = join(root, "restored.sqlite");
    execFileSync(
      process.env.LITESTREAM_BIN!,
      ["restore", "-o", output, pathToFileURL(replica).href],
      { stdio: "pipe" },
    );
    expect(readFileSync(output)).toEqual(Buffer.from(durable.image, "base64"));
    const db = new DatabaseSync(output);
    try {
      expect(db.prepare("PRAGMA integrity_check").get()!.integrity_check).toBe(
        "ok",
      );
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const endpoint = `http://127.0.0.1:14173/aot-ltx/pager${Date.now()}`;
  let lose = true;
  await page.route(endpoint + "/**", async (route) => {
    if (lose) {
      lose = false;
      await route.fetch();
      await route.abort("connectionfailed");
    } else await route.continue();
  });
  const lost = await page.evaluate(async (endpoint) => {
    const path = "/aot-pager-fixture/runtime.js";
    const { state, uploadAotLtx } = (await import(path)) as typeof Fixture;
    try {
      await uploadAotLtx(state.db!, endpoint);
    } catch {}
    return (await state.db!.pending()).length;
  }, endpoint);
  expect(lost).toBe(3);
  expect((await (await request.get(endpoint)).json()).head).toBe("1");
  await page.unroute(endpoint + "/**");
  const uploaded = await page.evaluate(async (endpoint) => {
    const path = "/aot-pager-fixture/runtime.js";
    const { state, uploadAotLtx } = (await import(path)) as typeof Fixture;
    const uploaded = await uploadAotLtx(state.db!, endpoint);
    const head = await state.store!.pages.head();
    // First post-reload checkpoint bootstraps the pager; ACK pruning then keeps it warm.
    await state.db!.execute("update", [103n, 42n]);
    await state.db!.checkpoint();
    await uploadAotLtx(state.db!, endpoint);
    await state.db!.execute("update", [104n, 43n]);
    const next = await state.db!.checkpoint();
    await state.db!.close();
    state.store!.close();
    return {
      uploaded: uploaded.uploaded,
      files: head!.files,
      ackedAfterGC: head!.generation,
      next: next.pages,
    };
  }, endpoint);
  expect(uploaded.uploaded).toBe(3);
  expect(uploaded.files).toEqual([]);
  expect(uploaded.next?.snapshot).toBe(false);
  expect(uploaded.next?.written).toBe(2);
});
