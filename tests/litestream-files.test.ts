import assert from "node:assert/strict";
import { mkdtemp, mkdir, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readReplicaLtx } from "../adapters/litestream-files.ts";

const name = "0000000000000001-0000000000000001.ltx";

test("replica file reader preserves bytes, rejects invalid IDs and propagates missing files", async () => {
  const root = await mkdtemp(join(tmpdir(), "replica-files-"));
  try {
    await mkdir(join(root, "ltx/0"), { recursive: true });
    const bytes = Buffer.from([0, 255, 1, 2]);
    await writeFile(join(root, "ltx/0", name), bytes);
    assert.deepEqual(await readReplicaLtx(root, `0/${name}`), bytes);
    for (const id of [
      name,
      `../${name}`,
      `0/../${name}`,
      `10/${name}`,
      `0/${name.toUpperCase()}`,
    ])
      await assert.rejects(readReplicaLtx(root, id), /invalid LTX file ID/);
    await assert.rejects(readReplicaLtx(root, `1/${name}`), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replica file reader distinguishes a directory from an oversized regular file", async () => {
  const root = await mkdtemp(join(tmpdir(), "replica-files-"));
  try {
    await mkdir(join(root, "ltx/0", name), { recursive: true });
    await assert.rejects(
      readReplicaLtx(root, `0/${name}`),
      /not a regular file/,
    );
    await rm(join(root, "ltx/0", name), { recursive: true });
    const file = await open(join(root, "ltx/0", name), "w");
    try {
      await file.truncate(64 * 1024 * 1024 + 1);
    } finally {
      await file.close();
    }
    await assert.rejects(readReplicaLtx(root, `0/${name}`), /exceeds 64 MiB/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
