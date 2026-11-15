import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MoonDatabase } from "../adapters/moon-database.ts";
import type { Database } from "../src/contract.ts";
import { issueOf } from "../src/errors.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { LtxTransport, sha256, type ImageStore } from "../src/ltx-transport.ts";
import type { LtxCatalog } from "../src/ltx-contract.ts";

const fixture = (name: string) =>
  new Uint8Array(
    readFileSync(new URL(`./fixtures/ltx/${name}`, import.meta.url)),
  );
class MemoryImages implements ImageStore {
  files = new Map<string, Uint8Array>();
  async read(name: string) {
    const file = this.files.get(name);
    if (!file) throw new Error("missing image");
    return file.slice();
  }
  async write(name: string, data: Uint8Array) {
    this.files.set(name, data.slice());
  }
  async prune(keep?: string) {
    for (const key of this.files.keys())
      if (key !== keep) this.files.delete(key);
  }
}
async function setup(db: Database = new NodeDatabase(":memory:")) {
  const store = new MemoryImages();
  const files = [fixture("snapshot.ltx"), fixture("delta.ltx")];
  const entries = await Promise.all(
    files.map(async (bytes, i) => ({
      id: `0/${String(i + 1).padStart(16, "0")}-${String(i + 1).padStart(16, "0")}.ltx`,
      minTXID: String(i + 1),
      maxTXID: String(i + 1),
      size: bytes.length,
      sha256: await sha256(bytes),
    })),
  );
  let manifest: LtxCatalog = {
    format: 3,
    epoch: "00000000-0000-0000-0000-000000000001",
    minRevision: 1,
    targetTXID: "1",
    files: [entries[0]!],
  };
  let fault: "none" | "corrupt" | "truncate" = "none";
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/ltx")) return Response.json(manifest);
    const entry = entries.find((x) => url.endsWith(x.id))!;
    const bytes = files[entries.indexOf(entry)]!.slice();
    if (fault === "corrupt") bytes[120] = bytes[120]! ^ 1;
    return new Response(fault === "truncate" ? bytes.subarray(0, -1) : bytes);
  };
  const create = (inspectFailure = false) =>
    new LtxTransport(
      "/api/test",
      db,
      store,
      () => {
        if (inspectFailure)
          throw new Error("corrupt SQLite image: cell extent");
        return {
          revision: manifest.minRevision,
          tables: [],
          schema: [],
          schemaStamp: {
            epoch: "00000000-0000-0000-0000-000000000001",
            generation: 0,
            signature: "0".repeat(64),
          },
        };
      },
      fetcher,
    );
  return {
    db,
    store,
    create,
    close: () => {
      if (db instanceof NodeDatabase) db.close();
    },
    next: () => {
      manifest = {
        ...manifest,
        minRevision: 2,
        targetTXID: "2",
        files: entries,
      };
    },
    fault: (mode: typeof fault) => {
      fault = mode;
    },
    epoch: () => {
      manifest = { ...manifest, epoch: "00000000-0000-0000-0000-000000000002" };
    },
  };
}

test("immutable image and SQLite cursor commit together; failure and crash leave the prior image", async () => {
  const s = await setup();
  const transport = s.create();
  try {
    const first = await transport.prepareSnapshot();
    assert.equal(transport.cursor(), undefined);
    s.db.transaction(() => first.commit());
    await first.dispose();
    const previous = transport.cursor()!;
    assert.equal(previous.txid, "1");
    assert.equal(s.store.files.size, 1);
    s.next();
    const second = await transport.prepareSnapshot();
    assert.equal(s.store.files.size, 2);
    assert.throws(() =>
      s.db.transaction(() => {
        second.commit();
        s.db.run("INSERT INTO missing VALUES(1)");
      }),
    );
    await second.dispose();
    assert.deepEqual(transport.cursor(), previous);
    assert.equal(s.store.files.size, 1);
    // A killed worker may leave a flushed candidate without a committed cursor.
    await transport.prepareSnapshot();
    assert.equal(s.store.files.size, 2);
    await s.create().recover();
    assert.equal(s.store.files.size, 1);
    assert.deepEqual(
      await s.store.read(previous.image),
      fixture("base.sqlite"),
    );
    const retry = await transport.prepareSnapshot();
    s.db.transaction(() => retry.commit());
    await retry.dispose();
    assert.equal(transport.cursor()?.txid, "2");
    assert.equal(s.store.files.size, 1);
    assert.deepEqual(
      await s.store.read(transport.cursor()!.image),
      fixture("grown.sqlite"),
    );
  } finally {
    s.close();
  }
});

