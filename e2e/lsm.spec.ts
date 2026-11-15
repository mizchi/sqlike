import { test, expect } from "@playwright/test";
import { build } from "vite";
import type * as Runtime from "./fixtures/lsm-runtime.ts";
let code = "";
test.beforeAll(async () => {
  const built = await build({
    configFile: false,
    publicDir: false,
    logLevel: "error",
    build: {
      write: false,
      minify: true,
      target: "esnext",
      lib: { entry: "e2e/fixtures/lsm-runtime.ts", formats: ["es"] },
    },
  });
  for (const output of Array.isArray(built) ? built : [built])
    if ("output" in output)
      for (const item of output.output)
        if (item.type === "chunk") code += item.code;
});
test("LSM durable WAL/run publication survives IDB aborts, stale writers and pinned cross-connection readers", async ({
  page,
}) => {
  await page.route("**/lsm-test", (r) =>
    r.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.route("**/lsm-test.js", (r) =>
    r.fulfill({ contentType: "text/javascript", body: code }),
  );
  await page.goto("/lsm-test");
  const actual = await page.evaluate(async () => {
    const path = "/lsm-test.js";
    const { LsmDatabase, IndexedDbLsmStorage } = (await import(
      path
    )) as typeof Runtime;
    const options = {
      memtableBytes: 1024,
      blockBytes: 256,
      cacheBytes: 512,
      fanout: 2,
    };
    const open = async () =>
      LsmDatabase.open(await IndexedDbLsmStorage.open("durable-test"), options);
    const a = await open(),
      stale = await open();
    await a.writeBatch([
      { key: -9223372036854775808n, value: new Uint8Array([1, 2]) },
      { key: 7n, value: new Uint8Array() },
    ]);
    let conflict = false;
    try {
      await stale.writeBatch([{ key: 7n, value: null }]);
    } catch {
      conflict = true;
    }
    stale.close();
    await a.flush();
    const snapshot = a.snapshot();
    // Another connection may compact while this reader keeps the old manifest.
    const b = await open();
    await b.writeBatch([
      { key: -9223372036854775808n, value: null },
      { key: 7n, value: new Uint8Array([9]) },
    ]);
    for (let i = 0; i < 18; i++) {
      await b.writeBatch([
        { key: BigInt(i + 100), value: new Uint8Array(150).fill(i) },
      ]);
      await b.flush();
    }
    await b.compact();
    const pinned = Array.from((await snapshot.get(-9223372036854775808n))!);
    snapshot.close();
    a.close();
    await b.writeBatch([{ key: 8n, value: new Uint8Array([8]) }]);
    // Queue the new root put, then abort its entire transaction. Newly staged
    // run blocks stay invisible and the preceding durable WAL remains readable.
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      const request = put.apply(this, args);
      if (this.name === "head") throw Error("abort staged root publication");
      return request;
    };
    let aborted = false;
    try {
      await b.flush();
    } catch {
      aborted = true;
    } finally {
      IDBObjectStore.prototype.put = put;
    }
    b.close();
    const recovered = await open();
    const walRecovered = Array.from((await recovered.get(8n))!);
    const deleted = (await recovered.get(-9223372036854775808n)) === undefined;
    const rows: string[] = [];
    for await (const [k] of recovered.scan({ gte: 7n, lt: 101n }))
      rows.push(String(k));
    await recovered.compact();
    recovered.close();
    const provider = await IndexedDbLsmStorage.open("buffer-test");
    const input = new Uint8Array([1, 2, 3, 4]),
      id = crypto.randomUUID();
    const staging = provider.stageBlock(id, input.subarray(1, 3));
    input.fill(0);
    await staging;
    const captured = Array.from(await provider.readBlock(id));
    const data = new Uint8Array([5]);
    const publish = provider.publish(0, { append: data });
    data[0] = 0;
    await publish;
    const walCaptured = Array.from((await provider.readHead()).wal[0]!);
    let duplicate = false;
    try {
      await provider.stageBlock(id, new Uint8Array([9]));
    } catch {
      duplicate = true;
    }
    const diag = await provider.diagnostics();
    provider.close();
    return {
      conflict,
      pinned,
      aborted,
      walRecovered,
      deleted,
      rows,
      captured,
      walCaptured,
      duplicate,
      diag,
    };
  });
  expect(actual).toEqual({
    conflict: true,
    pinned: [1, 2],
    aborted: true,
    walRecovered: [8],
    deleted: true,
    rows: ["7", "8", "100"],
    captured: [2, 3],
    walCaptured: [5],
    duplicate: true,
    diag: { storedBlocks: 1, storedBlockBytes: 2 },
  });
  await page.reload();
  expect(
    await page.evaluate(async () => {
      const path = "/lsm-test.js",
        { LsmDatabase, IndexedDbLsmStorage } = (await import(
          path
        )) as typeof Runtime;
      const db = await LsmDatabase.open(
        await IndexedDbLsmStorage.open("durable-test"),
      );
      try {
        return Array.from((await db.get(8n))!);
      } finally {
        db.close();
      }
    }),
  ).toEqual([8]);
});
