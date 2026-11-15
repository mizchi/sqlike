import { test, expect } from "@playwright/test";
import { build } from "vite";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildSqlikeRuntime } from "../scripts/build-sqlike-runtime.ts";
import { defineSqlike, primaryKeyIndex } from "../src/sqlike-features.ts";
import type * as Runtime from "./fixtures/defined-runtime.ts";
import { sourceHashes } from "../scripts/measurement-manifest.ts";
for (const selected of [false, true]) {
  test(`binary DDL + named statements ${selected ? "without JSON/date/window" : "with all features"} work in Chromium IDB through rollback, stale writes and offline restart`, async ({
    page,
    context,
  }) => {
    const directory = resolve("generated/optional-browser");
    if (selected)
      await buildSqlikeRuntime(
        defineSqlike({ mode: "defined", features: [primaryKeyIndex] }),
        { outDir: directory, targets: ["js"] },
      );
    const result = await build({
      configFile: false,
      publicDir: false,
      logLevel: "error",
      base: "/defined/",
      plugins: selected
        ? [
            {
              name: "selected-defined-engine",
              enforce: "pre",
              resolveId(source) {
                if (source.endsWith("/defined/defined.js"))
                  return resolve(directory, "runtime.js");
              },
            },
          ]
        : [],
      build: {
        write: false,
        target: "esnext",
        minify: true,
        lib: { entry: "e2e/fixtures/defined-runtime.ts", formats: ["es"] },
      },
    });
    const assets = new Map<string, string | Uint8Array>();
    for (const output of Array.isArray(result) ? result : [result])
      if ("output" in output)
        for (const f of output.output) {
          if (selected && f.type === "chunk") {
            expect(f.code).not.toMatch(
              /datetime__call|json__call|compute__windows|parse__statement/,
            );
            expect(
              Object.keys(f.modules).some((p) =>
                p.endsWith("/defined/defined.js"),
              ),
            ).toBe(false);
          }
          assets.set(
            `/defined/${f.fileName}`,
            f.type === "chunk" ? f.code : f.source,
          );
        }
    assets.set(
      "/defined/index.html",
      "<!doctype html><title>Defined database</title>",
    );
    const entry =
      [...assets.keys()].find((f) => f.endsWith("defined-runtime.js")) ??
      [...assets.keys()].find(
        (f) => f.endsWith(".js") && !f.includes("assets/"),
      )!;
    const requests: string[] = [];
    await context.route("**/defined/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      requests.push(path);
      if (path === "/defined/sw.js")
        return route.fulfill({
          contentType: "text/javascript",
          body: `self.addEventListener('install',e=>e.waitUntil(caches.open('defined').then(c=>c.addAll(${JSON.stringify([...assets.keys()])})).then(()=>self.skipWaiting())));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',e=>e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request))));`,
        });
      const body = assets.get(path);
      return body === undefined
        ? route.abort()
        : route.fulfill({
            contentType: path.endsWith(".html")
              ? "text/html"
              : "text/javascript",
            body: typeof body === "string" ? body : Buffer.from(body),
          });
    });
    await page.goto("/defined/index.html");
    await page.evaluate(async () => {
      await navigator.serviceWorker.register("/defined/sw.js");
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller)
        await new Promise<void>((resolve) =>
          navigator.serviceWorker.addEventListener(
            "controllerchange",
            () => resolve(),
            { once: true },
          ),
        );
    });
    const first = await page.evaluate(async (entry) => {
      const { DefinedDatabase, catalog } = (await import(
        entry
      )) as typeof Runtime;
      let db = await DefinedDatabase.open("binary-notes", catalog);
      const stale = await DefinedDatabase.open("binary-notes", catalog);
      await db.prepare("add").execute([9007199254740993n, "\ufeffone\0", 1n]);
      let staleError = "",
        unknownError = "";
      try {
        await stale.execute("add", [2n, "stale", 2n]);
      } catch (e) {
        staleError = (e as Error).message;
      }
      await stale.close();
      try {
        await db.execute("SELECT * FROM notes");
      } catch (e) {
        unknownError = (e as Error).message;
      }
      const before = await db.prepare("list").all();
      await db.close();
      db = await DefinedDatabase.open("binary-notes", catalog);
      await db.execute("edit", ["changed", 9n, 9007199254740993n]);
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (
        ...args: Parameters<typeof put>
      ) {
        const request = put.apply(this, args);
        if (this.name === "delta") this.transaction.abort();
        return request;
      };
      let abortError = "";
      try {
        await db.execute("edit", ["aborted", 99n, 9007199254740993n]);
      } catch (e) {
        abortError = (e as Error).message;
      } finally {
        IDBObjectStore.prototype.put = put;
      }
      await db.close();
      db = await DefinedDatabase.open("binary-notes", catalog);
      const after = await db.prepare("get").get([9007199254740993n]);
      await db.close();
      return { before, after, staleError, unknownError, abortError };
    }, entry);
    expect(first.before).toEqual([[9007199254740993n, "\ufeffone\0", 1n]]);
    expect(first.after).toEqual([9007199254740993n, "changed", 9n]);
    expect(first.staleError).toMatch(/stale|another/i);
    expect(first.unknownError).toMatch(/query|statement/i);
    expect(first.abortError).not.toBe("");
    await context.setOffline(true);
    await page.reload();
    const reopened = await page.evaluate(async (entry) => {
      const { DefinedDatabase, catalog } = (await import(
        entry
      )) as typeof Runtime;
      const db = await DefinedDatabase.open("binary-notes", catalog);
      try {
        return await db.prepare("list").all();
      } finally {
        await db.close();
      }
    }, entry);
    expect(reopened).toEqual([[9007199254740993n, "changed", 9n]]);
    expect(
      requests.some((p) => /sqlite3|turso|compiler|defined-sqlite/.test(p)),
    ).toBe(false);
    writeFileSync(
      selected
        ? "measurements/optional-functions-browser-current.json"
        : "measurements/defined-browser-current.json",
      JSON.stringify(
        {
          measuredAt: new Date().toISOString(),
          sourceHashes: sourceHashes([
            "adapters/defined-database.ts",
            "adapters/defined-database-core.ts",
            "src/defined-contract.ts",
            "e2e/defined.spec.ts",
            "e2e/fixtures/defined-runtime.ts",
            "examples/notes/defined.generated.ts",
            ...(selected
              ? [
                  "scripts/build-sqlike-runtime.ts",
                  "scripts/oxc-runtime.ts",
                  "src/sqlike-features.ts",
                  "generated/optional-browser/runtime.js",
                  "generated/optional-browser/profile.json",
                ]
              : ["_build/js/release/build/mizchi/sqlike/defined/defined.js"]),
          ]),
          profile: selected
            ? "primaryKeyIndex only; JSON/date/window disabled"
            : "all execution features",
          offlineReopen: true,
          staleRejected: true,
          namedStatementsOnly: true,
          verified: true,
        },
        null,
        2,
      ) + "\n",
    );
  });
}
