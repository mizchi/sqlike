import { test } from "node:test";
import assert from "node:assert/strict";
import * as raw from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import { createPageLtxEncoder } from "../src/ltx-pages-host.ts";
import { MemorySqlitePageStore } from "../adapters/sqlite-page-store.ts";
import { SqlitePagerClient } from "../src/sqlite-pager.ts";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import { aotBindings } from "../src/aot-values.ts";
import type { LtxPageCodec } from "../src/ltx-pages-host.ts";

for (const migrate of [false, true])
  test(`CRC host saves only changed BE64 records and migrates JSON (${migrate})`, async () => {
    const built = buildCatalog(
      {
        schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER,s TEXT)"],
        queries: [
          {
            name: "add",
            sql: "INSERT INTO t VALUES(?,100,'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')",
          },
          { name: "update", sql: "UPDATE t SET n=101 WHERE id=?" },
        ],
      },
      { pageSize: 512 },
    );
    const db = raw.aot_open(built.artifact, "");
    for (let i = 1; i <= 100; i++)
      assert.equal(
        JSON.parse(raw.aot_execute(db, "add", aotBindings([BigInt(i)]))).error,
        undefined,
      );
    const store = new MemorySqlitePageStore();
    let encoder = createPageLtxEncoder(
      raw as LtxPageCodec,
      migrate ? undefined : store,
    );
    const client = await SqlitePagerClient.open(
      raw,
      store,
      (p) => raw.aot_pager_prepare(db, p),
      { prepareCommit: (h, b) => encoder.prepareCommit(h, b) },
    );
    await client.flush();
    if (migrate) {
      assert.equal(
        JSON.parse((await store.head())!.metadata!).format,
        "ltx-page-state@1",
      );
      encoder = createPageLtxEncoder(raw as LtxPageCodec, store);
    }
    raw.aot_execute(db, "update", aotBindings([50n]));
    const next = await client.flush();
    const head = await store.head();
    assert.equal(JSON.parse(head!.metadata!).format, "ltx-page-state@2");
    assert.ok(head!.metadata!.length < 256);
    assert.equal(head!.checksumFormat, "crc64-be@1");
    assert.equal(next.commit!.checksums!.length, migrate ? head!.pageCount : 2);
    assert.equal(next.commit!.checksumSnapshot, migrate);
    if (migrate) {
      raw.aot_execute(db, "update", aotBindings([51n]));
      const delta = await client.flush();
      assert.equal(delta.commit!.checksums!.length, 2);
      assert.equal(delta.commit!.checksumSnapshot, false);
    }
  });
