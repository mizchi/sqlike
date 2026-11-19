import { test, expect } from "@playwright/test";
import { build } from "vite";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { applyLtx } from "../src/ltx.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type * as Runtime from "./fixtures/sqlite-pager-runtime.ts";
import type { SqliteAotPagerRuntime } from "../src/sqlite-pager-contract.ts";

test("incremental pages publish atomically in real IndexedDB, reject stale writers and reopen", async ({
  page,
}) => {
  const catalog = buildCatalog(
    {
      schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER,s TEXT)"],
      queries: [
        { name: "seed", sql: "INSERT INTO t VALUES(?1,?2,?3)" },
        { name: "update", sql: "UPDATE t SET n=?2 WHERE id=?1" },
      ],
    },
    { pageSize: 512 },
  );
  const output = await build({
    configFile: false,
    publicDir: false,
    logLevel: "error",
    build: {
      write: false,
      target: "esnext",
      lib: { entry: "e2e/fixtures/sqlite-pager-runtime.ts", formats: ["es"] },
    },
  });
  let code = "";
  for (const result of Array.isArray(output) ? output : [output])
    if ("output" in result)
      for (const c of result.output) if (c.type === "chunk") code += c.code;
  await page.route("**/pager-test", (r) =>
    r.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.route("**/pager-test.js", (r) =>
    r.fulfill({ contentType: "text/javascript", body: code }),
  );
  await page.goto("/pager-test");
  const result = await page.evaluate(async (artifact) => {
    const path = "/pager-test.js",
      {
        core,
        SqlitePagerClient,
        IndexedDbSqlitePageStore,
        toBase64,
        createPageLtxEncoder,
      } = (await import(path)) as typeof Runtime;
    const runtime = core as unknown as SqliteAotPagerRuntime,
      db = core.aot_open(artifact, "");
    const exec = (id: number, n: number) => {
      const r = JSON.parse(
        core.aot_execute(
          db,
          "update",
          JSON.stringify([
            { t: "integer", v: String(id) },
            { t: "integer", v: String(n) },
          ]),
        ),
      );
      if (r.error) throw Error(r.error);
    };
    for (let i = 1; i <= 1000; i++) {
      const r = JSON.parse(
        core.aot_execute(
          db,
          "seed",
          JSON.stringify([
            { t: "integer", v: String(i) },
            { t: "integer", v: "1" },
            { t: "text", v: "x".repeat(40) },
          ]),
        ),
      );
      if (r.error) throw Error(r.error);
    }
    const encoder = createPageLtxEncoder(
      core as unknown as import("../src/ltx-pages-host.ts").LtxPageCodec,
    );
    const store = await IndexedDbSqlitePageStore.open("incremental-e2e"),
      client = await SqlitePagerClient.open(
        runtime,
        store,
        (p) => runtime.aot_pager_prepare(db, p),
        { cachePages: 2, prepareCommit: encoder.prepareCommit },
      );
    const first = await client.flush();
    exec(500, 9);
    const delta = await client.flush();
    const saved = core.aot_dump(db),
      head = await store.head();
    let abort = true;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      const result = put.apply(this, args);
      if (abort && this.name === "pages") {
        abort = false;
        this.transaction.abort();
      }
      return result;
    };
    let failed = false;
    exec(501, 8);
    try {
      await client.flush();
    } catch {
      failed = true;
    } finally {
      IDBObjectStore.prototype.put = put;
    }
    const afterFailure = await store.head();
    if (
      afterFailure!.metadata !== head!.metadata ||
      JSON.stringify(afterFailure!.files) !== JSON.stringify(head!.files)
    )
      throw Error("partial LTX publication");
    const files = [];
    for (const name of head!.files ?? [])
      files.push({
        name,
        data: toBase64(await store.readFile(head!.generation, name)),
      });
    let poisoned = false;
    try {
      await client.flush();
    } catch (e) {
      poisoned = String(e).includes("reopen");
    }
    const image = new Uint8Array(head!.pageSize * head!.pageCount);
    for (let p = 1; p <= head!.pageCount; p++)
      image.set(
        await store.readPage(head!.generation, p),
        (p - 1) * head!.pageSize,
      );
    client.close();
    return {
      saved,
      files,
      image: toBase64(image),
      first: first.info.snapshot,
      delta: delta.info.snapshot,
      written: delta.commit!.pages.length,
      cacheBytes: delta.cacheBytes,
      failed,
      poisoned,
      generation: head!.generation,
      afterGeneration: afterFailure!.generation,
    };
  }, catalog.artifact);
  expect(result).toMatchObject({
    first: true,
    delta: false,
    written: 2,
    failed: true,
    poisoned: true,
  });
  expect(result.cacheBytes).toBeLessThanOrEqual(1024);
  expect(result.afterGeneration).toBe(result.generation);
  const directory = mkdtempSync(join(tmpdir(), "pager-idb-native-"));
  try {
    let previous: Uint8Array<ArrayBufferLike> = new Uint8Array();
    const level = join(directory, "replica", "ltx", "0");
    mkdirSync(level, { recursive: true });
    for (const [index, file] of result.files.entries()) {
      const data = Buffer.from(file.data, "base64");
      previous = applyLtx(previous, String(index), data, 3).data;
      const path = join(level, file.name);
      writeFileSync(path, data);
      execFileSync("go", ["run", "-mod=mod", ".", "verify", path], {
        cwd: "scripts/ltx-reference",
        stdio: "pipe",
      });
    }
    expect(Buffer.from(previous)).toEqual(Buffer.from(result.image, "base64"));
    const binary = process.env.LITESTREAM_BIN;
    expect(binary).toBeTruthy();
    const restored = join(directory, "restored.sqlite");
    execFileSync(
      binary!,
      [
        "restore",
        "-o",
        restored,
        pathToFileURL(join(directory, "replica")).href,
      ],
      { stdio: "pipe" },
    );
    expect(readFileSync(restored)).toEqual(Buffer.from(result.image, "base64"));
    const path = join(directory, "db.sqlite");
    writeFileSync(path, Buffer.from(result.image, "base64"));
    const native = new DatabaseSync(path);
    try {
      expect(
        native.prepare("PRAGMA integrity_check").all().map(Object.values),
      ).toEqual([["ok"]]);
      expect(
        native.prepare("SELECT count(*),sum(n) FROM t").get(),
      ).toMatchObject({ "count(*)": 1000, "sum(n)": 1008 });
    } finally {
      native.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  await page.reload();
  const resumed = await page.evaluate(
    async ({ artifact, saved }) => {
      const path = "/pager-test.js",
        {
          core,
          SqlitePagerClient,
          IndexedDbSqlitePageStore,
          createPageLtxEncoder,
        } = (await import(path)) as typeof Runtime;
      const runtime = core as unknown as SqliteAotPagerRuntime,
        db = core.aot_open(artifact, saved),
        store = await IndexedDbSqlitePageStore.open("incremental-e2e");
      const encoder = createPageLtxEncoder(
        core as unknown as import("../src/ltx-pages-host.ts").LtxPageCodec,
      );
      const client = await SqlitePagerClient.open(
        runtime,
        store,
        (p) => runtime.aot_pager_prepare(db, p),
        { prepareCommit: encoder.prepareCommit },
      );
      const bootstrap = await client.flush();
      const staleStore = await IndexedDbSqlitePageStore.open("incremental-e2e"),
        stale = await SqlitePagerClient.open(runtime, staleStore, (p) =>
          runtime.aot_pager_prepare(db, p),
        );
      core.aot_execute(
        db,
        "update",
        JSON.stringify([
          { t: "integer", v: "1" },
          { t: "integer", v: "3" },
        ]),
      );
      await client.flush();
      let rejected = false;
      try {
        await stale.flush();
      } catch (e) {
        rejected = String(e).includes("stale");
      }
      const head = await store.head();
      client.close();
      stale.close();
      return {
        snapshot: bootstrap.info.snapshot,
        rejected,
        generation: head!.generation,
      };
    },
    { artifact: catalog.artifact, saved: result.saved },
  );
  expect(resumed.snapshot).toBe(true);
  expect(resumed.rejected).toBe(true);
  expect(resumed.generation).toBeGreaterThan(result.generation);
});
