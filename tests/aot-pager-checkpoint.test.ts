import { test } from "node:test";
import assert from "node:assert/strict";
import { AotDatabase } from "../adapters/aot-database.ts";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import {
  MemorySqlitePageStore,
  capturePageCommit,
  nextPageHead,
} from "../adapters/sqlite-page-store.ts";
import type { ImageDelta, ImageStore } from "../src/persistence-contract.ts";
import type {
  SqlitePageCommit,
  SqlitePageHead,
} from "../src/sqlite-pager-contract.ts";
import { applyLtx } from "../src/ltx.ts";
import { uploadAotLtx } from "../src/aot-upload.ts";
import { AotLtxGateway, aotLtxResponse } from "../src/aot-ltx-gateway.ts";
import { SqlAotLtxStore } from "../adapters/aot-ltx-store.ts";
import { NodeDatabase } from "../adapters/node-database.ts";

/** One visible assignment models the provider's atomic publication boundary. */
class Store implements ImageStore {
  state: {
    generation: number;
    image?: string;
    deltas: ImageDelta[];
    head?: SqlitePageHead;
    pages: Map<number, Uint8Array>;
    files: Map<string, Uint8Array>;
    checksums: Map<number, Uint8Array>;
  } = {
    generation: 0,
    deltas: [],
    pages: new Map(),
    files: new Map(),
    checksums: new Map(),
  };
  fault?: "before" | "after";
  last?: SqlitePageCommit;
  get pages() {
    return new MemorySqlitePageStore(this.state);
  }
  async read() {
    const { generation, image, deltas } = this.state;
    return { generation, image, deltas: structuredClone(deltas) };
  }
  checkpointNeeded() {
    return this.state.deltas.length >= 8;
  }
  async commit(expected: number, image: string) {
    return this.write(expected, { image });
  }
  async commitDelta(expected: number, delta: ImageDelta) {
    return this.write(expected, { delta });
  }
  async commitWithPages(
    expected: number,
    logical: { image: string } | { delta: ImageDelta },
    pageGeneration: number,
    value: SqlitePageCommit,
  ) {
    const pages = capturePageCommit(value),
      head = nextPageHead(pageGeneration, this.state.head, pages);
    this.last = pages;
    return {
      generation: this.write(expected, logical, { head, write: pages }),
      head,
    };
  }
  private write(
    expected: number,
    logical: { image: string } | { delta: ImageDelta },
    page?: { head: SqlitePageHead; write: SqlitePageCommit },
  ) {
    if (expected !== this.state.generation)
      throw Error("stale logical generation");
    const fault = this.fault;
    this.fault = undefined;
    if (fault === "before") throw Error("publication aborted");
    const next = structuredClone(this.state);
    next.generation++;
    if ("image" in logical) {
      next.image = logical.image;
      next.deltas = [];
    } else next.deltas.push(structuredClone(logical.delta));
    if (page) {
      next.head = page.head;
      if (page.write.snapshot) next.pages.clear();
      for (const p of page.write.pages) next.pages.set(p.page, p.data);
      for (const p of next.pages.keys())
        if (p > page.head.pageCount) next.pages.delete(p);
      for (const name of page.write.removeFiles ?? []) next.files.delete(name);
      for (const f of page.write.files ?? []) next.files.set(f.name, f.data);
      if (page.write.checksumSnapshot) next.checksums.clear();
      for (const c of page.write.checksums ?? [])
        next.checksums.set(c.page, c.data);
      for (const p of next.checksums.keys())
        if (p > page.head.pageCount) next.checksums.delete(p);
    }
    this.state = next;
    if (fault === "after") throw Error("publication ACK lost");
    return next.generation;
  }
  close() {}
}
const built = buildCatalog(
  {
    schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER,s TEXT)"],
    queries: [
      { name: "add", sql: "INSERT INTO t VALUES(?,?,?)" },
      { name: "update", sql: "UPDATE t SET n=? WHERE id=?" },
      { name: "all", sql: "SELECT id,n,s FROM t ORDER BY id" },
      { name: "begin", sql: "BEGIN" },
      { name: "commit", sql: "COMMIT" },
      { name: "rollback", sql: "ROLLBACK" },
    ],
  },
  { pageSize: 512 },
);
const open = (store: Store) =>
  AotDatabase.withStore(built.artifact, built.manifest.artifactSHA256, store, {
    sqlitePages: true,
  });

