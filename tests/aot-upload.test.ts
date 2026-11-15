import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeDatabase } from "../adapters/node-database.ts";
import { AotDatabase, type AotImageStore } from "../adapters/aot-database.ts";
import { SqlAotLtxStore } from "../adapters/aot-ltx-store.ts";
import { AotLtxGateway, aotLtxResponse } from "../src/aot-ltx-gateway.ts";
import { uploadAotLtx } from "../src/aot-upload.ts";
import { ltxFilename, type AotLtxUpload } from "../src/aot-upload-contract.ts";
import { sha256, aotBindings } from "../src/aot-values.ts";
import * as runtime from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import { buildCatalog } from "../scripts/aot-compiler.ts";

const built = buildCatalog({
  schema: ["CREATE TABLE notes(id INTEGER PRIMARY KEY,title TEXT)"],
  queries: [
    { name: "add", sql: "INSERT INTO notes VALUES(?,?)" },
    { name: "list", sql: "SELECT id,title FROM notes ORDER BY id" },
  ],
});
class Store implements AotImageStore {
  generation = 0;
  image?: string;
  async read() {
    return { generation: this.generation, image: this.image };
  }
  async commit(expected: number, image: string) {
    assert.equal(expected, this.generation);
    this.image = image;
    return ++this.generation;
  }
  close() {}
}
const open = (store: Store) =>
  AotDatabase.withStore(built.artifact, built.manifest.artifactSHA256, store);
async function fixtures() {
  const db = runtime.aot_open(built.artifact, "");
  let base: Uint8Array = new Uint8Array();
  const files: { meta: AotLtxUpload; data: Uint8Array; image: Uint8Array }[] =
    [];
  for (let n = 1; n <= 3; n++) {
    assert.equal(
      JSON.parse(
        runtime.aot_execute(db, "add", aotBindings([BigInt(n), `note${n}`])),
      ).error,
      undefined,
    );
    const sql = runtime.aot_export_sqlite(db),
      image = runtime.sqlite_data(sql);
    const encoded = runtime.encode_ltx(base, image, String(n), String(n), "0"),
      data = runtime.ltx_data(encoded);
    files.push({
      image,
      data,
      meta: {
        format: "aot-ltx-upload@1",
        historyId: "a0f414d0-6826-4e50-8d41-ec595fe5ae30",
        artifactSHA256: built.manifest.artifactSHA256,
        baseTXID: String(n - 1),
        minTXID: String(n),
        maxTXID: String(n),
        sha256: await sha256(data),
        size: data.length,
      },
    });
    base = image;
  }
  return files;
}
const token = "f1".repeat(32);
function gateway() {
  const db = new NodeDatabase(":memory:"),
    store = new SqlAotLtxStore(db);
  return { db, store, gateway: new AotLtxGateway(store) };
}

test("gateway commits a single owner chain, preserves exact bytes and retries historical ACKs", async () => {
  const f = await fixtures(),
    g = gateway();
  try {
    const a = await g.gateway.accept(f[0]!.meta, token, f[0]!.data);
    await g.gateway.accept(f[1]!.meta, token, f[1]!.data);
    assert.deepEqual(await g.gateway.accept(f[0]!.meta, token, f[0]!.data), a);
    assert.equal((await g.gateway.catalog()).head, "2");
    assert.deepEqual(await g.gateway.file(ltxFilename("1", "1")), f[0]!.data);
    assert.deepEqual(await g.store.image(), f[1]!.image);
    assert.equal(a.imageSHA256, await sha256(f[0]!.image));
    const catalog = JSON.stringify(await g.gateway.catalog());
    assert.ok(!catalog.includes(token));
    assert.ok(!catalog.includes(await sha256(token)));
  } finally {
    g.db.close();
  }
});

test("wrong owner, program, base, gap, hash, fork and LTX header reject atomically", async () => {
  const f = await fixtures(),
    g = gateway();
  try {
    await g.gateway.accept(f[0]!.meta, token, f[0]!.data);
    const baseline = await g.gateway.catalog();
    const second = f[1]!;
    for (const [meta, secret, bytes] of [
      [second.meta, "e2".repeat(32), second.data],
      [{ ...second.meta, historyId: crypto.randomUUID() }, token, second.data],
      [{ ...second.meta, artifactSHA256: "00".repeat(32) }, token, second.data],
      [{ ...second.meta, baseTXID: "0" }, token, second.data],
      [f[2]!.meta, token, f[2]!.data],
      [second.meta, token, second.data.slice(0, -1)],
      [{ ...second.meta, sha256: "00".repeat(32) }, token, second.data],
      [
        { ...f[0]!.meta, sha256: second.meta.sha256, size: second.data.length },
        token,
        second.data,
      ],
      [
        { ...second.meta, sha256: f[0]!.meta.sha256, size: f[0]!.data.length },
        token,
        f[0]!.data,
      ],
      [{ ...second.meta, minTXID: "02" }, token, second.data],
    ] as const) {
      await assert.rejects(g.gateway.accept(meta, secret, bytes));
      assert.deepEqual(await g.gateway.catalog(), baseline);
      assert.deepEqual(await g.store.image(), f[0]!.image);
    }
  } finally {
    g.db.close();
  }
});

