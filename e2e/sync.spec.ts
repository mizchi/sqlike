import { test, expect, type Page } from "@playwright/test";

async function open(page: Page, room: string, backend: string, client: string, host = false, engine = "sqlite") {
  page.on("pageerror", e => console.error("browser:", e.message));
  await page.goto(`/?room=${room}&backend=${backend}&client=${client}&engine=${engine}${host ? "&role=host" : ""}`);
  await page.waitForFunction(() => window.syncDemo?.ready || document.querySelector("#error")?.textContent,undefined, { timeout: engine==="turso"?25000:15000 });
  expect(await page.locator("#error").textContent()).toBe("");
}
async function execute(page: Page, sql: string, mode: "sql" | "changeset" = "changeset") {
  return page.evaluate(({ sql, mode }) => window.syncDemo.execute(sql, [], mode), { sql, mode });
}
const sync = (page: Page) => page.evaluate(() => window.syncDemo.sync());

test("turso: real OPFS storage, guarded SQL, rollback and offline reload", async ({ browser }) => {
  const room = `t${crypto.randomUUID().replaceAll("-", "")}`;
  const context = await browser.newContext();const page = await context.newPage();
  page.on("console",message=>{if(message.type()==="error")console.error("turso:",message.text());});
  try {
    await open(page,room,"node","turso-client",false,"turso");
    await page.evaluate(async () => {await (await navigator.storage.getDirectory()).getFileHandle("browser-litestream-turso-turso-client.sqlite");});
    await sync(page);
    await page.evaluate(() => window.syncDemo.execute("INSERT INTO notes(id,title,score,payload) VALUES(?,?,?,?)",["x","before",9223372036854775806n,new Uint8Array([0,255])],"sql"));
    await sync(page);
    expect(await page.evaluate(() => window.syncDemo.query("SELECT score,payload FROM notes WHERE id='x'"))).toEqual([{score:{t:"integer",v:"9223372036854775806"},payload:{t:"blob",v:[0,255]}}]);
    await expect(page.evaluate(() => window.syncDemo.batch([{sql:"UPDATE notes SET title='bad' WHERE id='x'",params:[]},{sql:"INSERT INTO missing VALUES(1)",params:[]}],"sql"))).rejects.toThrow();
    expect((await page.evaluate(() => window.syncDemo.state())).pending).toHaveLength(0);
    await expect(execute(page,"UPDATE notes SET title='unsupported' WHERE id='x'","changeset")).rejects.toThrow(/Session capture/);
    expect((await page.evaluate(() => window.syncDemo.state())).pending).toHaveLength(0);
    await page.evaluate(async () => {await navigator.serviceWorker.ready;});await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await context.setOffline(true);await execute(page,"UPDATE notes SET title='offline' WHERE id='x'","sql");
    await page.reload();await page.waitForFunction(() => window.syncDemo?.ready);
    expect((await page.evaluate(() => window.syncDemo.state())).pending).toHaveLength(1);
    await context.setOffline(false);await sync(page);
    expect(await page.evaluate(() => window.syncDemo.query("SELECT title FROM notes WHERE id='x'"))).toEqual([{title:{t:"text",v:"offline"}}]);
  } finally {await context.close();}
});

