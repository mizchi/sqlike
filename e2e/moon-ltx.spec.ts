import { test, expect, type BrowserContext, type Page } from "@playwright/test";

async function open(context: BrowserContext, room: string, client: string) {
  // SQLike data and replica candidates must work without filesystem APIs.
  await context.route(/\/assets\/worker-[^/]+\.js$/, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: `navigator.storage.getDirectory=async()=>{throw Error("OPFS unavailable in IndexedDB-only test")};\n${await response.text()}`,
    });
  });
  // Both logical restore gateways and all native browser database runtimes are
  // unavailable: successful synchronization must traverse LTX + MoonBit reader.
  await context.route(/\/api\/[^/]+\/(snapshot|replica)$/, (route) =>
    route.abort(),
  );
  await context.route(
    /\/assets\/(?:.*\.wasm|wasm-database-[^/]+\.js|sqlite3-[^/]+\.js|turso-[^/]+\.js)(?:\?.*)?$/,
    (route) => route.abort(),
  );
  const page = await context.newPage();
  await page.goto(`/?engine=moonbit&backend=ltx&room=${room}&client=${client}`);
  await page.waitForFunction(
    () =>
      window.syncDemo?.ready || document.querySelector("#error")?.textContent,
  );
  expect(await page.locator("#error").textContent()).toBe("");
  const worker = page.workers().find((w) => /\/assets\/worker-/.test(w.url()));
  expect(worker).toBeDefined();
  expect(
    await worker!.evaluate(() => String(navigator.storage.getDirectory)),
  ).toContain("OPFS unavailable in IndexedDB-only test");
  return page;
}
const sync = (page: Page) => page.evaluate(() => window.syncDemo.sync());

