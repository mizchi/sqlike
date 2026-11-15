import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeDatabase } from "../adapters/node-database.ts";
import { packResult } from "../src/protocol.ts";
import { doConsumerCases } from "../tests/compatibility/do-consumer-cases.ts";
import { sourceHashes } from "../scripts/measurement-manifest.ts";
import type { Value } from "../src/contract.ts";

test("fixed consumer SQL preserves types and failed-write tables in real workerd DO", async () => {
  test.setTimeout(60000);
  const directory = mkdtempSync(join(tmpdir(), "do-consumer-"));
  const child: ChildProcess = spawn(
    "pnpm",
    [
      "exec",
      "wrangler",
      "dev",
      "--config",
      "scripts/fixtures/wrangler-do-consumer.jsonc",
      "--port",
      "19882",
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
  child.stdout!.on("data", (d) => (log += d));
  child.stderr!.on("data", (d) => (log += d));
  const root = "http://127.0.0.1:19882",
    reports = [];
  const packed = (rows: Record<string, Value>[]) =>
    rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key, packResult(value)]),
      ),
    );
  try {
    const deadline = Date.now() + 30000;
    while (true) {
      try {
        await fetch(`${root}/health`);
        break;
      } catch (e) {
        if (child.exitCode !== null || Date.now() > deadline)
          throw Error(`workerd startup failed: ${log}\n${e}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    for (const scenario of doConsumerCases) {
      const response = await fetch(
        `${root}/${scenario.id}?room=${crypto.randomUUID()}`,
      );
      expect(response.status, log).toBe(200);
      const observed = (await response.json()) as {
        sqlite: string;
        sqliteVersionError?: string;
        initialTotalChanges: string;
        results: {
          rows: unknown;
          error: string;
          notes: unknown;
          audit?: unknown;
        }[];
      };
      expect(observed.results).toHaveLength(scenario.steps.length);
      const db = new NodeDatabase(":memory:");
      try {
        for (const sql of scenario.schema) db.raw.exec(sql);
        for (const [i, step] of scenario.steps.entries()) {
          const actual = observed.results[i]!;
          if (step.reject)
            expect(actual.error, step.sql).toMatch(/unsupported DO/);
          else if (step.nativeError) {
            expect(() =>
              db.transaction(() => db.all(step.sql, step.params)),
            ).toThrow();
            expect(actual.error, step.sql).not.toBe("");
          } else {
            expect(actual.error, step.sql).toBe("");
            expect(actual.rows, step.sql).toEqual(
              packed(db.all(step.sql, step.params)),
            );
          }
          expect(actual.notes, step.sql).toEqual(
            packed(db.all("SELECT * FROM notes ORDER BY id")),
          );
          if (actual.audit)
            expect(actual.audit, step.sql).toEqual(
              packed(db.all("SELECT * FROM audit ORDER BY id")),
            );
        }
      } finally {
        db.close();
      }
      reports.push({
        id: scenario.id,
        steps: scenario.steps.length,
        sqlite: observed.sqlite,
        sqliteVersionError: observed.sqliteVersionError,
        initialTotalChanges: observed.initialTotalChanges,
        matches: scenario.steps.filter((s) => !s.reject && !s.nativeError)
          .length,
        explicitRejections: scenario.steps.filter((s) => s.reject).length,
        nativeErrors: scenario.steps.filter((s) => s.nativeError).length,
        verified: true,
      });
    }
    writeFileSync(
      "measurements/do-consumer-current.json",
      JSON.stringify(
        {
          measuredAt: new Date().toISOString(),
          sourceHashes: sourceHashes([
            "adapters/do-bindings.ts",
            "adapters/do-statement.ts",
            "adapters/do-returning.ts",
            "adapters/do-database.ts",
            "tests/compatibility/do-consumer-cases.ts",
            "e2e/do-consumer.spec.ts",
            "scripts/fixtures/do-consumer-worker.ts",
            "scripts/fixtures/wrangler-do-consumer.jsonc",
            "src/protocol.ts",
            "_build/js/release/build/mizchi/litestream/litestream.js",
          ]),
          node: process.version,
          nativeSQLite: process.versions.sqlite,
          method:
            "Sequential fixed consumer SQL in an isolated local workerd SQLite DO; native typed results and tables/audit after every operation; changes()/last_insert_rowid() and total_changes() delta from SQL-recorded bootstrap baseline checked at successful probes (DO internal initial writes differ). Trusted fixture bootstrap can create triggers outside DODatabase. Synthetic decoding failure checks rollback of table data, not restoration of connection counters.",
          cases: reports,
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
    await new Promise((resolve) => {
      if (child.exitCode !== null) resolve(undefined);
      else child.once("exit", resolve);
    });
    rmSync(directory, { recursive: true, force: true });
  }
});
