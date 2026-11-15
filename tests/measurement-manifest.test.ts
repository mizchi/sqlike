import { test } from "node:test";
import assert from "node:assert/strict";
import { assertFileHashes } from "../scripts/measurement-manifest.ts";
test("measurement completion rejects missing or stale source/artifact evidence", () => {
  const sha = "a".repeat(64);
  assert.doesNotThrow(() => assertFileHashes({ "runtime.js": sha }, () => sha));
  assert.throws(() => assertFileHashes({}), /missing/);
  assert.throws(
    () => assertFileHashes({ "runtime.js": sha }, () => "b".repeat(64)),
    /stale/,
  );
  assert.throws(
    () => assertFileHashes({ "runtime.js": "invalid" }, () => sha),
    /stale/,
  );
});
