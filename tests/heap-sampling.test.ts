import { test } from "node:test";
import assert from "node:assert/strict";
import { sampleHeapDuring } from "../scripts/heap-sampling.ts";
test("observed heap peaks keep backing storage separate and combine only simultaneous samples", async () => {
  let i = 0;
  const heaps = [
    { usedSize: 10, backingStorageSize: 100 },
    { usedSize: 90, backingStorageSize: 0 },
    { usedSize: 30, backingStorageSize: 5 },
  ];
  let finish: () => void = () => {};
  const measured = await sampleHeapDuring(
    () =>
      new Promise<string>((resolve) => {
        finish = () => resolve("ok");
      }),
    async () => {
      const value = heaps[Math.min(i++, 2)]!;
      if (i >= 3) finish();
      return value;
    },
    1,
  );
  assert.equal(measured.value, "ok");
  assert.ok(measured.samples.length >= 3);
  assert.deepEqual(measured.peak, {
    usedSize: 90,
    backingStorageSize: 100,
    combinedBytes: 110,
  });
});
test("heap sampling propagates workload rejection and stops reading", async () => {
  let reads = 0;
  await assert.rejects(
    sampleHeapDuring(
      async () => {
        throw Error("workload failed");
      },
      async () => {
        reads++;
        return { usedSize: 1, backingStorageSize: 0 };
      },
      1,
    ),
    /workload failed/,
  );
  const stopped = reads;
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(reads, stopped);
});
