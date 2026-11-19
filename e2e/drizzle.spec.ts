import { test, expect } from "@playwright/test";
import { build } from "vite";
import { writeFileSync } from "node:fs";
import { sourceHashes } from "../scripts/measurement-manifest.ts";

test("Drizzle Kit migrations and RETURNING persist through IndexedDB Worker reopen and offline reload", async ({
  page,
  context,
}) => {
  const output = await build({
    configFile: false,
    publicDir: false,
    logLevel: "error",
    base: "/drizzle/",
    worker: { format: "es" },
    build: {
      write: false,
      target: "esnext",
      minify: true,
      rolldownOptions: {
        input: "e2e/fixtures/drizzle-worker.ts",
        output: { entryFileNames: "runtime.js" },
      },
    },
  });
  const assets = new Map<string, string | Uint8Array>();
  for (const bundle of Array.isArray(output) ? output : [output])
    if ("output" in bundle)
      for (const file of bundle.output)
        assets.set(
          `/drizzle/${file.fileName}`,
          file.type === "chunk" ? file.code : file.source,
        );
  assets.set(
    "/drizzle/index.html",
    "<!doctype html><title>Drizzle migration test</title>",
  );
  const paths = [...assets.keys()];
  const headers = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
  };
  await context.route("**/drizzle/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/drizzle/sw.js")
      return route.fulfill({
        contentType: "text/javascript",
        body: `self.addEventListener('install',e=>e.waitUntil(caches.open('drizzle').then(c=>c.addAll(${JSON.stringify(paths)})).then(()=>self.skipWaiting())));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',e=>e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request))));`,
      });
    const body = assets.get(path);
    return body === undefined
      ? route.abort()
      : route.fulfill({
          headers,
          contentType: path.endsWith(".html") ? "text/html" : "text/javascript",
          body: typeof body === "string" ? body : Buffer.from(body),
        });
  });
  await page.goto("/drizzle/index.html");
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/drizzle/sw.js");
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
  const run = (reopen: boolean) =>
    page.evaluate(
      (reopen) =>
        new Promise<any>((resolve, reject) => {
          const worker = new Worker("/drizzle/runtime.js", { type: "module" });
          worker.onerror = (event) => {
            worker.terminate();
            reject(Error(event.message));
          };
          worker.onmessage = (event) => {
            worker.terminate();
            event.data.error
              ? reject(Error(event.data.error))
              : resolve(event.data.result);
          };
          worker.postMessage({ reopen });
        }),
      reopen,
    );
  const first = await run(false);
  expect(first).toEqual({
    inserted: { id: 2, name: "two", email: "two@example.test", score: 1.5 },
    updated: { id: 2, name: "TWO", score: 2.5 },
    deleted: [{ id: 2 }],
    rows: [{ id: 1, name: "one", score: 2 }],
    children: [[7n, 1n, "kept child"]],
    fk: [],
  });
  await context.setOffline(true);
  await page.reload();
  const reopened = await run(true);
  expect(reopened).toEqual({
    applied: 0,
    rows: [{ id: 1, name: "one", score: 2 }],
    children: [[7n, 1n, "kept child"]],
    audit: [[2n, "insert"]],
    log: [[8n]],
    fk: [],
  });
  writeFileSync(
    "measurements/drizzle-browser-current.json",
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        sourceHashes: sourceHashes([
          "package.json",
          "pnpm-lock.yaml",
          "adapters/drizzle.ts",
          "adapters/drizzle-migrator.ts",
          "src/migration-statements.ts",
          "adapters/moon-database.ts",
          "e2e/drizzle.spec.ts",
          "e2e/fixtures/drizzle-worker.ts",
          "tests/fixtures/drizzle/migrations.generated.ts",
          "_build/js/release/build/mizchi/sqlike/full/full.js",
        ]),
        migrations: 8,
        kitGenerated: 6,
        custom: 2,
        offlineReopen: true,
        foreignKeyChildrenPreserved: true,
        verified: true,
      },
      null,
      2,
    ) + "\n",
  );
});
