import { test, expect } from "@playwright/test";
import {
  compatibilityCorpus,
  compatibilityProfile,
} from "../tests/compatibility/corpus.ts";
import {
  compatibilityError,
  differentialCase,
  type CompatibilityDriver,
} from "../tests/compatibility/contract.ts";
import { sqliteOracle } from "../tests/compatibility/oracle.ts";
import { decodeFrame } from "../src/protocol.ts";
import { decodeOperation } from "../src/safety.ts";
import type { Cell } from "../src/contract.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  defaultBrowserEngine,
  parseBrowserEngine,
} from "../src/browser-engine.ts";

const candidateEngines = process.env.COMPAT_ENGINE
  ? [parseBrowserEngine(process.env.COMPAT_ENGINE)]
  : [...new Set([defaultBrowserEngine, parseBrowserEngine("moonbit")])];
for (const candidateEngine of candidateEngines) {
  test(`${compatibilityProfile.id}/${candidateEngine}: browser DB matches the native oracle`, async ({
    page,
    browser,
    browserName,
  }, testInfo) => {
    test.setTimeout(120000);
    const room = `diff${crypto.randomUUID().replaceAll("-", "")}`;
    await page.goto(
      `/?backend=node&engine=${encodeURIComponent(candidateEngine)}&client=oracle&room=${room}`,
    );
    await page.waitForFunction(() => window.syncDemo?.ready);
    await page.evaluate(() => window.syncDemo.sync());
    const candidate: CompatibilityDriver = {
      async execute(statements) {
        try {
          const frame = await page.evaluate(async (statements) => {
            await window.syncDemo.batch(statements, "sql");
            return (await window.syncDemo.state()).pending.at(-1)!.frame;
          }, statements);
          return {
            ok: true,
            effects: decodeOperation(decodeFrame(Uint8Array.from(frame))).guard
              .proof,
          };
        } catch (error) {
          return { ok: false, error: compatibilityError(error) };
        }
      },
      async query(statement) {
        try {
          const rows = (await page.evaluate(
            async (statement) =>
              window.syncDemo.query(
                statement.sql,
                statement.params.map((cell) => {
                  switch (cell.t) {
                    case "null":
                      return null;
                    case "integer":
                      return BigInt(cell.v);
                    case "text":
                    case "real":
                      return cell.v;
                    case "blob":
                      return Uint8Array.from(cell.v);
                    default:
                      throw new Error("undefined bind");
                  }
                }),
              ),
            statement,
          )) as Record<string, Cell>[];
          return { ok: true, rows };
        } catch (error) {
          return { ok: false, error: compatibilityError(error) };
        }
      },
    };
    // Keep the same candidate DB so prior schema/data also exercise later plans.
    const oracle = sqliteOracle();
    let steps = 0;
    const cases = compatibilityCorpus();
    try {
      for (const test of cases)
        steps += await differentialCase(test, oracle, candidate);
    } finally {
      oracle.close();
    }
    expect(steps).toBeGreaterThanOrEqual(800);
    const report = {
      status: "passed",
      measuredAt: new Date().toISOString(),
      ...compatibilityProfile,
      candidateEngine,
      browserName,
      browserVersion: browser.version(),
      oracleVersion: process.versions.sqlite,
      cases: cases.length,
      seeds: 32,
      steps,
      corpusSHA256: createHash("sha256")
        .update(JSON.stringify(cases))
        .digest("hex"),
    };
    await mkdir("measurements", { recursive: true });
    await writeFile(
      `measurements/compatibility-${browserName}-${candidateEngine}.json`,
      JSON.stringify(report, null, 2) + "\n",
    );
    await testInfo.attach("compatibility-profile", {
      body: JSON.stringify(report, null, 2),
      contentType: "application/json",
    });
  });
}