test("MoonBit + real LTX: raw SQLite pages, binary upload, offline reload and incremental convergence without SQLite WASM", async ({
  browser,
}) => {
  test.skip(!process.env.LITESTREAM_BIN, "requires real Litestream");
  const room = `pure${crypto.randomUUID().replaceAll("-", "")}`;
  const a = await browser.newContext(),
    b = await browser.newContext();
  const requests: string[] = [];
  a.on("request", (r) => requests.push(r.url()));
  b.on("request", (r) => requests.push(r.url()));
  try {
    const pa = await open(a, room, "a");
    await sync(pa);
    await pa.evaluate(() =>
      window.syncDemo.execute(
        "INSERT INTO notes(id,title) VALUES('a','initial'),('b','initial')",
        [],
        "sql",
      ),
    );
    await sync(pa);
    await pa.evaluate(() =>
      window.syncDemo.batch(
        [
          {
            sql: "CREATE TABLE extra(id INTEGER PRIMARY KEY,n INTEGER,r REAL,body BLOB)",
            params: [],
          },
          {
            sql: "INSERT INTO extra VALUES(1,?,?,?)",
            params: [
              { t: "integer", v: "9223372036854775807" },
              { t: "real", v: 42 },
              { t: "blob", v: Array(16000).fill(255) },
            ],
          },
        ],
        "sql",
      ),
    );
    await sync(pa);
    const pb = await open(b, room, "b");
    await sync(pb);
    expect(
      await pb.evaluate(() =>
        window.syncDemo.query(
          "SELECT n,r,typeof(r),length(body) AS size FROM extra",
        ),
      ),
    ).toEqual([
      {
        n: { t: "integer", v: "9223372036854775807" },
        r: { t: "real", v: 42 },
        "typeof(r)": { t: "text", v: "real" },
        size: { t: "integer", v: "16000" },
      },
    ]);
    const before = await pa.evaluate(() => window.syncDemo.state());
    await a.setOffline(true);
    await pa.evaluate(() =>
      window.syncDemo.execute(
        "UPDATE notes SET title='offline',payload=x'00ff' WHERE id='a'",
        [],
        "changeset",
      ),
    );
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
    await sync(pb);
    await a.setOffline(false);
    await sync(pa);
    await sync(pb);
    const sa = await pa.evaluate(() => window.syncDemo.state()),
      sb = await pb.evaluate(() => window.syncDemo.state());
    expect(sa.rows).toEqual(sb.rows);
    expect(sa.pending).toHaveLength(0);
    expect(sa.rows.map((r) => r.title)).toEqual([
      { t: "text", v: "offline" },
      { t: "text", v: "remote" },
    ]);
    expect(BigInt(sa.replica!.txid)).toBeGreaterThan(
      BigInt(before.replica!.txid),
    );
    expect(sa.replica!.pagesApplied).toBeGreaterThan(0);
    expect(sa.replica!.bytesDownloaded).toBeGreaterThan(0);
    // The existing consumer-owned policy must still resolve an ambiguous SQL
    // operation before its authoritative result returns through the LTX reader.
    await pa.evaluate(() =>
      window.syncDemo.execute("UPDATE notes SET title='same'", [], "sql"),
    );
    await sync(pa);
    await pa.evaluate(() =>
      window.syncDemo.execute(
        "UPDATE notes SET score=7 WHERE title='same'",
        [],
        "sql",
        {
          policy: "select-note@1",
          intent: { id: "b", score: 7 },
          assertions: [
            {
              name: "one selected note",
              query: {
                sql: "SELECT id FROM notes WHERE title='same'",
                params: [],
              },
              exactly: 1,
            },
          ],
        },
      ),
    );
    await sync(pa);
    await sync(pb);
    expect(
      (await pa.evaluate(() => window.syncDemo.state())).rows.map(
        (row) => row.score,
      ),
    ).toEqual([
      { t: "integer", v: "0" },
      { t: "integer", v: "7" },
    ]);
    expect(
      (await pa.evaluate(() => window.syncDemo.receipts())).at(-1)!.receipt
        .outcome,
    ).toBe("resolved");
    expect(requests.some((url) => /\/ltx\/[0-9]\//.test(url))).toBe(true);
    expect(
      requests.filter((url) =>
        /\/(snapshot|replica)$|\.wasm(?:\?|$)|wasm-database-|sqlite3-|turso-executor/.test(
          url,
        ),
      ),
    ).toEqual([]);
  } finally {
    await a.close();
    await b.close();
  }
});

test("MoonBit + LTX: failed download, accepted outbox, orphan cleanup and missing-image recovery survive reload", async ({
  browser,
}) => {
  test.skip(!process.env.LITESTREAM_BIN, "requires real Litestream");
  const room = `fault${crypto.randomUUID().replaceAll("-", "")}`;
  const context = await browser.newContext();
  try {
    const page = await open(context, room, "fault");
    await sync(page);
    await page.evaluate(() =>
      window.syncDemo.execute(
        "INSERT INTO notes(id,title) VALUES('a','old')",
        [],
        "sql",
      ),
    );
    await sync(page);
    const before = await page.evaluate(() => window.syncDemo.state());
    await page.evaluate(() =>
      window.syncDemo.execute(
        "UPDATE notes SET title='pending' WHERE id='a'",
        [],
        "changeset",
      ),
    );
    await context.route(/\/ltx\/[0-9]\//, async (route) => {
      const response = await route.fetch();
      const bytes = Buffer.from(await response.body());
      bytes[bytes.length - 1] = bytes.at(-1)! ^ 1;
      await route.fulfill({ response, body: bytes });
    });
    await expect(sync(page)).rejects.toThrow(/SHA-256/);
    const failed = await page.evaluate(() => window.syncDemo.state());
    expect(failed.replica!.txid).toBe(before.replica!.txid);
    expect(failed.pending[0]!.status).toBe("accepted");
    await page.reload();
    await page.waitForFunction(() => window.syncDemo?.ready);
    expect(
      (await page.evaluate(() => window.syncDemo.state())).replica!.txid,
    ).toBe(before.replica!.txid);
    await context.unroute(/\/ltx\/[0-9]\//);
    await sync(page);
    expect(
      (await page.evaluate(() => window.syncDemo.state())).pending,
    ).toHaveLength(0);
    await page.evaluate(async () => {
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open(
          "browser-litestream-image-cache-moonbit-fault",
          1,
        );
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const tx = req.result.transaction("files", "readwrite");
          tx.objectStore("files").put(
            new Uint8Array([1, 2, 3]),
            "image-00000000-0000-0000-0000-000000000000.sqlite",
          );
          tx.oncomplete = () => {
            req.result.close();
            resolve();
          };
          tx.onabort = () => reject(tx.error);
        };
      });
    });
    await page.reload();
    await page.waitForFunction(() => window.syncDemo?.ready);
    const files = await page.evaluate(async () => {
      return new Promise<string[]>((resolve, reject) => {
        const req = indexedDB.open(
          "browser-litestream-image-cache-moonbit-fault",
          1,
        );
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const tx = req.result.transaction("files", "readonly"),
            keys = tx.objectStore("files").getAllKeys();
          tx.oncomplete = () => {
            req.result.close();
            resolve(keys.result.map(String));
          };
          tx.onabort = () => reject(tx.error);
        };
      });
    });
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain("00000000-0000");
    await page.evaluate(async () => {
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open(
          "browser-litestream-image-cache-moonbit-fault",
          1,
        );
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const tx = req.result.transaction("files", "readwrite");
          tx.objectStore("files").clear();
          tx.oncomplete = () => {
            req.result.close();
            resolve();
          };
          tx.onabort = () => reject(tx.error);
        };
      });
    });
    await sync(page);
    expect(
      (await page.evaluate(() => window.syncDemo.state())).rows[0]!.title,
    ).toEqual({ t: "text", v: "pending" });
  } finally {
    await context.close();
  }
});
