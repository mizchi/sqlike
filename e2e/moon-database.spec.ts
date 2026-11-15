import { test, expect } from "@playwright/test";

for (const backend of ["node", "do", "peer", "peer-do"]) {
  test(`moonbit/${backend}: SQL, native binary, IndexedDB and offline reload`, async ({
    browser,
  }) => {
    const room = `moon${crypto.randomUUID().replaceAll("-", "")}`;
    const a = await browser.newContext();
    const b = await browser.newContext();
    const host = backend.startsWith("peer")
      ? await browser.newContext()
      : undefined;
    const pa = await a.newPage();
    const pb = await b.newPage();
    const requests: string[] = [];
    a.on("request", (request) => requests.push(request.url()));
    async function open(page: typeof pa, client: string, role = "") {
      await page.goto(
        `/?engine=moonbit&backend=${backend}&room=${room}&client=${client}${role}`,
      );
      await page.waitForFunction(
        () =>
          window.syncDemo?.ready ||
          document.querySelector("#error")?.textContent,
      );
      expect(await page.locator("#error").textContent()).toBe("");
    }
    try {
      if (host) await open(await host.newPage(), "host", "&role=host");
      await open(pa, "a");
      await pa.evaluate(() => window.syncDemo.sync());
      await pa.evaluate(() =>
        window.syncDemo.execute(
          "INSERT INTO notes(id,title) VALUES('a','initial'),('b','initial')",
          [],
          "sql",
        ),
      );
      await pa.evaluate(() => window.syncDemo.sync());
      await open(pb, "b");
      await pb.evaluate(() => window.syncDemo.sync());
      await a.setOffline(true);
      await pa.evaluate(() =>
        window.syncDemo.execute(
          "UPDATE notes SET title='offline',payload=x'00ff' WHERE id='a'",
          [],
          "changeset",
        ),
      );
      await expect(
        pa.evaluate(() =>
          window.syncDemo.batch(
            [
              { sql: "UPDATE notes SET title='bad'", params: [] },
              { sql: "INSERT INTO missing VALUES(1)", params: [] },
            ],
            "sql",
          ),
        ),
      ).rejects.toThrow(/no such table/);
      await pa.reload();
      await pa.waitForFunction(() => window.syncDemo?.ready);
      expect(
        (await pa.evaluate(() => window.syncDemo.state())).pending,
      ).toHaveLength(1);
      await pb.evaluate(() =>
        window.syncDemo.execute(
          "UPDATE notes SET title='remote' WHERE id='b'",
          [],
          "sql",
        ),
      );
      await pb.evaluate(() => window.syncDemo.sync());
      await a.setOffline(false);
      await pa.evaluate(() => window.syncDemo.sync());
      await pb.evaluate(() => window.syncDemo.sync());
      const sa = await pa.evaluate(() => window.syncDemo.state());
      const sb = await pb.evaluate(() => window.syncDemo.state());
      expect(sa.rows).toEqual(sb.rows);
      expect(sa.pending).toHaveLength(0);
      expect(sa.rows.map((r) => r.title)).toEqual([
        { t: "text", v: "offline" },
        { t: "text", v: "remote" },
      ]);
      expect(
        requests.filter((url) => /\.wasm(?:\?|$)|turso-executor/.test(url)),
      ).toEqual([]);
    } finally {
      await a.close();
      await b.close();
      await host?.close();
    }
  });
}