test("checkpoint atomically publishes logical state/pages/LTX, resumes and prunes ACKed files without resetting the pager", async () => {
  const store = new Store();
  let db = await open(store);
  for (let i = 1; i <= 40; i++)
    await db.execute("add", [BigInt(i), 100n, "x".repeat(32)]);
  const first = await db.checkpoint();
  assert.equal(
    store.state.head?.generation,
    1,
    "checkpoint must use the page provider",
  );
  assert.equal(first.created, true);
  const initial = (await db.pending())[0]!;
  await db.execute("update", [101n, 20n]);
  const second = await db.checkpoint();
  assert.equal(second.created, true);
  assert.equal(store.last!.snapshot, false);
  assert.equal(store.last!.pages.length, 2);
  const pending = await db.pending();
  const image = applyLtx(
    applyLtx(new Uint8Array(), "0", initial.data, 3).data,
    "1",
    pending[1]!.data,
    3,
  ).data;
  assert.deepEqual(await db.exportSQLite(), image);
  assert.equal(store.last!.files?.length, 1);
  assert.equal(
    store.state.deltas.at(-1)?.blobs?.some((b) => b.length > 0) ?? false,
    false,
    "logical journal must not duplicate the page image or LTX bytes",
  );
  await db.acknowledge("1", initial.sha256);
  assert.equal(store.state.files.has(initial.name), false);
  await db.execute("update", [102n, 21n]);
  await db.checkpoint();
  assert.equal(
    store.last!.snapshot,
    false,
    "outbox GC must preserve the engine baseline",
  );
  await db.close();
  db = await open(store);
  assert.equal((await db.inspect("all")).rows[20]![1], 102n);
  assert.equal((await db.checkpoint()).created, false);
  assert.deepEqual(
    (await db.pending()).map((f) => f.maxTXID),
    ["2", "3"],
  );
  await db.close();
});

test("aborted and uncertain page publications recover one consistent checkpoint and refuse stale writers", async () => {
  const store = new Store();
  let db = await open(store);
  await db.execute("add", [1n, 100n, "base"]);
  await db.checkpoint();
  await db.execute("update", [101n, 1n]);
  const before = structuredClone(store.state);
  store.fault = "before";
  await assert.rejects(db.checkpoint(), /aborted/);
  assert.deepEqual(store.state, before);
  await assert.rejects(db.inspect("all"), /reload/);
  await db.close();
  db = await open(store);
  assert.equal((await db.inspect("all")).rows[0]![1], 101n);
  store.fault = "after";
  await assert.rejects(db.checkpoint(), /ACK lost/);
  await db.close();
  db = await open(store);
  assert.equal((await db.inspect("all")).head, "2");
  assert.equal((await db.pending()).length, 2);
  const stale = await open(store);
  await db.execute("update", [102n, 1n]);
  await db.checkpoint();
  await assert.rejects(stale.execute("update", [103n, 1n]), /stale/);
  await db.close();
  await stale.close();
});

test("legacy inline checkpoints switch atomically while preserving history and retryable uploads", async () => {
  const store = new Store();
  let db = await AotDatabase.withStore(
    built.artifact,
    built.manifest.artifactSHA256,
    store,
  );
  await db.execute("add", [1n, 100n, "legacy"]);
  await db.checkpoint();
  await db.execute("update", [101n, 1n]);
  await db.checkpoint();
  const legacy = await db.pending();
  await db.close();
  db = await open(store);
  await db.execute("update", [102n, 1n]);
  store.fault = "before";
  await assert.rejects(db.checkpoint(), /aborted/);
  assert.equal(store.state.head, undefined);
  await db.close();
  db = await open(store);
  await db.checkpoint();
  const files = await db.pending();
  assert.deepEqual(files.slice(0, 2), legacy);
  assert.equal(files[2]!.maxTXID, "3");
  assert.equal(store.state.files.size, 3);
  assert.equal(JSON.parse(store.state.image!).base, "");
  await db.close();
  db = await open(store);
  const native = new NodeDatabase(":memory:"),
    gateway = new AotLtxGateway(new SqlAotLtxStore(native));
  const endpoint = "http://gateway/aot-ltx/pager";
  const fetcher: typeof fetch = (input, init) =>
    aotLtxResponse(gateway, new Request(String(input), init));
  let lost = true;
  try {
    await assert.rejects(
      uploadAotLtx(db, endpoint, async (...args) => {
        const response = await fetcher(...args);
        if (lost) {
          lost = false;
          throw Error("network ACK lost");
        }
        return response;
      }),
      /ACK lost/,
    );
    assert.equal((await db.pending()).length, 3);
    await db.close();
    db = await open(store);
    assert.equal((await uploadAotLtx(db, endpoint, fetcher)).uploaded, 3);
    assert.equal((await db.pending()).length, 0);
    assert.equal(store.state.files.size, 0);
    assert.equal((await gateway.catalog()).head, "3");
    assert.deepEqual(
      await new SqlAotLtxStore(native).image(),
      await db.exportSQLite(),
    );
    await db.close();
    db = await open(store);
    assert.equal((await db.inspect("all")).acked, "3");
  } finally {
    await db.close();
    native.close();
  }
});

