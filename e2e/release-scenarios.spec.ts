import { test, expect } from "@playwright/test";
import { build } from "vite";
import { writeFileSync, rmSync } from "node:fs";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import { releaseSchema } from "../tests/compatibility/release-scenarios.ts";
import type * as Runtime from "./fixtures/release-runtime.ts";
import { sourceHashes } from "../scripts/measurement-manifest.ts";
test.afterAll(() => {
  for (const path of [
    "dist/release-case.html",
    "dist/release-case.js",
    "dist/release-sw.js",
  ])
    rmSync(path, { force: true });
});
const built = buildCatalog({
  schema: releaseSchema,
  queries: [
    { name: "tenant", sql: "INSERT INTO tenants(tenant) VALUES('a')" },
    {
      name: "add",
      sql: "INSERT INTO tasks(id,tenant,title,score,payload) VALUES(?,'a',?,?,?)",
    },
    { name: "rename", sql: "UPDATE tasks SET title=? WHERE id=?" },
    {
      name: "list",
      sql: "SELECT id,title,typeof(score),score,hex(payload) FROM tasks ORDER BY id",
    },
    { name: "audit", sql: "SELECT task_id,event,title FROM audit ORDER BY id" },
    { name: "totals", sql: "SELECT tenant,total FROM tenants ORDER BY tenant" },
  ],
});
test("U08: combined indexed/trigger/FK application survives real IDB abort, stale writer, lost ACK and offline reload", async ({
  page,
  context,
}) => {
  const output = await build({
    configFile: false,
    publicDir: false,
    logLevel: "error",
    build: {
      write: false,
      rolldownOptions: { output: { codeSplitting: false } },
      minify: true,
      target: "esnext",
      lib: { entry: "e2e/fixtures/release-runtime.ts", formats: ["es"] },
    },
  });
  let code = "";
  for (const o of Array.isArray(output) ? output : [output])
    if ("output" in o)
      for (const c of o.output) if (c.type === "chunk") code += c.code;
  writeFileSync(
    "dist/release-case.html",
    "<!doctype html><title>release acceptance</title>",
  );
  writeFileSync("dist/release-case.js", code);
  writeFileSync(
    "dist/release-sw.js",
    `self.addEventListener('install',e=>e.waitUntil(caches.open('release').then(c=>c.addAll(['/release-case.html','/release-case.js'])).then(()=>self.skipWaiting())));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',e=>e.respondWith(caches.match(e.request,{ignoreVary:true}).then(r=>r||fetch(e.request))));`,
  );
  await page.goto("/release-case.html");
  const initial = await page.evaluate(
    async ({ artifact, hash }) => {
      const path = "/release-case.js";
      const { AotDatabase, MoonImageStore } = (await import(
        path
      )) as typeof Runtime;
      const open = async () =>
        AotDatabase.withStore(
          artifact,
          hash,
          await MoonImageStore.open("release-acceptance"),
        );
      let db = await open();
      await db.execute("tenant");
      await db.execute("add", [1n, "one", 1, new Uint8Array([0, 255])]);
      const stale = await open();
      await db.execute("rename", ["winner", 1n]);
      let staleRejected = false;
      try {
        await stale.execute("rename", ["stale", 1n]);
      } catch {
        staleRejected = true;
      }
      await stale.close();
      // Abort a real IDB transaction after writes have been queued.
      const put = IDBObjectStore.prototype.put;
      let aborted = false;
      IDBObjectStore.prototype.put = function (
        ...args: Parameters<IDBObjectStore["put"]>
      ) {
        const q = put.apply(this, args);
        if (!aborted && this.transaction.mode === "readwrite") {
          aborted = true;
          this.transaction.abort();
        }
        return q;
      };
      let abortRejected = false;
      try {
        await db.execute("add", [2n, "aborted", 2n, null]);
      } catch {
        abortRejected = true;
      } finally {
        IDBObjectStore.prototype.put = put;
      }
      await db.close();
      db = await open();
      const afterAbort = (await db.inspect("list")).rows;
      const raw = await MoonImageStore.open("release-acceptance");
      let loseAck = true;
      const fault: Runtime.ImageStore = {
        read: () => raw.read(),
        close: () => raw.close(),
        checkpointNeeded: () => raw.checkpointNeeded(),
        commit: async (g, s) => {
          const next = await raw.commit(g, s);
          if (loseAck) {
            loseAck = false;
            throw Error("ACK lost");
          }
          return next;
        },
        commitDelta: async (g, d) => {
          const next = await raw.commitDelta(g, d);
          if (loseAck) {
            loseAck = false;
            throw Error("ACK lost");
          }
          return next;
        },
      };
      await db.close();
      const uncertain = await AotDatabase.withStore(artifact, hash, fault);
      let ackRejected = false;
      try {
        await uncertain.execute("add", [2n, "committed", 2.5, null]);
      } catch {
        ackRejected = true;
      }
      await uncertain.close();
      db = await open();
      const rows = (await db.inspect("list")).rows,
        audit = (await db.inspect("audit")).rows,
        totals = (await db.inspect("totals")).rows;
      await db.checkpoint();
      await db.close();
      await navigator.serviceWorker.register("/release-sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      return {
        staleRejected,
        aborted,
        abortRejected,
        ackRejected,
        afterAbort,
        rows,
        audit,
        totals,
      };
    },
    { artifact: built.artifact, hash: built.manifest.artifactSHA256 },
  );
  expect(
    initial.staleRejected &&
      initial.aborted &&
      initial.abortRejected &&
      initial.ackRejected,
  ).toBe(true);
  expect(initial.afterAbort).toEqual([[1n, "winner", "real", 1, "00FF"]]);
  expect(initial.rows).toEqual([
    [1n, "winner", "real", 1, "00FF"],
    [2n, "committed", "real", 2.5, ""],
  ]);
  expect(initial.audit).toEqual([
    [1n, "insert", "one"],
    [1n, "update", "winner"],
    [2n, "insert", "committed"],
  ]);
  expect(initial.totals).toEqual([["a", 2n]]);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await context.setOffline(true);
  await page.reload();
  const restored = await page.evaluate(
    async ({ artifact, hash }) => {
      const path = "/release-case.js";
      const { AotDatabase, MoonImageStore } = (await import(
        path
      )) as typeof Runtime;
      const db = await AotDatabase.withStore(
        artifact,
        hash,
        await MoonImageStore.open("release-acceptance"),
      );
      await db.execute("rename", ["offline", 2n]);
      const rows = (await db.inspect("list")).rows,
        audit = (await db.inspect("audit")).rows;
      await db.close();
      return { rows, audit };
    },
    { artifact: built.artifact, hash: built.manifest.artifactSHA256 },
  );
  expect(restored.rows[1]![1]).toBe("offline");
  expect(restored.audit).toHaveLength(4);
  writeFileSync(
    "measurements/release-scenarios-browser.json",
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        sourceHashes: sourceHashes([
          "e2e/release-scenarios.spec.ts",
          "e2e/fixtures/release-runtime.ts",
          "tests/compatibility/release-scenarios.ts",
          "adapters/aot-database.ts",
          "adapters/moon-image-store.ts",
          "_build/js/release/build/mizchi/litestream-example/runtime/runtime.js",
        ]),
        scenario: "U08",
        programSHA256: built.manifest.artifactSHA256,
        checks: [
          "strict IDB abort",
          "stale writer",
          "commit ACK lost",
          "trigger exactly once",
          "REAL storage class",
          "offline cached reload",
          "offline durable edit",
        ],
      },
      null,
      2,
    ) + "\n",
  );
});
