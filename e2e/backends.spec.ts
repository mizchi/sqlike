import { test, expect } from "@playwright/test";
test("one Litestream SQL protocol converges across real SQLite, SQLike and Turso with offline persistence", async ({
  browser,
}) => {
  const context = await browser.newContext(),
    room = `engines${crypto.randomUUID().replaceAll("-", "")}`,
    engines = ["sqlite", "sqlike", "turso"] as const;
  try {
    const pages = [];
    for (const [index, engine] of engines.entries()) {
      const page = await context.newPage();
      pages.push(page);
      await page.goto(
        `/?engine=${engine}&backend=node&room=${room}&client=matrix-${engine}`,
      );
      await page.waitForFunction(
        () =>
          window.syncDemo?.ready ||
          document.querySelector("#error")?.textContent,
        undefined,
        { timeout: 25000 },
      );
      expect(await page.locator("#error").textContent()).toBe("");
      expect(
        await page.evaluate(() => ({
          engine: window.syncDemo.engine,
          capabilities: window.syncDemo.capabilities,
        })),
      ).toEqual({
        engine,
        capabilities: {
          sql: true,
          changesetCapture: engine !== "turso",
          sqliteImageRead: engine !== "turso",
        },
      });
      await page.evaluate(() => window.syncDemo.sync());
      await page.evaluate(
        ({ engine, index }) =>
          window.syncDemo.execute(
            "INSERT INTO notes(id,title,score,payload) VALUES(?,?,?,?)",
            [
              engine,
              `値-${engine}`,
              9007199254740993n + BigInt(index),
              new Uint8Array([0, 255, index]),
            ],
            "sql",
          ),
        { engine, index },
      );
      await page.evaluate(() => window.syncDemo.sync());
    }
    for (const page of pages) {
      await page.evaluate(() => window.syncDemo.sync());
      expect(
        (await page.evaluate(() => window.syncDemo.state())).rows,
      ).toHaveLength(3);
    }
    await context.setOffline(true);
    for (const [index, page] of pages.entries()) {
      await page.evaluate(
        (engine) =>
          window.syncDemo.execute("UPDATE notes SET title=? WHERE id=?", [
            `offline-${engine}`,
            engine,
          ]),
        engines[index]!,
      );
      await page.reload();
      await page.waitForFunction(() => window.syncDemo?.ready);
      expect(
        (await page.evaluate(() => window.syncDemo.state())).pending,
      ).toHaveLength(1);
    }
    await context.setOffline(false);
    for (const [index, page] of pages.entries()) {
      if (engines[index] === "turso") {
        // SQL base guards require explicit rebase; Session old-value guards can
        // accept the independent SQLite/SQLike edits without guessing.
        await expect(
          page.evaluate(() => window.syncDemo.sync()),
        ).rejects.toThrow(/stale/);
        expect(
          (await page.evaluate(() => window.syncDemo.state())).pending,
        ).toHaveLength(1);
        await page.evaluate(
          (engine) =>
            window.syncDemo.resolve({
              action: "replace",
              reason: "explicitly reapply this selected primary key",
              operations: [
                {
                  mode: "sql",
                  statements: [
                    {
                      sql: "UPDATE notes SET title=? WHERE id=?",
                      params: [
                        { t: "text", v: `offline-${engine}` },
                        { t: "text", v: engine },
                      ],
                    },
                  ],
                },
              ],
            }),
          engines[index]!,
        );
      }
      await page.evaluate(() => window.syncDemo.sync());
    }
    const expected = engines
      .map((engine, index) => ({
        id: { t: "text", v: engine },
        title: { t: "text", v: `offline-${engine}` },
        score: { t: "integer", v: String(9007199254740993n + BigInt(index)) },
        payload: { t: "blob", v: [0, 255, index] },
      }))
      .sort((a, b) => a.id.v.localeCompare(b.id.v));
    for (const page of pages) {
      await page.evaluate(() => window.syncDemo.sync());
      expect(
        await page.evaluate(() =>
          window.syncDemo.query(
            "SELECT id,title,score,payload FROM notes ORDER BY id",
          ),
        ),
      ).toEqual(expected);
      await expect(
        page.evaluate(() =>
          window.syncDemo.query("UPDATE notes SET title='invalid'"),
        ),
      ).rejects.toThrow();
      expect(
        (await page.evaluate(() => window.syncDemo.state())).pending,
      ).toHaveLength(0);
    }
    await expect(
      pages[2]!.evaluate(() =>
        window.syncDemo.execute(
          "UPDATE notes SET title='invalid'",
          [],
          "changeset",
        ),
      ),
    ).rejects.toThrow(/Session capture/);
    expect(
      (await pages[2]!.evaluate(() => window.syncDemo.state())).pending,
    ).toHaveLength(0);
  } finally {
    await context.close();
  }
});