test("active SQL transactions cannot checkpoint or prune files, and page stores are required on reopen", async () => {
  const store = new Store();
  let db = await open(store);
  await db.execute("add", [1n, 100n, "t"]);
  await db.checkpoint();
  const file = (await db.pending())[0]!;
  await db.execute("begin");
  await db.execute("update", [101n, 1n]);
  await assert.rejects(db.checkpoint(), /transaction/);
  await assert.rejects(db.acknowledge("1", file.sha256), /transaction/);
  await db.execute("rollback");
  assert.equal((await db.inspect("all")).rows[0]![1], 100n);
  await db.close();
  const legacy: ImageStore = {
    read: () => store.read(),
    commit: (g, i) => store.commit(g, i),
    close() {},
  };
  await assert.rejects(
    AotDatabase.withStore(
      built.artifact,
      built.manifest.artifactSHA256,
      legacy,
    ),
    /atomic store/,
  );
  const empty: ImageStore = {
    async read() {
      return { generation: 0 };
    },
    async commit() {
      return 1;
    },
    close() {},
  };
  await assert.rejects(
    AotDatabase.withStore(
      built.artifact,
      built.manifest.artifactSHA256,
      empty,
      { sqlitePages: true },
    ),
    /atomic logical\/page store/,
  );
});

test("aborted and lost pruning ACKs recover the same pending prefix and reject corrupt cursors", async () => {
  const store = new Store();
  let db = await open(store);
  await db.execute("add", [1n, 100n, "p"]);
  await db.checkpoint();
  await db.execute("update", [101n, 1n]);
  await db.checkpoint();
  const [first, second] = await db.pending();
  const before = structuredClone(store.state);
  await assert.rejects(db.acknowledge("1", "0".repeat(64)), /hash/);
  assert.deepEqual(store.state, before);
  store.fault = "before";
  await assert.rejects(db.acknowledge("1", first!.sha256), /aborted/);
  assert.deepEqual(store.state, before);
  await db.close();
  db = await open(store);
  store.fault = "after";
  await assert.rejects(db.acknowledge("1", first!.sha256), /ACK lost/);
  await db.close();
  db = await open(store);
  assert.deepEqual(
    (await db.pending()).map((f) => f.maxTXID),
    ["2"],
  );
  assert.equal(store.state.files.size, 1);
  assert.equal((await db.inspect("all")).acked, "1");
  await db.acknowledge("2", second!.sha256);
  await db.close();
  assert.equal(store.state.files.size, 0);
  const current = JSON.parse(store.state.head!.metadata!);
  store.state.head!.metadata = JSON.stringify({ ...current, txid: "9" });
  await assert.rejects(open(store), /checkpoint mismatch/);
});

test("a full outbox defers checkpoints without losing logical writes, then resumes after verified ACK", async () => {
  const store = new Store();
  const openLimited = () =>
    AotDatabase.withStore(
      built.artifact,
      built.manifest.artifactSHA256,
      store,
      { sqlitePages: true, outboxLimit: 2 },
    );
  let db = await openLimited();
  for (let i = 1; i <= 2; i++) {
    await db.execute("add", [BigInt(i), 100n, "offline"]);
    assert.equal((await db.checkpoint()).created, true);
  }
  const original = await db.pending();
  assert.deepEqual(await db.checkpoint(), { created: false, head: "2" });
  for (let i = 3; i <= 20; i++)
    await db.execute("add", [BigInt(i), 100n, "offline"]);
  const before = structuredClone(store.state);
  const deferred = {
    created: false,
    head: "2",
    deferred: { reason: "outbox-full", pending: 2, limit: 2 },
  };
  assert.deepEqual(await db.checkpoint(), deferred);
  assert.deepEqual(await db.checkpoint(), deferred);
  assert.deepEqual(
    store.state,
    before,
    "deferral must not publish or advance either cursor",
  );
  assert.equal((await db.inspect("all")).rows.length, 20);
  assert.deepEqual(await db.pending(), original);
  await db.close();
  db = await openLimited();
  assert.equal((await db.inspect("all")).rows.length, 20);
  assert.deepEqual(await db.checkpoint(), deferred);
  await assert.rejects(db.acknowledge("1", "00".repeat(32)), /hash mismatch/);
  assert.deepEqual(await db.checkpoint(), deferred);
  await db.acknowledge("1", original[0]!.sha256);
  const resumed = await db.checkpoint();
  assert.equal(resumed.created, true);
  assert.equal(resumed.head, "3");
  assert.equal(resumed.deferred, undefined);
  const remaining = await db.pending();
  assert.deepEqual(
    remaining.map((f) => f.maxTXID),
    ["2", "3"],
  );
  let image: Uint8Array = new Uint8Array(),
    head = "0";
  for (const file of [...original, remaining.at(-1)!]) {
    image = applyLtx(image, head, file.data, 3).data;
    head = file.maxTXID;
  }
  assert.deepEqual(image, await db.exportSQLite());
  await db.acknowledge("3", remaining.at(-1)!.sha256);
  assert.equal((await db.pending()).length, 0);
  assert.deepEqual(await db.checkpoint(), { created: false, head: "3" });
  await db.close();
});

