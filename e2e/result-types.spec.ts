import { test, expect } from "@playwright/test";
import { build } from "vite";
import { readFileSync } from "node:fs";
import type * as Runtime from "./fixtures/result-runtime.ts";
test("browser query results preserve INTEGER/REAL and full TEXT across SQLite, SQLike and Turso", async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    for (const engine of ["sqlite", "sqlike", "turso"]) {
      const page = await context.newPage();
      await page.goto(
        `/?engine=${engine}&client=types-${engine}-${Date.now()}`,
      );
      await page.waitForFunction(
        () =>
          window.syncDemo?.ready ||
          document.querySelector("#error")?.textContent,
        undefined,
        { timeout: 30000 },
      );
      expect(await page.locator("#error").textContent()).toBe("");
      const result = await page.evaluate(() =>
        window.syncDemo.query("SELECT 1 AS i,1.0 AS r,? AS t,x'00ff' AS b", [
          "\ufeffa\0b",
        ]),
      );
      expect(result).toEqual([
        {
          i: { t: "integer", v: "1" },
          r: { t: "real", v: 1 },
          t: { t: "text", v: "\ufeffa\0b" },
          b: { t: "blob", v: [0, 255] },
        },
      ]);
      if (engine === "turso") {
        await expect(
          page.evaluate(() =>
            window.syncDemo.query("SELECT typeof(?) AS t,? AS v", [1, 1]),
          ),
        ).rejects.toThrow(/unsupported Turso REAL binding/);
        expect(
          await page.evaluate(() =>
            window.syncDemo.query(
              "SELECT typeof(CAST(? AS REAL)) AS t,CAST(? AS REAL) AS v",
              [1n, 1n],
            ),
          ),
        ).toEqual([{ t: { t: "text", v: "real" }, v: { t: "real", v: 1 } }]);
      } else {
        expect(
          await page.evaluate(() =>
            window.syncDemo.query("SELECT typeof(?) AS t,? AS v", [1, 1]),
          ),
          engine,
        ).toEqual([{ t: { t: "text", v: "real" }, v: { t: "real", v: 1 } }]);
      }
      await page.close();
    }
  } finally {
    await context.close();
  }
});
test("SQLite WASM rejects unrepresentable RETURNING atomically instead of replacing bytes", async ({
  page,
}) => {
  const result = await build({
    configFile: false,
    publicDir: false,
    logLevel: "error",
    build: {
      write: false,
      minify: true,
      target: "esnext",
      lib: { entry: "e2e/fixtures/result-runtime.ts", formats: ["es"] },
    },
  });
  let code = "";
  for (const b of Array.isArray(result) ? result : [result])
    if ("output" in b)
      for (const c of b.output) if (c.type === "chunk") code += c.code;
  await page.route("**/result-types", (r) =>
    r.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.route("**/result-types.js", (r) =>
    r.fulfill({ contentType: "text/javascript", body: code }),
  );
  await page.route("**/sqlite3.wasm", (r) =>
    r.fulfill({
      contentType: "application/wasm",
      body: readFileSync(
        "node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm",
      ),
    }),
  );
  await page.goto("/result-types");
  const observed = await page.evaluate(async () => {
    const path = "/result-types.js",
      m = (await import(path)) as typeof Runtime;
    const sqlite = await m.sqlite3InitModule();
    const raw = new sqlite.oo1.DB(":memory:");
    const db = new m.WasmDatabase(sqlite, raw);
    try {
      db.run("CREATE TABLE t(v)");
      let error = "";
      try {
        db.all("INSERT INTO t VALUES(CAST(x'80' AS TEXT)) RETURNING v");
      } catch (e) {
        error = (e as Error).message;
      }
      return {
        error,
        rows: db
          .all("SELECT count(*) AS n FROM t")
          .map((row) =>
            Object.fromEntries(
              Object.entries(row).map(([k, v]) => [k, m.packResult(v)]),
            ),
          ),
      };
    } finally {
      raw.close();
    }
  });
  expect(observed.error).toMatch(/unsupported SQL/);
  expect(observed.rows).toEqual([{ n: { t: "integer", v: "0" } }]);
});
