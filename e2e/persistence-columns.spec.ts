import { test, expect } from "@playwright/test";
import { build } from "vite";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import type * as Runtime from "./fixtures/release-runtime.ts";

test("column journal preserves large values, trigger/FK effects and rollback through strict IDB faults and compaction", async ({ page }) => {
  const built = buildCatalog({
    schema: [
      "CREATE TABLE p(id INTEGER PRIMARY KEY)",
      "CREATE TABLE t(id INTEGER PRIMARY KEY,pid INTEGER REFERENCES p(id) ON UPDATE CASCADE,n BLOB,body BLOB,title TEXT)",
      "CREATE TABLE audit(id INTEGER PRIMARY KEY,tid INTEGER,n BLOB)",
      "CREATE TRIGGER au AFTER UPDATE ON t BEGIN INSERT INTO audit(tid,n) VALUES(new.id,new.n); END",
    ],
    queries: [
      { name: "parent", sql: "INSERT INTO p VALUES(1)" },
      { name: "seed", sql: "INSERT INTO t VALUES(1,1,0,?,?)" },
      { name: "edit", sql: "UPDATE t SET n=? WHERE id=1" },
      { name: "move", sql: "UPDATE p SET id=2 WHERE id=1" },
      { name: "rows", sql: "SELECT id,pid,n,body,title FROM t" },
      { name: "log", sql: "SELECT tid,n FROM audit ORDER BY id" },
      ...[
        ["begin", "BEGIN"], ["savepoint", "SAVEPOINT s"],
        ["rollback", "ROLLBACK TO s"], ["release", "RELEASE s"],
        ["commit", "COMMIT"],
      ].map(([name, sql]) => ({ name: name!, sql: sql! })),
    ],
  });
  const output = await build({
    configFile: false, publicDir: false, logLevel: "error",
    build: { write: false,
      rolldownOptions: { output: { codeSplitting: false } }, minify: true, target: "esnext", lib: {
      entry: "e2e/fixtures/release-runtime.ts", formats: ["es"],
    } },
  });
  let code = "";
  for (const o of Array.isArray(output) ? output : [output])
    if ("output" in o)
      for (const c of o.output) if (c.type === "chunk") code += c.code;
  await page.route("**/columns-case", r => r.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
  await page.route("**/columns-case.js", r => r.fulfill({ contentType: "text/javascript", body: code }));
  await page.goto("/columns-case");
  const checks = await page.evaluate(async ({ artifact, hash }) => {
    const path = "/columns-case.js";
    const { AotDatabase, MoonImageStore } = await import(path) as typeof Runtime;
    let forceCheckpoint = false, loseAck = false, held = false;
    let release: (() => void) | undefined;
    const openStore = () => MoonImageStore.open("column-replay");
    const open = async () => {
      const raw = await openStore();
      return AotDatabase.withStore(artifact, hash, {
        read: () => raw.read(),
        commit: (expected, image) => raw.commit(expected, image),
        async commitDelta(expected, delta) {
          const generation = await raw.commitDelta(expected, delta);
          if (held) await new Promise<void>(resolve => { release = resolve; });
          if (loseAck) { loseAck = false; throw Error("lost durable ACK"); }
          return generation;
        },
        checkpointNeeded: () => forceCheckpoint || raw.checkpointNeeded(),
        close: () => raw.close(),
      });
    };
    const saved = async () => {
      const store = await openStore();
      try { return await store.read(); } finally { store.close(); }
    };
    const rows = async (db: Awaited<ReturnType<typeof open>>) => (await db.inspect("rows")).rows;
    const log = async (db: Awaited<ReturnType<typeof open>>) => (await db.inspect("log")).rows;
    const blob = Uint8Array.from({ length: 4096 }, (_, i) => i % 256);
    const title = "unmodified-🐕-".repeat(512);
    let db = await open();
    await db.execute("parent");
    await db.execute("seed", [blob, title]);
    forceCheckpoint = true;
    await db.execute("edit", [0n]);
    forceCheckpoint = false;
    held = true;
    let resolved = false;
    const write = db.execute("edit", [1n]).then(() => { resolved = true; });
    while (!release) await new Promise(resolve => setTimeout(resolve, 0));
    let readResolved = false;
    const read = rows(db).then(value => { readResolved = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 0));
    const waitsForAck = !resolved && !readResolved;
    held = false;
    release!();
    await write;
    const first = await read;
    const journal = await saved();
    const core = JSON.parse(JSON.parse(journal.deltas!.at(-1)!.text).core).data;
    const compact = core.format === "sqlike-flush@2" &&
      core.edits.some((edit: unknown[]) => edit[0] === "PatchRow") &&
      journal.deltas!.at(-1)!.text.length < 1024;

    const put = IDBObjectStore.prototype.put;
    let aborted = false;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      const request = put.apply(this, args);
      if (this.name === "delta") this.transaction.abort();
      return request;
    };
    try { await db.execute("edit", [2n]); } catch { aborted = true; }
    finally { IDBObjectStore.prototype.put = put; }
    await db.close();
    db = await open();
    const afterAbort = await rows(db);
    loseAck = true;
    let ackLost = false;
    try { await db.execute("edit", [2n]); } catch { ackLost = true; }
    let poisoned = false;
    try { await rows(db); } catch { poisoned = true; }
    await db.close();
    db = await open();
    const afterAck = await rows(db), logAfterAck = await log(db);
    const stale = await open();
    await db.execute("move");
    let staleRejected = false;
    try { await stale.execute("edit", [9n]); } catch { staleRejected = true; }
    await stale.close();

    await db.execute("begin");
    await db.execute("edit", [3n]);
    await db.execute("savepoint");
    await db.execute("edit", [4n]);
    await db.execute("rollback");
    await db.execute("release");
    await db.execute("commit");
    const beforeCompaction = await log(db);
    for (let i = 0; i < 130; i++) await db.execute("edit", [BigInt(10 + i)]);
    const persisted = await saved();
    await db.close();
    db = await open();
    const after = await rows(db), audit = await log(db);
    await db.execute("edit", [-0]);
    forceCheckpoint = true;
    await db.execute("edit", [-0]);
    forceCheckpoint = false;
    await db.close();
    db = await open();
    const signedZero = Object.is((await rows(db))[0]![2], -0);
    await db.close();
    const intact = (row: typeof first) => row[0]![3] instanceof Uint8Array &&
      (row[0]![3] as Uint8Array).every((value, i) => value === blob[i]) &&
      (row[0]![3] as Uint8Array).length === blob.length && row[0]![4] === title;
    return {
      waitsForAck, compact, aborted, ackLost, poisoned, staleRejected,
      values: [first[0]![2], afterAbort[0]![2], afterAck[0]![2], after[0]![2]],
      parent: after[0]![1],
      logAfterAck: logAfterAck.length,
      beforeCompaction: beforeCompaction.length,
      audit: audit.length,
      bounded: (persisted.deltas?.length ?? 0) < 128,
      intact: [first, afterAbort, afterAck, after].every(intact), signedZero,
    };
  }, { artifact: built.artifact, hash: built.manifest.artifactSHA256 });
  expect(checks).toEqual({
    waitsForAck: true, compact: true, aborted: true, ackLost: true,
    poisoned: true, staleRejected: true, values: [1n, 1n, 2n, 139n],
    parent: 2n, logAfterAck: 3, beforeCompaction: 5, audit: 135,
    bounded: true, intact: true, signedZero: true,
  });
});
