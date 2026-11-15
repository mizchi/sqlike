import { test, expect } from "@playwright/test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

for (const prefix of ["/aot-ltx", "/do-aot-ltx"]) {
  test(`AOT offline LTX survives restart/ACK loss and restores from ${prefix}`, async ({
    browser,
    request,
  }) => {
    const context = await browser.newContext(),
      root = mkdtempSync(join(tmpdir(), "aot-upload-e2e-"));
    const client = `upload${crypto.randomUUID().replaceAll("-", "")}`,
      endpoint = `${prefix}/${client}`;
    try {
      await context.route(/sqlite3|turso|compiler-|moon-database-/, (route) =>
        route.abort(),
      );
      const page = await context.newPage();
      await page.goto(`/lite/?client=${client}`);
      await page.waitForFunction(() => window.liteDemo?.ready);
      await context.setOffline(true);
      await page.evaluate(() =>
        window.liteDemo.execute("add", [
          9007199254740993n,
          "offline first",
          1n,
        ]),
      );
      await page.evaluate(() => window.liteDemo.checkpoint());
      await page.evaluate(() =>
        window.liteDemo.execute("add", [2n, "payload".repeat(30000), 2n]),
      );
      await page.evaluate(() => window.liteDemo.checkpoint());
      await page.reload();
      await page.waitForFunction(() => window.liteDemo?.ready);
      expect(
        (await page.evaluate(() => window.liteDemo.state())).pending,
      ).toHaveLength(2);
      const original = await page.evaluate(async () =>
        (await window.liteDemo.pending()).map((f) => ({
          ...f,
          data: Array.from(f.data),
        })),
      );
      await context.setOffline(false);
      let lost = false;
      const pattern = `**${endpoint}/*.ltx`;
      await context.route(pattern, async (route) => {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        lost = true;
        await route.abort("failed");
      });
      await page.getByLabel("LTX 保存先").fill(endpoint);
      await page
        .getByRole("button", { name: "LTX を送信", exact: true })
        .click();
      await expect(page.locator("#error")).not.toBeEmpty();
      expect(lost).toBe(true);
      expect((await (await request.get(endpoint)).json()).head).toBe("1");
      expect((await page.evaluate(() => window.liteDemo.state())).acked).toBe(
        "0",
      );
      await context.unroute(pattern);
      await page.reload();
      await page.waitForFunction(() => window.liteDemo?.ready);
      await expect(page.getByLabel("LTX 保存先")).toHaveValue(
        `http://127.0.0.1:14173${endpoint}`,
      );
      await expect(page.getByLabel("LTX 保存先")).toHaveAttribute(
        "readonly",
        "",
      );
      expect(
        await page.evaluate(
          (endpoint) => window.liteDemo.sync(endpoint),
          endpoint,
        ),
      ).toEqual({ uploaded: 2 });
      const state = await page.evaluate(() => window.liteDemo.state());
      expect(state.acked).toBe("2");
      expect(state.pending).toHaveLength(0);
      await context.setOffline(true);
      await page.reload();
      await page.waitForFunction(() => window.liteDemo?.ready);
      expect((await page.evaluate(() => window.liteDemo.state())).acked).toBe(
        "2",
      );
      await context.setOffline(false);
      const catalogResponse = await request.get(endpoint),
        catalog = await catalogResponse.json();
      expect(catalogResponse.ok()).toBe(true);
      expect(catalog.files).toHaveLength(2);
      const level = join(root, "replica", "ltx", "0");
      mkdirSync(level, { recursive: true });
      for (const f of catalog.files) {
        const response = await request.get(`${endpoint}/${f.name}`),
          bytes = await response.body();
        expect(response.ok()).toBe(true);
        expect(Array.from(bytes)).toEqual(
          original.find((o) => o.name === f.name)!.data,
        );
        const path = join(level, f.name);
        writeFileSync(path, bytes);
        execFileSync("go", ["run", "-mod=mod", ".", "verify", path], {
          cwd: "scripts/ltx-reference",
          stdio: "pipe",
        });
      }
      expect(
        process.env.LITESTREAM_BIN,
        "native restore is mandatory",
      ).toBeTruthy();
      const output = join(root, "restored.sqlite");
      execFileSync(
        process.env.LITESTREAM_BIN!,
        ["restore", "-o", output, pathToFileURL(join(root, "replica")).href],
        { stdio: "pipe" },
      );
      expect(Array.from(readFileSync(output))).toEqual(
        await page.evaluate(async () =>
          Array.from(await window.liteDemo.exportSQLite()),
        ),
      );
      const native = new DatabaseSync(output, { readOnly: true });
      try {
        expect(
          native.prepare("PRAGMA integrity_check").get()!.integrity_check,
        ).toBe("ok");
        const q = native.prepare(
          "SELECT id,title,score FROM notes ORDER BY id",
        );
        q.setReadBigInts(true);
        expect(q.all().map(Object.values)).toEqual(state.rows);
      } finally {
        native.close();
      }
      // A separate local history cannot take over the already claimed room.
      const other = await context.newPage();
      await other.goto(`/lite/?client=other${client}`);
      await other.waitForFunction(() => window.liteDemo?.ready);
      await other.evaluate(() =>
        window.liteDemo.execute("add", [3n, "different owner", 3n]),
      );
      const rejected = await other.evaluate(async (endpoint) => {
        try {
          await window.liteDemo.sync(endpoint);
          return "";
        } catch (e) {
          return String(e);
        }
      }, endpoint);
      expect(rejected).toMatch(/409/);
      expect(
        (await other.evaluate(() => window.liteDemo.state())).pending,
      ).toHaveLength(1);
      expect((await (await request.get(endpoint)).json()).head).toBe("2");
    } finally {
      await context.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
