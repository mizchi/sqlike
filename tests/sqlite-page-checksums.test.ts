import { test } from "node:test";
import assert from "node:assert/strict";
import { MemorySqlitePageStore } from "../adapters/sqlite-page-store.ts";
import type { SqlitePageCommit } from "../src/sqlite-pager-contract.ts";
const page = (n: number) => ({ page: n, data: new Uint8Array(512).fill(n) });
const crc = (n: number) => ({ page: n, data: new Uint8Array(8).fill(n) });
const initial = {
  programId: "crc-test",
  pageSize: 512,
  pageCount: 2,
  serial: 1,
  snapshot: true,
  pages: [page(1), page(2)],
  metadata: "opaque CRC header",
  checksumFormat: "crc64-be@1",
  checksumSnapshot: true,
  checksums: [crc(1), crc(2)],
} as const;

test("page CRCs are owned binary records and publish with pages through one generation", async () => {
  const store = new MemorySqlitePageStore();
  const value = structuredClone(initial),
    pending = store.commit(0, value);
  value.checksums[0].data.fill(99);
  await pending;
  assert.equal((await store.head())!.checksumFormat, "crc64-be@1");
  assert.deepEqual(
    await store.readChecksums!(1, [1, 2]),
    Uint8Array.from([
      ...new Uint8Array(8).fill(1),
      ...new Uint8Array(8).fill(2),
    ]),
  );
  const output = await store.readChecksums!(1, [1]);
  output.fill(0);
  assert.equal((await store.readChecksums!(1, [1]))[0], 1);
  await store.commit(1, {
    ...initial,
    snapshot: false,
    checksumSnapshot: false,
    serial: 2,
    pages: [page(1)],
    checksums: [crc(3)].map((c) => ({ ...c, page: 1 })),
  });
  assert.equal((await store.readChecksums!(2, [1, 2]))[0], 3);
  assert.equal((await store.readChecksums!(2, [1, 2]))[8], 2);
  await assert.rejects(store.readChecksums!(1, [1]), /stale/);
  await store.commit(2, {
    ...initial,
    snapshot: false,
    checksumSnapshot: false,
    pageCount: 1,
    serial: 3,
    pages: [page(1)],
    checksums: [crc(1)],
  });
  await assert.rejects(store.readChecksums!(3, [2]), /checksum|range|page/);
});

test("incomplete, mismatched and stale CRC publications cannot change the committed head", async () => {
  const store = new MemorySqlitePageStore();
  await store.commit(0, initial);
  const before = await store.head();
  for (const value of [
    {
      ...initial,
      snapshot: false,
      checksumSnapshot: false,
      pages: [page(1)],
      checksums: undefined,
    },
    { ...initial, checksums: [crc(1)] },
    { ...initial, checksums: [crc(2), crc(1)] },
    { ...initial, checksums: [{ page: 1, data: new Uint8Array(7) }, crc(2)] },
    {
      ...initial,
      snapshot: false,
      checksumSnapshot: false,
      pages: [page(1)],
      checksums: [crc(2)],
    },
  ] as unknown as SqlitePageCommit[]) {
    await assert.rejects(store.commit(1, value), /checksum|CRC/);
    assert.deepEqual(await store.head(), before);
  }
  await assert.rejects(store.commit(0, initial), /stale/);
});