for (const backend of ["node", "do", "peer", "peer-do", ...(process.env.LITESTREAM_BIN ? ["litestream", "ltx"] : [])]) {
  test(`${backend}: SQL + native changeset, offline reload and two-browser convergence`, async ({ browser }) => {
    const room = `r${crypto.randomUUID().replaceAll("-", "")}`;
    const a = await browser.newContext(); const b = await browser.newContext();
    const pa = await a.newPage(); const pb = await b.newPage();
    const hostContext = backend.startsWith("peer") ? await browser.newContext() : undefined;
    try {
      if (backend === "ltx") {
        // The direct path must not fall back to either server snapshot gateway.
        for (const context of [a, b]) await context.route(/\/api\/[^/]+\/(snapshot|replica)$/, route => route.abort());
      }
      if (hostContext) await open(await hostContext.newPage(), room, backend, "host", true);
      await open(pa, room, backend, "a"); await sync(pa);
      await execute(pa, "INSERT INTO notes(id,title) VALUES ('a','initial'),('b','initial')", "sql");
      await sync(pa);
      await open(pb, room, backend, "b"); await sync(pb);
      await pa.evaluate(async () => { await navigator.serviceWorker.ready; });
      await pa.waitForFunction(() => !!navigator.serviceWorker.controller);
      await a.setOffline(true);
      await execute(pa, "UPDATE notes SET title='offline',payload=x'00ff' WHERE id='a'");
      await pa.reload();
      await pa.waitForFunction(() => window.syncDemo?.ready);
      const offline = await pa.evaluate(() => window.syncDemo.state());
      expect(offline.pending).toHaveLength(1);
      expect(offline.rows[0]?.title).toEqual({ t: "text", v: "offline" });
      await execute(pb, "UPDATE notes SET title='remote' WHERE id='b'", "sql"); await sync(pb);
      await a.setOffline(false); await sync(pa); await sync(pb);
      const sa = await pa.evaluate(() => window.syncDemo.state());
      const sb = await pb.evaluate(() => window.syncDemo.state());
      expect(sa.rows).toEqual(sb.rows); expect(sa.pending).toHaveLength(0);
      expect(sa.rows.map(r => r.title)).toEqual([{ t: "text", v: "offline" }, { t: "text", v: "remote" }]);
      if (backend === "ltx") {
        expect(BigInt(sa.replica!.txid)).toBeGreaterThan(0n);
        expect(sa.replica!.filesApplied).toBeGreaterThan(0);
        expect(sa.replica!.pagesApplied).toBeGreaterThan(0);
        expect(sa.replica!.bytesDownloaded).toBeGreaterThan(0);
      }
    } finally { await a.close(); await b.close(); await hostContext?.close(); }
  });
}

test("conflicting changesets and stale SQL stay durable until explicitly discarded", async ({ browser }) => {
  const room = `c${crypto.randomUUID().replaceAll("-", "")}`;
  const a = await browser.newContext(); const b = await browser.newContext();
  const pa = await a.newPage(); const pb = await b.newPage();
  try {
    await open(pa, room, "do", "a"); await sync(pa); await execute(pa, "INSERT INTO notes(id,title) VALUES ('x','old')", "sql"); await sync(pa);
    await open(pb, room, "do", "b"); await sync(pb);
    await execute(pa, "UPDATE notes SET title='local' WHERE id='x'");
    await execute(pb, "UPDATE notes SET title='remote' WHERE id='x'"); await sync(pb);
    await expect(sync(pa)).rejects.toThrow(/conflict/);
    await pa.reload(); await pa.waitForFunction(() => window.syncDemo?.ready);
    expect((await pa.evaluate(() => window.syncDemo.state())).pending[0]?.status).toBe("deferred");
    await pa.evaluate(() => window.syncDemo.discard());
    await execute(pa, "UPDATE notes SET score=1", "sql");
    await execute(pb, "UPDATE notes SET score=2", "sql"); await sync(pb);
    await expect(sync(pa)).rejects.toThrow(/stale/);
    expect((await pa.evaluate(() => window.syncDemo.state())).pending).toHaveLength(1);
  } finally { await a.close(); await b.close(); }
});

