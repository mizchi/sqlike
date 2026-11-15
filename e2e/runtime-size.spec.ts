import { test, expect } from "@playwright/test";
import { readdirSync, statSync } from "node:fs";

test("SQLite starts and reloads offline without downloading the optional Turso runtime", async ({
  browser,
}) => {
  const driver = readdirSync("dist/assets").find(
    (name) =>
      name.endsWith(".js") &&
      statSync(`dist/assets/${name}`).size > 8 * 1024 * 1024,
  );
  expect(driver).toBeTruthy();
  const context = await browser.newContext();
  let requests = 0;
  await context.route(`**/assets/${driver}`, (route) => {
    requests++;
    return route.abort();
  });
  try {
    const page = await context.newPage();
    await page.goto("/?engine=sqlite&client=size-budget");
    await page.waitForFunction(() => window.syncDemo?.ready);
    await expect
      .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), {
        timeout: 5000,
      })
      .toBe(true);
    expect(requests).toBe(0);
    await context.setOffline(true);
    await page.reload();
    await page.waitForFunction(() => window.syncDemo?.ready);
    expect(
      await page.evaluate(() => window.syncDemo.query("SELECT 1 AS n")),
    ).toEqual([{ n: { t: "integer", v: "1" } }]);
  } finally {
    await context.close();
  }
});
