import { test, expect } from "@playwright/test";
import { build } from "vite";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import type * as Runtime from "./fixtures/release-runtime.ts";

test("paged candidates keep committed versions through multi-page writes, compaction, abort and stale writers", async ({ page }) => {
  const catalog = buildCatalog({
    schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER,body TEXT)"],
    queries: [
      { name: "seed", sql: `INSERT INTO t VALUES${Array(100).fill("(?,?,?)").join(",")}` },
      { name: "get", sql: "SELECT id,n,body FROM t WHERE id=?" },
      { name: "edit", sql: "UPDATE t SET n=? WHERE id=?" },
      { name: "erase", sql: "DELETE FROM t WHERE id<?" },
      { name: "add", sql: "INSERT INTO t VALUES(2000,2000,'new')" },
      { name: "count", sql: "SELECT count(*) FROM t" },
      { name: "begin", sql: "BEGIN" }, { name: "commit", sql: "COMMIT" },
    ],
  });
  const output = await build({ configFile: false, publicDir: false, logLevel: "error", build: {
    write: false,
      rolldownOptions: { output: { codeSplitting: false } }, minify: true, target: "esnext", lib: { entry: "e2e/fixtures/release-runtime.ts", formats: ["es"] },
  } });
  let code = "";
  for (const o of Array.isArray(output) ? output : [output])
    if ("output" in o) for (const c of o.output) if (c.type === "chunk") code += c.code;
  await page.route("**/pages-case", r => r.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
  await page.route("**/pages-case.js", r => r.fulfill({ contentType: "text/javascript", body: code }));
  await page.goto("/pages-case");
  const observed = await page.evaluate(async ({ artifact, hash }) => {
    const path = "/pages-case.js";
    const { AotDatabase, MoonImageStore } = await import(path) as typeof Runtime;
    const open = async () => AotDatabase.withStore(artifact, hash, await MoonImageStore.open("paged-candidates"));
    let db = await open();
    for (let start = 0; start < 1000; start += 100) {
      const values = Array.from({ length: 100 }, (_, i) => [BigInt(start + i), BigInt(start + i), `body${start + i}`]).flat();
      await db.execute("seed", values);
    }
    const versions = await open();
    await db.execute("begin");
    for (const id of [63, 64, 500, 999]) await db.execute("edit", [BigInt(id + 10000), BigInt(id)]);
    await db.execute("commit");
    const old = (await versions.inspect("get", [999n])).rows;
    let stale = false;
    try { await versions.execute("edit", [-1n, 999n]); } catch { stale = true; }
    await versions.close();
    await db.execute("erase", [700n]);
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      const request = put.apply(this, args);
      if (this.name === "delta") this.transaction.abort();
      return request;
    };
    let aborted = false;
    try { await db.execute("edit", [-1n, 999n]); } catch { aborted = true; }
    finally { IDBObjectStore.prototype.put = put; }
    await db.close();
    db = await open();
    const count = (await db.inspect("count")).rows;
    const gone = (await db.inspect("get", [500n])).rows;
    const kept = (await db.inspect("get", [999n])).rows;
    await db.execute("add");
    await db.close();
    db = await open();
    const appended = (await db.inspect("get", [2000n])).rows;
    const final = (await db.inspect("count")).rows;
    await db.close();
    return { old, stale, aborted, count, gone, kept, appended, final };
  }, { artifact: catalog.artifact, hash: catalog.manifest.artifactSHA256 });
  expect(observed).toEqual({ old: [[999n, 999n, "body999"]], stale: true, aborted: true,
    count: [[300n]], gone: [], kept: [[999n, 10999n, "body999"]], appended: [[2000n, 2000n, "new"]], final: [[301n]] });
});