test("ltx: failed transfer retains the committed image and pending writes across reload", async ({ browser }) => {
  test.skip(!process.env.LITESTREAM_BIN, "requires real Litestream");
  const room = `f${crypto.randomUUID().replaceAll("-", "")}`;
  const a = await browser.newContext(); const b = await browser.newContext();
  const pa = await a.newPage(); const pb = await b.newPage();
  try {
    await open(pa, room, "ltx", "fault"); await sync(pa);
    await execute(pa, "INSERT INTO notes(id,title) VALUES('a','old'),('b','old')", "sql"); await sync(pa);
    await open(pb, room, "ltx", "other"); await sync(pb);
    const before = await pa.evaluate(() => window.syncDemo.state());
    await execute(pa, "UPDATE notes SET title='offline' WHERE id='a'");
    await execute(pb, "UPDATE notes SET title='remote' WHERE id='b'"); await sync(pb);
    await a.route(/\/ltx\/[0-9]\//, async route => {
      const response = await route.fetch(); const bytes = Buffer.from(await response.body());
      bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
      await route.fulfill({ response, body: bytes });
    });
    await expect(sync(pa)).rejects.toThrow(/SHA-256/);
    const failed = await pa.evaluate(() => window.syncDemo.state());
    expect(failed.replica!.txid).toBe(before.replica!.txid);
    expect(failed.pending).toHaveLength(1);
    expect(failed.pending[0]!.status).toBe("accepted");
    await pa.reload(); await pa.waitForFunction(() => window.syncDemo?.ready);
    expect((await pa.evaluate(() => window.syncDemo.state())).replica!.txid).toBe(before.replica!.txid);
    await a.unroute(/\/ltx\/[0-9]\//);
    await sync(pa); await sync(pb);
    expect((await pa.evaluate(() => window.syncDemo.state())).rows).toEqual((await pb.evaluate(() => window.syncDemo.state())).rows);
    expect((await pa.evaluate(() => window.syncDemo.state())).pending).toHaveLength(0);
    // Reproduce a worker dying after flush, before its SQLite cursor commit.
    await pa.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle("browser-litestream-fault-ltx");
      const file = await dir.getFileHandle("image-00000000-0000-0000-0000-000000000000.sqlite", { create: true });
      const writer = await file.createWritable(); await writer.write(new Uint8Array([1, 2, 3])); await writer.close();
    });
    await pa.reload(); await pa.waitForFunction(() => window.syncDemo?.ready);
    const images = await pa.evaluate(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("browser-litestream-fault-ltx");
      const names = []; for await (const name of dir.keys()) names.push(name); return names;
    });
    expect(images).toHaveLength(1);
    expect(images[0]).not.toContain("00000000-0000-0000-0000-000000000000");
    await sync(pa);
    // Consumer recovery policy reconstructs a missing confirmed image from LTX.
    await pa.evaluate(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("browser-litestream-fault-ltx");
      for await (const name of dir.keys()) await dir.removeEntry(name);
    });
    await sync(pa);
    expect((await pa.evaluate(() => window.syncDemo.state())).pending).toHaveLength(0);
  } finally { await a.close(); await b.close(); }
});

test("generic tables, composite keys and binary DDL rejection against real DO", async ({ page }) => {
  const room = `g${crypto.randomUUID().replaceAll("-", "")}`;
  await open(page, room, "do", "generic"); await sync(page);
  await execute(page, "CREATE TABLE items(a TEXT NOT NULL,b INTEGER NOT NULL,value TEXT,PRIMARY KEY(a,b)) WITHOUT ROWID", "sql");
  await sync(page);
  await execute(page, "INSERT INTO items VALUES('日本語',7,'first')"); await sync(page);
  await execute(page, "UPDATE items SET value='updated' WHERE a='日本語' AND b=7"); await sync(page);
  const rows = await page.evaluate(() => window.syncDemo.query("SELECT value FROM items"));
  expect(rows).toEqual([{ value: { t: "text", v: "updated" } }]);
  await expect(execute(page, "CREATE INDEX items_value ON items(value)")).rejects.toThrow(/DDL/);
  expect((await page.evaluate(() => window.syncDemo.state())).pending).toHaveLength(0);
  await execute(page, "DELETE FROM items"); await sync(page);
  expect(await page.evaluate(() => window.syncDemo.query("SELECT * FROM items"))).toEqual([]);
});