test("outbox deferral keeps real failed and uncertain SQL publications fatal until reopen", async () => {
  for (const fault of ["before", "after"] as const) {
    const store = new Store(),
      options = { sqlitePages: true, outboxLimit: 1 };
    let db = await AotDatabase.withStore(
      built.artifact,
      built.manifest.artifactSHA256,
      store,
      options,
    );
    await db.execute("add", [1n, 100n, "one"]);
    await db.checkpoint();
    await db.execute("update", [101n, 1n]);
    store.fault = fault;
    assert.equal((await db.checkpoint()).deferred?.reason, "outbox-full");
    assert.equal(
      store.fault,
      fault,
      "deferral must not attempt storage writes",
    );
    await assert.rejects(db.execute("update", [102n, 1n]), /publication/);
    await assert.rejects(db.inspect("all"), /reload/);
    await db.close();
    db = await AotDatabase.withStore(
      built.artifact,
      built.manifest.artifactSHA256,
      store,
      options,
    );
    assert.equal(
      (await db.inspect("all")).rows[0]![1],
      fault === "after" ? 102n : 101n,
    );
    assert.equal((await db.checkpoint()).deferred?.reason, "outbox-full");
    await db.close();
  }
});

test("outbox policy is validated and captured before asynchronous open", async () => {
  for (const limit of [0, -1, 129, 1.1, NaN, Infinity, null]) {
    const store = new Store();
    let closed = false;
    store.close = () => {
      closed = true;
    };
    await assert.rejects(
      AotDatabase.withStore(
        built.artifact,
        built.manifest.artifactSHA256,
        store,
        { outboxLimit: limit as number },
      ),
      /outbox limit/i,
    );
    assert.equal(closed, true);
    assert.equal(store.state.generation, 0);
  }
  for (const entry of ["withStore", "open"]) {
    const store = new Store(),
      options = { sqlitePages: true, outboxLimit: 2 };
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const pending =
      entry === "withStore"
        ? AotDatabase.withStore(
            built.artifact,
            built.manifest.artifactSHA256,
            store,
            options,
          )
        : AotDatabase.open(
            "option-capture",
            built.artifact,
            built.manifest.artifactSHA256,
            async () => {
              await gate;
              return store;
            },
            options,
          );
    options.outboxLimit = 1;
    resume();
    const db = await pending;
    for (let i = 1; i <= 2; i++) {
      await db.execute("add", [BigInt(i), 100n, "value"]);
      assert.equal((await db.checkpoint()).created, true, entry);
    }
    await db.execute("update", [101n, 1n]);
    assert.equal((await db.checkpoint()).deferred?.limit, 2);
    const original = await db.pending();
    await db.acknowledge("1", original[0]!.sha256);
    const resumed = await db.checkpoint();
    assert.equal(resumed.created, true);
    assert.equal(resumed.head, "3");
    assert.equal(resumed.pages?.snapshot, false);
    let image: Uint8Array = new Uint8Array(),
      head = "0";
    for (const file of [...original, (await db.pending()).at(-1)!]) {
      image = applyLtx(image, head, file.data, 3).data;
      head = file.maxTXID;
    }
    assert.deepEqual(image, await db.exportSQLite());
    assert.equal((await db.inspect("all")).rows[0]![1], 101n);
    await db.close();
  }
});
