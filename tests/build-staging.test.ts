import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  rm,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withBuildStage } from "../scripts/build-staging.ts";
test("failed code generation cannot publish partial artifacts or replace a previous build", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sqlike-publication-")),
    out = join(dir, "runtime");
  try {
    await mkdir(out);
    await writeFile(join(out, "old"), "valid");
    await assert.rejects(
      withBuildStage(out, async (stage) => {
        await writeFile(join(stage, "runtime.js"), "partial");
        throw Error("wasm compiler failed");
      }),
      /wasm compiler/,
    );
    assert.equal(await readFile(join(out, "old"), "utf8"), "valid");
    assert.deepEqual(await readdir(dir), ["runtime"]);
    await withBuildStage(out, async (stage) => {
      await writeFile(join(stage, "new"), "verified");
    });
    assert.deepEqual(await readdir(out), ["new"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