test("SQL store rollback leaves no chunks/receipt and reopening recovers accepted history", async () => {
  const root = mkdtempSync(join(tmpdir(), "aot-gateway-")),
    f = await fixtures();
  let db = new NodeDatabase(join(root, "gateway.sqlite"));
  try {
    let g = new AotLtxGateway(new SqlAotLtxStore(db));
    await g.accept(f[0]!.meta, token, f[0]!.data);
    db.run(
      "CREATE TRIGGER fail_receipt BEFORE INSERT ON aot_ltx_receipts BEGIN SELECT RAISE(ABORT,'disk fault'); END",
    );
    await assert.rejects(g.accept(f[1]!.meta, token, f[1]!.data), /disk fault/);
    assert.equal((await g.catalog()).head, "1");
    assert.equal(
      db.all("SELECT count(*) AS n FROM aot_ltx_chunks WHERE key=?", [
        ltxFilename("2", "2"),
      ])[0]!.n,
      0n,
    );
    db.run("DROP TRIGGER fail_receipt");
    const ack = await g.accept(f[1]!.meta, token, f[1]!.data);
    db.close();
    db = new NodeDatabase(join(root, "gateway.sqlite"));
    g = new AotLtxGateway(new SqlAotLtxStore(db));
    assert.deepEqual(await g.accept(f[1]!.meta, token, f[1]!.data), ack);
    await g.accept(f[2]!.meta, token, f[2]!.data);
    assert.deepEqual(await g.file(ltxFilename("3", "3")), f[2]!.data);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP upload bounds the body, verifies filename and uses an identical receipt after ACK loss", async () => {
  const f = await fixtures(),
    g = gateway();
  const request = (
    meta: AotLtxUpload,
    data: Uint8Array,
    name = ltxFilename(meta.minTXID, meta.maxTXID),
  ) =>
    new Request(`http://gateway/aot-ltx/room/${name}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        Authorization: `Bearer ${token}`,
        "X-Aot-Ltx": JSON.stringify(meta),
      },
      body: Uint8Array.from(data),
    });
  try {
    assert.equal(
      (
        await aotLtxResponse(
          g.gateway,
          request(f[0]!.meta, f[0]!.data, ltxFilename("2", "2")),
        )
      ).status,
      400,
    );
    const first = await aotLtxResponse(
      g.gateway,
      request(f[0]!.meta, f[0]!.data),
    );
    assert.equal(first.status, 200);
    assert.deepEqual(
      await (
        await aotLtxResponse(g.gateway, request(f[0]!.meta, f[0]!.data))
      ).json(),
      await first.json(),
    );
    assert.equal(
      (
        await aotLtxResponse(
          g.gateway,
          request({ ...f[1]!.meta, size: 64 * 1024 * 1024 + 1 }, f[1]!.data),
        )
      ).status,
      413,
    );
    assert.equal((await g.gateway.catalog()).head, "1");
  } finally {
    g.db.close();
  }
});

test("publisher durably binds the endpoint and keeps pending bytes after lost/malformed ACK", async () => {
  const local = new Store(),
    g = gateway();
  let db = await open(local);
  const endpoint = "http://gateway/aot-ltx/room";
  const fetcher: typeof fetch = async (input, init) =>
    aotLtxResponse(g.gateway, new Request(String(input), init));
  try {
    await db.execute("add", [1n, "offline"]);
    await db.checkpoint();
    await db.execute("add", [2n, "offline2"]);
    await db.checkpoint();
    const bytes = await db.pending();
    let calls = 0;
    await assert.rejects(
      uploadAotLtx(db, endpoint, async (...args) => {
        const response = await fetcher(...args);
        if (++calls === 1) throw Error("ACK lost");
        return response;
      }),
      /ACK lost/,
    );
    assert.equal((await db.pending()).length, 2);
    await db.close();
    db = await open(local);
    await assert.rejects(
      uploadAotLtx(db, "http://other/aot-ltx/room", fetcher),
      /endpoint/,
    );
    await assert.rejects(
      uploadAotLtx(db, endpoint, async (...args) => {
        const response = await fetcher(...args),
          ack = await response.json();
        return Response.json({ ...ack, sha256: "00".repeat(32) });
      }),
      /acknowledgement/,
    );
    await assert.rejects(
      uploadAotLtx(db, endpoint, async () => new Response(" ".repeat(4097))),
      /response exceeds/,
    );
    assert.deepEqual(await db.pending(), bytes);
    const result = await uploadAotLtx(db, endpoint, fetcher);
    assert.equal(result.uploaded, 2);
    assert.equal((await db.pending()).length, 0);
    assert.equal((await g.gateway.catalog()).head, "2");
    await db.close();
    db = await open(local);
    assert.equal((await db.inspect("list")).acked, "2");
    assert.equal((await uploadAotLtx(db, endpoint, fetcher)).uploaded, 0);
  } finally {
    await db.close();
    g.db.close();
  }
});

test("competing gateway instances atomically claim one owner and cannot overwrite a history", async () => {
  const f = await fixtures(),
    g = gateway(),
    other = new AotLtxGateway(new SqlAotLtxStore(g.db));
  try {
    const attempts = await Promise.allSettled([
      g.gateway.accept(f[0]!.meta, token, f[0]!.data),
      other.accept(
        { ...f[0]!.meta, historyId: crypto.randomUUID() },
        "a3".repeat(32),
        f[0]!.data,
      ),
    ]);
    assert.equal(attempts.filter((a) => a.status === "fulfilled").length, 1);
    assert.equal((await g.gateway.catalog()).files.length, 1);
    assert.deepEqual(await g.store.image(), f[0]!.image);
  } finally {
    g.db.close();
  }
});

test("correct transport hash cannot hide a bad LTX checksum or a different SQLite base", async () => {
  const f = await fixtures(),
    g = gateway();
  try {
    await g.gateway.accept(f[0]!.meta, token, f[0]!.data);
    const invalid = Uint8Array.from(f[1]!.data);
    invalid[invalid.length - 1]! ^= 1;
    const wrongBase = runtime.encode_ltx(
      f[1]!.image,
      f[2]!.image,
      "2",
      "2",
      "0",
    );
    for (const data of [invalid, runtime.ltx_data(wrongBase)]) {
      await assert.rejects(
        g.gateway.accept(
          { ...f[1]!.meta, size: data.length, sha256: await sha256(data) },
          token,
          data,
        ),
        /invalid LTX chain/,
      );
      assert.equal((await g.gateway.catalog()).head, "1");
    }
    g.db.run("UPDATE aot_ltx_chunks SET data=? WHERE key='image' AND pos=0", [
      new Uint8Array([1, 2, 3]),
    ]);
    await assert.rejects(
      g.gateway.accept(f[1]!.meta, token, f[1]!.data),
      /base hash mismatch/,
    );
    g.db.run("DELETE FROM aot_ltx_chunks WHERE key=?", [ltxFilename("1", "1")]);
    await assert.rejects(
      g.gateway.accept(f[0]!.meta, token, f[0]!.data),
      /missing or corrupt/,
    );
  } finally {
    g.db.close();
  }
});

test("retry after uncertain durability confirms the same receipt before returning ACK", async () => {
  const f = await fixtures(),
    db = new NodeDatabase(":memory:");
  let confirms = 0;
  const g = new AotLtxGateway(
    new SqlAotLtxStore(db, async () => {
      if (++confirms === 1) throw Error("durability outcome unknown");
    }),
  );
  try {
    await assert.rejects(g.accept(f[0]!.meta, token, f[0]!.data), /unknown/);
    assert.equal((await g.catalog()).head, "1");
    const ack = await g.accept(f[0]!.meta, token, f[0]!.data);
    assert.equal(confirms, 2);
    assert.equal(ack.sha256, f[0]!.meta.sha256);
    assert.equal((await g.catalog()).files.length, 1);
  } finally {
    db.close();
  }
});

test("local binding must commit before sending and a manually acknowledged legacy history cannot rebind", async () => {
  class FaultStore extends Store {
    fail = false;
    override async commit(expected: number, image: string) {
      if (this.fail) throw Error("binding commit aborted");
      return super.commit(expected, image);
    }
  }
  const store = new FaultStore();
  let db = await open(store),
    sent = 0;
  const endpoint = "http://gateway/aot-ltx/room";
  try {
    await db.checkpoint();
    store.fail = true;
    await assert.rejects(
      uploadAotLtx(db, endpoint, async () => {
        sent++;
        return Response.json({});
      }),
      /aborted/,
    );
    assert.equal(sent, 0);
    await db.close();
    store.fail = false;
    db = await open(store);
    assert.equal((await db.pending()).length, 1);
    const file = (await db.pending())[0]!;
    await db.acknowledge(file.maxTXID, file.sha256);
    await assert.rejects(db.bindUpload(endpoint), /already acknowledged/);
  } finally {
    await db.close();
  }
});
