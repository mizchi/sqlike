import { test, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

test("parser-free browser saves offline and generates LTX accepted by real Litestream", async ({
  browser,
}) => {
  const context = await browser.newContext(),
    requests: string[] = [],
    workerBodies: Promise<string>[] = [];
  context.on("request", (request) => requests.push(request.url()));
  await context.route(/sqlite3|turso|compiler-|moon-database-/, (route) =>
    route.abort(),
  );
  const directory = mkdtempSync(join(tmpdir(), "browser-aot-ltx-"));
  try {
    const page = await context.newPage();
    page.on("response", (response) => {
      if (response.url().includes("aot-worker-"))
        workerBodies.push(response.text());
    });
    const client = `aot${crypto.randomUUID().replaceAll("-", "")}`;
    await page.goto(`/lite/?client=${client}`);
    await page.waitForFunction(() => window.liteDemo?.ready);
    await page.evaluate(() =>
      window.liteDemo.execute("add", [9007199254740993n, "最初のメモ", 1n]),
    );
    await page.evaluate(() => window.liteDemo.checkpoint());
    await context.setOffline(true);
    await page.reload();
    await page.waitForFunction(() => window.liteDemo?.ready);
    expect((await page.evaluate(() => window.liteDemo.state())).rows).toEqual([
      [9007199254740993n, "最初のメモ", 1n],
    ]);
    await page.evaluate(() =>
      window.liteDemo.execute("add", [2n, "長いメモ".repeat(2500), 2n]),
    );
    await page.evaluate(() => window.liteDemo.checkpoint());
    await page.reload();
    await page.waitForFunction(() => window.liteDemo?.ready);
    const state = await page.evaluate(() => window.liteDemo.state());
    expect(state.head).toBe("2");
    expect(state.pending.length).toBe(2);
    expect(state.rows.length).toBe(2);
    expect(
      await page.evaluate(async () => {
        try {
          await window.liteDemo.execute("SELECT 1");
          return false;
        } catch {
          return true;
        }
      }),
    ).toBe(true);
    const files = await page.evaluate(async () =>
      (await window.liteDemo.pending()).map((file) => ({
        ...file,
        data: Array.from(file.data),
      })),
    );
    const level = join(directory, "replica", "ltx", "0");
    mkdirSync(level, { recursive: true });
    for (const file of files) {
      const path = join(level, file.name);
      writeFileSync(path, Uint8Array.from(file.data));
      execFileSync("go", ["run", "-mod=mod", ".", "verify", path], {
        cwd: "scripts/ltx-reference",
        stdio: "pipe",
      });
    }
    const binary = process.env.LITESTREAM_BIN;
    expect(
      binary,
      "LITESTREAM_BIN is required; no native compatibility test is skipped",
    ).toBeTruthy();
    const output = join(directory, "restored.sqlite");
    execFileSync(
      binary!,
      ["restore", "-o", output, pathToFileURL(join(directory, "replica")).href],
      { stdio: "pipe" },
    );
    const native = new DatabaseSync(output, { readOnly: true });
    try {
      expect(
        native.prepare("PRAGMA integrity_check").all().map(Object.values),
      ).toEqual([["ok"]]);
      const statement = native.prepare(
        "SELECT id,title,score FROM notes ORDER BY id",
      );
      statement.setReadBigInts(true);
      expect(statement.all().map(Object.values)).toEqual(state.rows);
    } finally {
      native.close();
    }
    const last = files.at(-1)!;
    await page.evaluate(
      ({ head, hash }) => window.liteDemo.acknowledge(head, hash),
      { head: last.maxTXID, hash: last.sha256 },
    );
    await page.reload();
    await page.waitForFunction(() => window.liteDemo?.ready);
    expect(
      (await page.evaluate(() => window.liteDemo.state())).pending,
    ).toHaveLength(0);
    expect(
      requests.filter((url) =>
        /\.wasm(?:\?|$)|sqlite3|turso|compiler-|moon-database-/.test(url),
      ),
    ).toEqual([]);
    expect(workerBodies.length).toBeGreaterThan(0);
    for (const body of await Promise.all(workerBodies))
      expect(body).not.toMatch(
        /SQL syntax: expected|unterminated SQL quote|unterminated SQL comment/,
      );
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await context.close();
  }
});

test("real IndexedDB rejects a stale AOT writer and keeps the winning commit", async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    const a = await context.newPage(),
      b = await context.newPage(),
      client = `cas${crypto.randomUUID().replaceAll("-", "")}`;
    for (const page of [a, b]) {
      await page.goto(`/lite/?client=${client}`);
      await page.waitForFunction(() => window.liteDemo?.ready);
    }
    await a.evaluate(() => window.liteDemo.execute("add", [1n, "winner", 1n]));
    const error = await b.evaluate(async () => {
      try {
        await window.liteDemo.execute("add", [2n, "stale", 2n]);
        return "";
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(error).toMatch(/another connection|reload/);
    await b.reload();
    await b.waitForFunction(() => window.liteDemo?.ready);
    expect((await b.evaluate(() => window.liteDemo.state())).rows).toEqual([
      [1n, "winner", 1n],
    ]);
  } finally {
    await context.close();
  }
});