test("corrupt/truncated transfer and epoch changes never advance the cursor", async () => {
  const s = await setup();
  const transport = s.create();
  try {
    const first = await transport.prepareSnapshot();
    s.db.transaction(() => first.commit());
    await first.dispose();
    const original = transport.cursor();
    s.next();
    s.fault("corrupt");
    await assert.rejects(transport.prepareSnapshot(), /SHA-256/);
    s.fault("truncate");
    await assert.rejects(transport.prepareSnapshot(), /truncated/);
    s.fault("none");
    s.epoch();
    await assert.rejects(transport.prepareSnapshot(), /identity changed/);
    assert.deepEqual(transport.cursor(), original);
    assert.equal(s.store.files.size, 1);
  } finally {
    s.close();
  }
});

test("explicit resnapshot repairs a missing image without publishing an incomplete cursor", async () => {
  const s = await setup();
  const transport = s.create();
  try {
    const first = await transport.prepareSnapshot();
    s.db.transaction(() => first.commit());
    await first.dispose();
    const original = transport.cursor()!;
    s.store.files.delete(original.image);
    await assert.rejects(transport.prepareSnapshot(), /missing/);
    const restored = await transport.prepareSnapshot({ reset: true });
    assert.deepEqual(transport.cursor(), original);
    s.db.transaction(() => restored.commit());
    await restored.dispose();
    assert.equal(transport.cursor()!.txid, original.txid);
    assert.notEqual(transport.cursor()!.image, original.image);
    assert.deepEqual(
      await s.store.read(transport.cursor()!.image),
      fixture("base.sqlite"),
    );
  } finally {
    s.close();
  }
});

test("MoonBit image/cursor/data/outbox publish atomically even when the durable commit ACK is lost", async () => {
  let image: string | undefined;
  let loseAck = false;
  const db = new MoonDatabase(undefined, (next) => {
    image = next;
    if (loseAck) throw new Error("durable commit ACK lost");
  });
  const s = await setup(db);
  const transport = s.create();
  db.run("CREATE TABLE data(id INTEGER PRIMARY KEY,v TEXT)");
  db.run("CREATE TABLE _bls_outbox(id INTEGER PRIMARY KEY,body TEXT)");
  db.run("INSERT INTO data VALUES(1,'old')");
  db.run("INSERT INTO _bls_outbox VALUES(1,'accepted')");
  const first = await transport.prepareSnapshot();
  db.transaction(() => first.commit());
  await first.dispose();
  const old = transport.cursor()!;
  s.next();
  const second = await transport.prepareSnapshot();
  assert.throws(
    () =>
      db.transaction(() => {
        second.commit();
        db.run("UPDATE data SET v='must rollback'");
        throw new Error("abort");
      }),
    /abort/,
  );
  assert.deepEqual(transport.cursor(), old);
  loseAck = true;
  assert.throws(
    () =>
      db.transaction(() => {
        second.commit();
        db.run("UPDATE data SET v='committed'");
        db.run("DELETE FROM _bls_outbox");
      }),
    /ACK lost/,
  );
  await second.dispose(); // A poisoned connection cannot prune an uncertain image.
  assert.equal(s.store.files.size, 2);
  const recovered = new MoonDatabase(image);
  const reopened = new LtxTransport("/api/test", recovered, s.store, () => {
    throw new Error("not used during recovery");
  });
  await reopened.recover();
  assert.equal(s.store.files.size, 1);
  assert.equal(reopened.cursor()!.txid, "2");
  assert.equal(recovered.all("SELECT v FROM data")[0]!.v, "committed");
  assert.equal(recovered.all("SELECT * FROM _bls_outbox").length, 0);
});

test("a structurally invalid restored SQLite image is an integrity error and cannot publish a cursor", async () => {
  const s = await setup(new MoonDatabase());
  const transport = s.create(true);
  try {
    await assert.rejects(
      transport.prepareSnapshot(),
      (error) =>
        issueOf(error).kind === "integrity" &&
        issueOf(error).retryable === false,
    );
    assert.equal(transport.cursor(), undefined);
    assert.equal(s.store.files.size, 0);
  } finally {
    s.close();
  }
});
