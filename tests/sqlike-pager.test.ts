import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import * as full from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import { sqlitePagerWasm } from "../src/sqlite-pager-wasm.ts";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import { aotBindings } from "../src/aot-values.ts";
import { SqlitePagerClient } from "../src/sqlite-pager.ts";
import { MemorySqlitePageStore } from "../adapters/sqlite-page-store.ts";
import type {
  SqliteAotPagerRuntime,
  SqlitePagerProgress,
} from "../src/sqlite-pager-contract.ts";

const checked = (text: string) => {
  const value = JSON.parse(text);
  if (value.error) throw Error(value.error);
  return value;
};
function native(image: Uint8Array, query = "SELECT count(*),sum(n) FROM t") {
  const directory = mkdtempSync(join(tmpdir(), "sqlike-pager-"));
  try {
    const path = join(directory, "db.sqlite");
    writeFileSync(path, image);
    const db = new DatabaseSync(path);
    try {
      assert.deepEqual(
        db.prepare("PRAGMA integrity_check").all().map(Object.values),
        [["ok"]],
      );
      const stmt = db.prepare(query);
      stmt.setReadBigInts(true);
      stmt.setReturnArrays(true);
      return stmt.all();
    } finally {
      db.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
async function runtimes() {
  const wasm = (
    await WebAssembly.instantiate(
      readFileSync(
        "_build/wasm-gc/release/build/mizchi/litestream-example/runtime/runtime.wasm",
      ),
      {},
      { builtins: ["js-string"], importedStringConstants: "_" },
    )
  ).instance.exports;
  return [
    full,
    { ...wasm, ...sqlitePagerWasm(wasm) },
  ] as unknown as (typeof full & SqliteAotPagerRuntime)[];
}
test("pager updates only affected SQLite pages, with bounded reads and no full image comparison", async () => {
  for (const runtime of await runtimes()) {
    const source = {
      schema: [
        "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER,s TEXT,b BLOB)",
        "CREATE INDEX ix_s ON t(s)",
      ],
      queries: [
        { name: "add", sql: "INSERT INTO t VALUES(?1,?2,?3,?4)" },
        { name: "update", sql: "UPDATE t SET n=?2 WHERE id=?1" },
        { name: "text", sql: "UPDATE t SET s=?2 WHERE id=?1" },
        { name: "blob", sql: "UPDATE t SET b=?2 WHERE id=?1" },
        { name: "delete", sql: "DELETE FROM t WHERE id=?1" },
      ],
    };
    const db = runtime.aot_open(
      buildCatalog(source, { pageSize: 512 }).artifact,
      "",
    );
    const exec = (name: string, args: any[]) =>
      checked(runtime.aot_execute(db, name, aotBindings(args)));
    for (let i = 1; i <= 1000; i++)
      exec("add", [BigInt(i), 10n, "v" + i, null]);
    const pager = runtime.sqlite_pager_open(),
      pages = new Map<number, Uint8Array>();
    function prepare() {
      const batch = runtime.aot_pager_prepare(db, pager);
      let info = checked(
        runtime.sqlite_pager_info(batch),
      ) as SqlitePagerProgress;
      for (let reads = 0; !info.ready; reads++) {
        assert.ok(reads < 1000);
        assert.ok(info.need !== undefined);
        info = checked(
          runtime.sqlite_pager_supply(batch, info.need, pages.get(info.need)!),
        ) as SqlitePagerProgress;
      }
      return { batch, info };
    }
    function publish({ batch, info }: ReturnType<typeof prepare>) {
      if (info.snapshot) pages.clear();
      info.pages.forEach((page, index) =>
        pages.set(page, runtime.sqlite_pager_page(batch, index).slice()),
      );
      checked(runtime.sqlite_pager_ack(pager, batch));
      const image = new Uint8Array(info.pageSize * info.pageCount);
      for (const [page, data] of pages)
        if (page <= info.pageCount) image.set(data, (page - 1) * info.pageSize);
      return image;
    }
    const initial = prepare();
    assert.equal(initial.info.snapshot, true);
    native(publish(initial));
    exec("update", [501n, 17n]);
    const delta = prepare();
    assert.equal(delta.info.snapshot, false);
    assert.deepEqual(delta.info.changedRows, 1);
    assert.equal(delta.info.pages.length, 2);
    assert.ok(delta.info.reads < 10);
    assert.deepEqual(native(publish(delta)), [[1000n, 10007n]]);
    exec("update", [501n, 17n]);
    const noop = prepare();
    assert.equal(noop.info.snapshot, false);
    assert.ok(noop.info.pages.length <= 1);
    publish(noop);
    exec("text", [501n, "changed-index"]);
    const indexed = prepare();
    assert.equal(indexed.info.snapshot, true);
    native(publish(indexed));
    exec("blob", [501n, new Uint8Array(12000).fill(7)]);
    const grow = prepare();
    assert.equal(grow.info.snapshot, true);
    native(publish(grow));
    const payload = new Uint8Array(12000).fill(7);
    payload[6000] = 9;
    exec("blob", [501n, payload]);
    const overflow = prepare();
    assert.equal(overflow.info.snapshot, false);
    assert.ok(overflow.info.pages.length <= 3);
    native(publish(overflow));
    exec("delete", [1000n]);
    const structural = prepare();
    assert.equal(structural.info.snapshot, true);
    assert.deepEqual(native(publish(structural)), [[999n, 9997n]]);
    exec("update", [1n, 19n]);
    const stale = prepare();
    exec("update", [2n, 20n]);
    assert.match(
      JSON.parse(runtime.sqlite_pager_ack(pager, stale.batch)).error,
      /stale/,
    );
    const retry = prepare();
    assert.equal(retry.info.snapshot, false);
    assert.deepEqual(native(publish(retry)), [[999n, 10016n]]);
  }
});

test("leaf repacking, rejected SQL, rollback and restore preserve the exported SQLite state", async () => {
  for (const runtime of await runtimes()) {
    const source = {
      schema: [
        "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER CHECK(n>=0),b BLOB)",
      ],
      queries: [
        { name: "add", sql: "INSERT INTO t VALUES(?1,100,NULL)" },
        { name: "update", sql: "UPDATE t SET n=?2,b=?3 WHERE id=?1" },
        { name: "begin", sql: "BEGIN" },
        { name: "rollback", sql: "ROLLBACK" },
      ],
    };
    const db = runtime.aot_open(
      buildCatalog(source, { pageSize: 512 }).artifact,
      "",
    );
    const exec = (q: string, args: any[] = []) =>
      checked(runtime.aot_execute(db, q, aotBindings(args)));
    const ids = [
      -9223372036854775808n,
      -9007199254740993n,
      -2n,
      -1n,
      0n,
      1n,
      2n,
      9007199254740993n,
      9223372036854775806n,
      9223372036854775807n,
    ];
    for (const id of ids) exec("add", [id]);
    const store = new MemorySqlitePageStore(),
      client = await SqlitePagerClient.open(runtime, store, (p) =>
        runtime.aot_pager_prepare(db, p),
      );
    await client.flush();
    const saved = runtime.aot_dump(db);
    const expected = ids.map((id) => [id, 100n, ""]);
    for (let i = 0; i < 20; i++) {
      const id = ids[i % 10]!,
        blob = new Uint8Array((i * 7) % 30).fill(i),
        n = 101 + i;
      exec("update", [BigInt(id), BigInt(n), blob]);
      const result = await client.flush();
      assert.equal(result.info.snapshot, false);
      assert.equal(result.commit!.pages.length, 2);
      expected[i % 10] = [
        BigInt(id),
        BigInt(n),
        Buffer.from(blob).toString("hex").toUpperCase(),
      ];
      const h = (await store.head())!,
        image = new Uint8Array(h.pageCount * h.pageSize);
      for (let p = 1; p <= h.pageCount; p++)
        image.set(await store.readPage(h.generation, p), (p - 1) * h.pageSize);
      assert.deepEqual(
        native(image, "SELECT id,n,hex(b) FROM t ORDER BY id"),
        expected,
      );
    }
    exec("begin");
    exec("update", [1n, 999n, new Uint8Array()]);
    await assert.rejects(client.flush(), /active SQL transaction/);
    exec("rollback");
    assert.throws(() => exec("update", [1n, -1n, new Uint8Array()]), /CHECK/);
    const after = await client.flush();
    assert.equal(after.info.changedRows, 0);
    assert.ok(after.info.pages.length <= 1);
    checked(runtime.aot_restore(db, saved));
    // Raw cursor fallback supports restore; the host rejects rewinding an existing durable source.
    const cursor = runtime.sqlite_pager_open();
    const restored = runtime.aot_pager_prepare(db, cursor);
    assert.equal(checked(runtime.sqlite_pager_info(restored)).snapshot, true);
    await assert.rejects(client.flush(), /persisted head/);
    client.close();
  }
});
