import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceHashes } from "../scripts/measurement-manifest.ts";
test("Drizzle CRUD, nested rollback and migration safety run in real SQLite DO", async () => {
  test.setTimeout(60000);
  const directory = mkdtempSync(join(tmpdir(), "drizzle-do-"));
  const child = spawn(
    "pnpm",
    [
      "exec",
      "wrangler",
      "dev",
      "--config",
      "scripts/fixtures/wrangler-drizzle.jsonc",
      "--port",
      "19883",
      "--inspector-port",
      "0",
      "--persist-to",
      directory,
    ],
    {
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const root = "http://127.0.0.1:19883";
  try {
    const deadline = Date.now() + 30000;
    // Wrangler's ready log avoids consuming the one-shot migration fixture.
    while (!log.includes("Ready on")) {
      if (child.exitCode !== null || Date.now() > deadline) throw Error(log);
      await new Promise((r) => setTimeout(r, 100));
    }
    const response = await fetch(`${root}/?room=${crypto.randomUUID()}`);
    expect(
      response.status,
      response.status === 200
        ? log
        : (await response.clone().text()).slice(-4000) + log,
    ).toBe(200);
    const result = (await response.json()) as any;
    expect(result.inserted).toEqual({
      id: 2,
      name: "one",
      email: "one@example.test",
    });
    expect(result.updated).toEqual({ id: 2, upper: "UPDATED" });
    expect(result.rows).toEqual([
      { id: 1, name: "seed", email: "seed@example.test" },
      { id: 2, name: "updated", email: "one@example.test" },
    ]);
    expect(result.rerun).toEqual({ applied: 0 });
    expect(result.children).toEqual([["7", "1", "kept child"]]);
    expect(result.fk).toEqual([]);
    expect(result.mode).toEqual([["1"]]);
    expect(result.log).toEqual([["8"]]);
    expect(result.audit).toEqual([["2", "insert"]]);
    expect(result.failedError).toMatch(/FOREIGN KEY/);
    expect(result.unsafeError).toMatch(/exclusive migration scope/);
    expect(result.rollbackSchema).toEqual([]);
    writeFileSync(
      "measurements/drizzle-do-current.json",
      JSON.stringify(
        {
          measuredAt: new Date().toISOString(),
          sourceHashes: sourceHashes([
            "package.json",
            "pnpm-lock.yaml",
            "adapters/drizzle.ts",
            "adapters/drizzle-migrator.ts",
            "src/migration-statements.ts",
            "adapters/do-database.ts",
            "adapters/do-bindings.ts",
            "adapters/do-returning.ts",
            "adapters/do-statement.ts",
            "scripts/fixtures/drizzle-worker.ts",
            "scripts/fixtures/wrangler-drizzle.jsonc",
            "e2e/drizzle-do.spec.ts",
            "tests/fixtures/drizzle/migrations.generated.ts",
          ]),
          migrations: 8,
          kitGenerated: 6,
          custom: 2,
          foreignKeyChildrenPreserved: true,
          foreignKeysRestored: true,
          verified: true,
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    if (child.pid)
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
    if (child.exitCode === null)
      await new Promise((resolve) => child.once("exit", resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
