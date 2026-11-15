import { test } from "node:test";
import assert from "node:assert/strict";
import { JournalKv } from "../scripts/lsm-bench-workload.ts";
import type {
  ImageStore,
  PersistedImage,
} from "../src/persistence-contract.ts";

test("the whole-journal benchmark reference drains a replayed WAL into its checkpoint", async () => {
  let head: PersistedImage = { generation: 0 };
  const store: ImageStore = {
    read: async () => structuredClone(head),
    close: () => {},
    commit: async (g, image) => {
      assert.equal(g, head.generation);
      head = { generation: g + 1, image };
      return head.generation;
    },
    commitDelta: async (g, delta) => {
      assert.equal(g, head.generation);
      head = {
        ...head,
        generation: g + 1,
        deltas: [...(head.deltas ?? []), structuredClone(delta)],
      };
      return head.generation;
    },
  };
  const a = await JournalKv.open(store);
  await a.writeBatch([{ key: 1n, value: new Uint8Array([1]) }]);
  await a.writeBatch([
    { key: 2n, value: new Uint8Array() },
    { key: 1n, value: null },
  ]);
  a.close();
  assert.equal(head.deltas?.length, 1);
  const b = await JournalKv.open(store);
  assert.equal(await b.get(1n), undefined);
  assert.deepEqual(await b.get(2n), new Uint8Array());
  await b.flush();
  assert.equal(head.deltas?.length ?? 0, 0);
  b.close();
  const c = await JournalKv.open(store);
  assert.equal(await c.get(1n), undefined);
  assert.deepEqual(await c.get(2n), new Uint8Array());
  c.close();
});
