import { test } from "node:test";
import assert from "node:assert/strict";
import { MemorySqlitePageStore } from "../adapters/sqlite-page-store.ts";
import { SqlitePagerClient } from "../src/sqlite-pager.ts";
import type {
  SqlitePageCommit,
  SqlitePageStore,
  SqliteAotPagerRuntime,
} from "../src/sqlite-pager-contract.ts";
import * as raw from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import { aotBindings } from "../src/aot-values.ts";

const initial: SqlitePageCommit = {
  programId: "test",
  pageSize: 512,
  pageCount: 2,
  serial: 1,
  snapshot: true,
  pages: [
    { page: 1, data: new Uint8Array(512) },
    { page: 2, data: new Uint8Array(512).fill(2) },
  ],
};
test("page providers own payloads, CAS generations, preserve clean pages and validate growth", async () => {
  const store = new MemorySqlitePageStore(),
    other = store.fork();
  const input = structuredClone(initial),
    promise = store.commit(0, input);
  input.pages[0]!.data.fill(9);
  const first = await promise;
  assert.equal(first.generation, 1);
  assert.equal((await store.readPage(1, 1))[0], 0);
  const buffers = new MemorySqlitePageStore();
  const backing = Buffer.alloc(512, 4);
  const pending = buffers.commit(0, {
    ...initial,
    pages: [{ page: 1, data: backing }, initial.pages[1]!],
  });
  backing.fill(9);
  await pending;
  assert.equal((await buffers.readPage(1, 1))[0], 4);
  const read = await store.readPage(1, 2);
  read.fill(9);
  assert.equal((await store.readPage(1, 2))[0], 2);
  await assert.rejects(other.commit(0, initial), /stale/);
  await store.commit(1, {
    ...initial,
    snapshot: false,
    serial: 2,
    pages: [{ page: 1, data: new Uint8Array(512).fill(3) }],
  });
  assert.equal((await other.readPage(2, 2))[0], 2);
  await assert.rejects(store.readPage(1, 1), /stale/);
  const before = await store.head();
  for (const value of [
    { ...initial, snapshot: false, pageCount: 3, pages: [] },
    { ...initial, pages: [initial.pages[0]!, initial.pages[0]!] },
    {
      ...initial,
      pages: [{ page: 1, data: new Uint8Array(1) }, initial.pages[1]!],
    },
  ]) {
    await assert.rejects(store.commit(2, value), /page/);
    assert.deepEqual(await store.head(), before);
  }
  await store.commit(2, {
    ...initial,
    pageCount: 1,
    serial: 3,
    pages: [initial.pages[0]!],
  });
  await assert.rejects(store.readPage(3, 2), /missing/);
});

test("page generations publish LTX files and checksum state together", async () => {
  const store = new MemorySqlitePageStore();
  await store.commit(0, {
    ...initial,
    metadata: "checksum-state",
    files: [{ name: "1-1.ltx", data: new Uint8Array([1, 2, 3]) }],
  });
  assert.equal((await store.head())!.metadata, "checksum-state");
  assert.deepEqual((await store.head())!.files, ["1-1.ltx"]);
  assert.deepEqual(
    await (store as SqlitePageStore).readFile!(1, "1-1.ltx"),
    new Uint8Array([1, 2, 3]),
  );
  const before = await store.head();
  await assert.rejects(
    store.commit(1, {
      ...initial,
      metadata: "wrong",
      files: [{ name: "1-1.ltx", data: new Uint8Array([9]) }],
    }),
    /file/,
  );
  assert.deepEqual(await store.head(), before);
  await store.commit(1, {
    ...initial,
    snapshot: false,
    pages: [],
    removeFiles: ["1-1.ltx"],
  });
  await assert.rejects(
    (store as SqlitePageStore).readFile!(2, "1-1.ltx"),
    /missing/,
  );
});

test("the host bounds clean-page cache, ACKs durable commits and requires reopen after lost ACK", async () => {
  const runtime = raw as unknown as SqliteAotPagerRuntime;
  const source = {
    schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER,s TEXT)"],
    queries: [
      { name: "seed", sql: "INSERT INTO t VALUES(?1,?2,?3)" },
      { name: "change", sql: "UPDATE t SET n=?2 WHERE id=?1" },
    ],
  };
  const db = raw.aot_open(buildCatalog(source, { pageSize: 512 }).artifact, "");
  const exec = (name: string, args: any[]) => {
    const r = JSON.parse(raw.aot_execute(db, name, aotBindings(args)));
    assert.equal(r.error, undefined);
  };
  for (let i = 1; i <= 2000; i++) exec("seed", [BigInt(i), 1n, "v".repeat(30)]);
  const memory = new MemorySqlitePageStore();
  let loseAck = false,
    ackCount = 0;
  const provider: SqlitePageStore = {
    head: () => memory.head(),
    readPage: (g, p) => memory.readPage(g, p),
    close: () => {},
    commit: async (g, c) => {
      const head = await memory.commit(g, c);
      if (loseAck) throw Error("lost durable ACK");
      return head;
    },
  };
  const api = {
    ...runtime,
    sqlite_pager_ack: (pager: any, batch: any) => {
      ackCount++;
      return runtime.sqlite_pager_ack(pager, batch);
    },
  };
  const client = await SqlitePagerClient.open(
    api,
    provider,
    (pager) => runtime.aot_pager_prepare(db, pager),
    { cachePages: 2 },
  );
  const first = await client.flush();
  assert.equal(first.info.snapshot, true);
  assert.ok(first.cacheBytes <= 1024);
  assert.equal(ackCount, 1);
  exec("change", [500n, 9n]);
  const next = await client.flush();
  assert.equal(next.info.snapshot, false);
  assert.ok(next.reads < 10);
  assert.equal(next.commit!.pages.length, 2);
  assert.ok(next.cacheBytes <= 1024);
  assert.equal(ackCount, 2);
  const noop = await client.flush();
  assert.equal(noop.created, false);
  assert.equal(noop.head!.generation, next.head!.generation);
  exec("change", [501n, 8n]);
  loseAck = true;
  const acked = ackCount;
  await assert.rejects(client.flush(), /lost durable ACK/);
  assert.equal(ackCount, acked);
  await assert.rejects(client.flush(), /reopen/);
  loseAck = false;
  const reopened = await SqlitePagerClient.open(
    runtime,
    provider,
    (pager) => runtime.aot_pager_prepare(db, pager),
    { cachePages: 0 },
  );
  const fresh = await reopened.flush();
  assert.equal(fresh.info.snapshot, true);
  assert.equal(fresh.cacheBytes, 0);
});
