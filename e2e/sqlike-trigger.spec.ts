import { test, expect } from "@playwright/test";
import { build } from "vite";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import type * as Runtime from "./fixtures/aot-trigger-runtime.ts";
let code = "";
const built = buildCatalog({
  schema: [
    "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)",
    "CREATE TABLE audit(id INTEGER PRIMARY KEY,row_id INTEGER,n INTEGER)",
    "CREATE TRIGGER ai AFTER INSERT ON t BEGIN INSERT INTO audit(row_id,n) VALUES(new.id,new.n); END",
  ],
  queries: [
    { name: "add", sql: "INSERT INTO t VALUES(?,?)" },
    { name: "log", sql: "SELECT row_id,n FROM audit ORDER BY id" },
  ],
});
test.beforeAll(async () => {
  const built = await build({
    configFile: false,
    publicDir: false,
    logLevel: "error",
    build: {
      write: false,
      rolldownOptions: { output: { codeSplitting: false } },
      minify: true,
      target: "esnext",
      lib: { entry: "e2e/fixtures/aot-trigger-runtime.ts", formats: ["es"] },
    },
  });
  for (const output of Array.isArray(built) ? built : [built])
    if ("output" in output)
      for (const item of output.output)
        if (item.type === "chunk") code += item.code;
});
test("IndexedDB row journal and checkpoint preserve trigger effects exactly once across abort and page reload", async ({
  page,
}) => {
  await page.route("**/aot-trigger-test", (r) =>
    r.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.route("**/aot-trigger-test.js", (r) =>
    r.fulfill({ contentType: "text/javascript", body: code }),
  );
  await page.goto("/aot-trigger-test");
  const initial = await page.evaluate(
    async ({ artifact, hash }) => {
      const path = "/aot-trigger-test.js",
        { AotDatabase, MoonImageStore } = (await import(
          path
        )) as typeof Runtime;
      const open = async () =>
        AotDatabase.withStore(
          artifact,
          hash,
          await MoonImageStore.open("trigger-browser"),
        );
      let db = await open();
      await db.execute("add", [1n, 2n]);
      await db.close();
      db = await open();
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (
        ...args: Parameters<typeof put>
      ) {
        put.apply(this, args);
        throw Error("abort trigger publication");
      };
      let aborted = false;
      try {
        await db.execute("add", [2n, 3n]);
      } catch {
        aborted = true;
      } finally {
        IDBObjectStore.prototype.put = put;
      }
      await db.close();
      db = await open();
      const before = (await db.inspect("log")).rows.map((row) =>
        row.map(String),
      );
      await db.execute("add", [2n, 3n]);
      await db.checkpoint();
      await db.close();
      return { aborted, before };
    },
    { artifact: built.artifact, hash: built.manifest.artifactSHA256 },
  );
  expect(initial).toEqual({ aborted: true, before: [["1", "2"]] });
  await page.reload();
  expect(
    await page.evaluate(
      async ({ artifact, hash }) => {
        const path = "/aot-trigger-test.js",
          { AotDatabase, MoonImageStore } = (await import(
            path
          )) as typeof Runtime;
        const db = await AotDatabase.withStore(
          artifact,
          hash,
          await MoonImageStore.open("trigger-browser"),
        );
        try {
          return (await db.inspect("log")).rows.map((row) => row.map(String));
        } finally {
          await db.close();
        }
      },
      { artifact: built.artifact, hash: built.manifest.artifactSHA256 },
    ),
  ).toEqual([
    ["1", "2"],
    ["2", "3"],
  ]);
});
