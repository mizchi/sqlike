import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("CI preserves a failing check's exit status while retaining its log", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  const explicitBash = /^defaults:\n  run:\n    shell: bash$/m.test(workflow);
  const pipelines = [...workflow.matchAll(/^\s+(just [^\n]+\| tee (generated\/ci\/[^\s]+))$/gm)];
  assert.equal(pipelines.length, 4);
  const directory = mkdtempSync(join(tmpdir(), "sqlike-ci-failure-"));
  try {
    mkdirSync(join(directory, "generated/ci"), { recursive: true });
    for (const [, command, log] of pipelines) {
      // GitHub's implicit shell uses bash -e; explicit bash also enables pipefail.
      const options = explicitBash ? ["-e", "-o", "pipefail"] : ["-e"];
      const result = spawnSync("bash", ["--noprofile", "--norc", ...options, "-c",
        `function just() { echo 'deliberate check failure' >&2; return 17; }\n${command}`,
      ], { cwd: directory, encoding: "utf8" });
      assert.equal(result.status, 17, `${command}: upstream failure was hidden`);
      assert.match(readFileSync(join(directory, log!), "utf8"), /deliberate check failure/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
