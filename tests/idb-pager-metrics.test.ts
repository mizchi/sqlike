import { test } from "node:test";
import assert from "node:assert/strict";
import {
  idbValueBytes,
  summarizeIdbRequests,
} from "../scripts/idb-pager-metrics.ts";

test("IDB estimates count UTF8 metadata and only the bytes of submitted buffer views", () => {
  const backing = new Uint8Array(1024);
  const value = {
    label: "日本語",
    data: backing.subarray(10, 14),
    other: [new ArrayBuffer(3), null],
  };
  const result = idbValueBytes(value);
  assert.equal(result.binary, 7);
  assert.equal(
    result.metadata,
    new TextEncoder().encode(
      JSON.stringify({ label: "日本語", data: null, other: [null, null] }),
    ).byteLength,
  );
  assert.equal(result.total, result.binary + result.metadata);
  assert.equal(
    idbValueBytes('"日本語"').metadata,
    new TextEncoder().encode(JSON.stringify('"日本語"')).byteLength,
  );
  assert.equal(idbValueBytes(undefined).total, 0);
});

test("IDB totals keep keys, write/read payloads and deletion request counts separate", () => {
  const writes = [
    {
      operation: "put" as const,
      store: "sqlite-pages",
      key: 2,
      value: { data: new ArrayBuffer(4096), sha256: "a".repeat(64) },
    },
    {
      operation: "put" as const,
      store: "sqlite-head",
      key: 0,
      value: { metadata: "checksum catalog" },
    },
    { operation: "delete" as const, store: "delta", key: 4 },
    { operation: "clear" as const, store: "delta" },
    {
      operation: "get" as const,
      store: "image",
      key: "root",
      value: { generation: 4 },
    },
  ];
  const result = summarizeIdbRequests(writes);
  assert.equal(result.writes.binary, 4096);
  assert.equal(
    result.writes.total,
    result.writes.binary + result.writes.metadata + result.writes.keys,
  );
  assert.equal(result.reads.binary, 0);
  assert.equal(result.byStore["delta"]!.deletes, 1);
  assert.equal(result.byStore["delta"]!.clears, 1);
  assert.equal(result.byStore["sqlite-pages"]!.puts, 1);
  assert.equal(result.byStore["image"]!.gets, 1);
  assert.equal(
    result.writes.total,
    result.byStore["sqlite-pages"]!.writes.total +
      result.byStore["sqlite-head"]!.writes.total,
  );
});
