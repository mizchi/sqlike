import { test, expect } from "@playwright/test";
import { build } from "vite";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import { applyLtx } from "../src/ltx.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type * as Runtime from "./fixtures/sqlite-pager-runtime.ts";

test("IDB upgrades the JSON CRC catalog, writes binary deltas and rejects corrupt CRC records before publication", async ({
  page,
}) => {
  const built = buildCatalog(
    {
      schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER,s TEXT)"],
      queries: [
        {
          name: "add",
          sql: "INSERT INTO t VALUES(?,100,'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')",
        },
        { name: "update", sql: "UPDATE t SET n=?2 WHERE id=?1" },
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
      lib: { entry: "e2e/fixtures/sqlite-pager-runtime.ts", formats: ["es"] },
      rolldownOptions: { output: { codeSplitting: false } },
    },
  });
  const chunks = (Array.isArray(outputs) ? outputs : [outputs]).flatMap((r) =>
    "output" in r ? r.output.filter((c) => c.type === "chunk") : [],
  );
  expect(chunks).toHaveLength(1);
  await page.route("**/crc-test.js", (r) =>
    r.fulfill({ contentType: "text/javascript", body: chunks[0]!.code }),
  );
  await page.route("**/crc-test", (r) =>
    r.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.goto("/crc-test");
  const observed = await page.evaluate(async (artifact) => {
    const path = "/crc-test.js";
    const {
      core,
      SqlitePagerClient,
      IndexedDbSqlitePageStore,
      createPageLtxEncoder,
      toBase64,
    } = (await import(path)) as typeof Runtime;
    const db = core.aot_open(artifact, "");
    const execute = (name: string, values: number[]) => {
      const r = JSON.parse(
        core.aot_execute(
          db,
          name,
          JSON.stringify(values.map((n) => ({ t: "integer", v: String(n) }))),
        ),
      );
      if (r.error) throw Error(r.error);
    };
    for (let i = 1; i <= 100; i++) execute("add", [i]);
    const oldDb = await new Promise<IDBDatabase>((resolve, reject) => {
      const q = indexedDB.open("sqlike-pages-crc-upgrade", 2);
      q.onupgradeneeded = () => {
        for (const name of ["head", "pages", "files"])
          q.result.createObjectStore(name);
      };
      q.onerror = () => reject(q.error);
      q.onsuccess = () => resolve(q.result);
    });
    const oldStore = IndexedDbSqlitePageStore.attach(oldDb, {
      head: "head",
      pages: "pages",
      files: "files",
    });
    const oldEncoder = createPageLtxEncoder(core, oldStore);
    const old = await SqlitePagerClient.open(
      core,
      oldStore,
      (p) => core.aot_pager_prepare(db, p),
      { prepareCommit: oldEncoder.prepareCommit },
    );
    await old.flush();
    const legacy = JSON.parse((await oldStore.head())!.metadata!).format;
    old.close();
    oldDb.close();
    const store = await IndexedDbSqlitePageStore.open("crc-upgrade");
    const encoder = createPageLtxEncoder(core, store);
    const client = await SqlitePagerClient.open(
      core,
      store,
      (p) => core.aot_pager_prepare(db, p),
      { prepareCommit: encoder.prepareCommit },
    );
    const migrated = await client.flush();
    execute("update", [50, 101]);
    const delta = await client.flush();
    const before = await store.head();
    const native = await new Promise<IDBDatabase>((resolve, reject) => {
      const q = indexedDB.open("sqlike-pages-crc-upgrade");
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
    });
    const version = native.version;
    await new Promise<void>((resolve, reject) => {
      const tx = native.transaction("checksums", "readwrite");
      const table = tx.objectStore("checksums"),
        q = table.get(1);
      q.onsuccess = () => {
        const record = q.result;
        new Uint8Array(record.data)[0]! ^= 1;
        table.put(record, 1);
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    native.close();
    execute("update", [50, 102]);
    let error = "";
    try {
      await client.flush();
    } catch (e) {
      error = String(e);
    }
    const unchanged =
      JSON.stringify(before) === JSON.stringify(await store.head());
    client.close();
    const fresh = await IndexedDbSqlitePageStore.open("crc-upgrade"),
      freshEncoder = createPageLtxEncoder(core, fresh);
    const recovered = await SqlitePagerClient.open(
      core,
      fresh,
      (p) => core.aot_pager_prepare(db, p),
      { prepareCommit: freshEncoder.prepareCommit },
    );
    const repaired = await recovered.flush();
    const head = await fresh.head(),
      crc = await fresh.readChecksums!(head!.generation, [1]);
    const files = [];
    for (const name of head!.files ?? [])
      files.push({
        name,
        data: toBase64(await fresh.readFile(head!.generation, name)),
      });
    const expected = core.sqlite_data_base64(core.aot_export_sqlite(db));
    recovered.close();
    return {
      legacy,
      version,
      migrated: migrated.commit!.checksumSnapshot,
      format: head!.checksumFormat,
      header: head!.metadata!,
      deltaCrcs: delta.commit!.checksums!.length,
      error,
      unchanged,
      repaired: repaired.info.snapshot,
      crcBytes: crc.length,
      files,
      expected,
    };
  }, built.artifact);
  expect(observed).toMatchObject({
    legacy: "ltx-page-state@1",
    version: 3,
    migrated: true,
    format: "crc64-be@1",
    deltaCrcs: 2,
    unchanged: true,
    repaired: true,
    crcBytes: 8,
  });
  expect(JSON.parse(observed.header).format).toBe("ltx-page-state@2");
  expect(observed.header.length).toBeLessThan(256);
  expect(observed.error).toContain("CRC checksum mismatch");
  let image: Uint8Array = new Uint8Array(),
    head = "0";
  for (const file of observed.files) {
    image = applyLtx(image, head, Buffer.from(file.data, "base64"), 3).data;
    head = BigInt("0x" + file.name.slice(17, 33)).toString();
  }
  expect(Buffer.from(image)).toEqual(Buffer.from(observed.expected, "base64"));
  const dir = mkdtempSync(join(tmpdir(), "sqlike-crc-idb-"));
  try {
    const file = join(dir, "check.sqlite");
    writeFileSync(file, image);
    const db = new DatabaseSync(file);
    try {
      expect(db.prepare("PRAGMA integrity_check").get()!.integrity_check).toBe(
        "ok",
      );
      expect(db.prepare("SELECT sum(n) AS n FROM t").get()!.n).toBe(10002);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