for (const {backend,engine} of [
  ...["node", "do", "peer", "peer-do", ...(process.env.LITESTREAM_BIN ? ["ltx"] : [])].map(backend=>({backend,engine:"sqlite"})),
  {backend:"node",engine:"turso"},{backend:"do",engine:"turso"},
  ...(process.env.LITESTREAM_BIN?[{backend:"litestream",engine:"turso"}]:[]),
]) {
  test(`${engine}/${backend}: guarded SQL and consumer MoonBit ambiguity policy`, async ({ browser }) => {
    const room = `p${crypto.randomUUID().replaceAll("-", "")}`;
    const context = await browser.newContext(); const page = await context.newPage();
    const host = backend.startsWith("peer") ? await browser.newContext() : undefined;
    try {
      if (host) await open(await host.newPage(), room, backend, "host", true);
      await open(page, room, backend, "policy",false,engine); await sync(page);
      await execute(page, "INSERT INTO notes(id,title) VALUES('a','same'),('b','same')", "sql"); await sync(page);
      await execute(page, "INSERT INTO notes(id,title) VALUES(hex(randomblob(16)),'random')", "sql");
      await expect(sync(page)).rejects.toThrow(/effect|preview/i);
      expect((await page.evaluate(() => window.syncDemo.state())).pending[0]!.status).toBe("deferred");
      await page.reload(); await page.waitForFunction(() => window.syncDemo?.ready);
      await page.evaluate(() => window.syncDemo.resolve({ action: "replace", reason: "freeze the generated key", operations: [{mode:"sql",statements:[{sql:"INSERT INTO notes(id,title) VALUES('fixed','stable')",params:[]}]}] }));
      await sync(page);
      await page.evaluate(() => window.syncDemo.execute("UPDATE notes SET score=7 WHERE title='same'", [], "sql", {
        policy: "select-note@1", intent: {id:"b",score:7},
        assertions: [{name:"target",query:{sql:"SELECT id FROM notes WHERE title='same'",params:[]},exactly:1}],
      }));
      await sync(page);
      const rows = await page.evaluate(() => window.syncDemo.query("SELECT id,score FROM notes WHERE title='same' ORDER BY id"));
      expect(rows).toEqual([{id:{t:"text",v:"a"},score:{t:"integer",v:"0"}},{id:{t:"text",v:"b"},score:{t:"integer",v:"7"}}]);
      expect(await page.evaluate(() => window.syncDemo.resolutions())).toHaveLength(1);
    } finally { await context.close(); await host?.close(); }
  });
}

for(const backend of ["peer","peer-do"]){
  test(`turso: ${backend} authority receives native SQLite changesets`,async({browser})=>{
    const room=`h${crypto.randomUUID().replaceAll("-","")}`;
    const host=await browser.newContext();const a=await browser.newContext();const b=await browser.newContext();
    try {
      await open(await host.newPage(),room,backend,"turso-host",true,"turso");
      const pa=await a.newPage();const pb=await b.newPage();
      await open(pa,room,backend,"a");await sync(pa);
      await execute(pa,"INSERT INTO notes(id,title) VALUES('a','old'),('b','old')","sql");await sync(pa);
      await open(pb,room,backend,"b");await sync(pb);
      await execute(pa,"UPDATE notes SET title='first' WHERE id='a'");
      await execute(pb,"UPDATE notes SET title='second' WHERE id='b'");await sync(pb);
      await sync(pa);await sync(pb);
      expect((await pa.evaluate(()=>window.syncDemo.state())).rows).toEqual((await pb.evaluate(()=>window.syncDemo.state())).rows);
      await execute(pa,"UPDATE notes SET score=1 WHERE id='a'");
      await execute(pb,"UPDATE notes SET score=2 WHERE id='a'");await sync(pb);
      await expect(sync(pa)).rejects.toThrow(/conflict/);
      expect((await pa.evaluate(()=>window.syncDemo.state())).pending[0]!.status).toBe("deferred");
      await pa.evaluate(()=>window.syncDemo.discard());
      await execute(pa,"WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<3) SELECT sum(n) FROM seq","sql");
      await sync(pa);
      expect((await pa.evaluate(()=>window.syncDemo.state())).pending).toHaveLength(0);
    }finally{await a.close();await b.close();await host.close();}
  });
}

for (const backend of ["peer", "peer-do"]) {
  test(`${backend}: snapshots larger than 1 MiB use verified chunks`, async ({ browser }) => {
    const room = `s${crypto.randomUUID().replaceAll("-", "")}`;
    const host = await browser.newContext(); const a = await browser.newContext(); const b = await browser.newContext();
    try {
      await open(await host.newPage(), room, backend, "host", true);
      const pa = await a.newPage(); await open(pa, room, backend, "a"); await sync(pa);
      await execute(pa, "WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<600) INSERT INTO notes(id,title) SELECT printf('%04d',n),printf('%02000d',n) FROM seq", "sql");
      await sync(pa);
      const pb = await b.newPage(); await open(pb, room, backend, "b"); await sync(pb);
      expect(await pb.evaluate(() => window.syncDemo.query("SELECT COUNT(*) AS n FROM notes"))).toEqual([{n:{t:"integer",v:"600"}}]);
    } finally { await a.close(); await b.close(); await host.close(); }
  });
}
