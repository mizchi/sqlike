import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "../..");

function lint<T>(...args: string[]): T {
  assert.ok(
    existsSync(resolve(root, ".jev-lint.yaml")),
    "project lint config is required",
  );
  return JSON.parse(
    execFileSync(
      process.execPath,
      ["node_modules/jev-lint/dist/cli.js", ...args, "--json"],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
        // These checks must work without model access, including in pull requests.
        env: { ...process.env, TYPESAFE_API_KEY: "", TYPESAFEAI_API_KEY: "" },
      },
    ),
  ) as T;
}

test("project lint loads MoonBit, TypeScript and npm script rules without policy errors", () => {
  const report = lint<{
    rules: { languageDir: string; id: string; severity: string }[];
    errors: unknown[];
    warnings: unknown[];
  }>("rules");
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, []);
  // `rules` lists the entire installed catalog; scope reports the active policy.
  const scope = lint<{ files: { rules: string[] }[]; status: string }>(
    "check",
    "src/aot-upload.ts",
    "packages/sqlike/src/full/aot_snapshot.mbt",
    "package.json",
    "--explain-scope",
  );
  assert.equal(scope.status, "complete");
  const selected = new Set(scope.files.flatMap((f) => f.rules));
  assert.ok(selected.size > 0);
  assert.ok(
    [...selected].every((id) => /^(typescript|moonbit|json)\//.test(id)),
  );
  for (const language of ["typescript", "moonbit", "json"])
    assert.ok(
      [...selected].some((id) => id.startsWith(`${language}/`)),
      language,
    );
  for (const id of selected) {
    const rule = report.rules.find((r) => `${r.languageDir}/${r.id}` === id);
    assert.ok(rule, id);
    assert.notEqual(rule.severity, "error", id);
  }
});

test("lint selects canonical implementations and tests while excluding generated engines and fixtures", () => {
  const paths = [
    "adapters/aot-database.ts",
    "src/aot-upload.ts",
    "tests/aot-upload.test.ts",
    "packages/sqlike/src/full/aot_snapshot.mbt",
    "packages/litestream/src/ltx_writer.mbt",
    "packages/sqlike/src/engine.mbt",
    "packages/sqlike/src/aot/engine.mbt",
    "src/sqlike-build-graph.generated.ts",
    "e2e/fixtures/aot-pager-checkpoint.ts",
  ];
  const report = lint<{ files: { path: string; reason: string }[] }>(
    "check",
    "--explain-scope",
  );
  for (const [index, path] of paths.entries())
    assert.equal(
      report.files.find((f) => f.path === path)?.reason,
      index < 5 ? "eligible" : "user-exclude",
      path,
    );
});

test("offline lint planning actually matches MoonBit functions, catches, TypeScript tests and script names", () => {
  const report = lint<{
    dryRun: boolean;
    requests: number;
    subjectList: { file: string; rule: string }[];
    undeclared: unknown[];
  }>(
    "check",
    "packages/sqlike/src/full/aot_snapshot.mbt",
    "adapters/aot-database.ts",
    "tests/aot-upload.test.ts",
    "package.json",
    "--dry-run",
    "--show-subjects",
    "--cache",
    "none",
  );
  assert.equal(report.dryRun, true);
  assert.ok(report.requests > 0);
  assert.deepEqual(report.undeclared, []);
  for (const [file, rule] of [
    ["packages/sqlike/src/full/aot_snapshot.mbt", "fn-name-promises"],
    ["packages/sqlike/src/full/aot_snapshot.mbt", "catch-hides-failure"],
    ["adapters/aot-database.ts", "catch-hides-failure"],
    ["tests/aot-upload.test.ts", "test-name-verifies-claim"],
    ["package.json", "script-name-does"],
  ])
    assert.ok(
      report.subjectList.some((s) => s.file === file && s.rule === rule),
      `${file}: ${rule}`,
    );
});
