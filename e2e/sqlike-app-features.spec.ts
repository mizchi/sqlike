import { test, expect } from "@playwright/test";
import { build } from "vite";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import type * as Runtime from "./fixtures/app-features-runtime.ts";
const built = buildCatalog({
  schema: [
    "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER,meta TEXT,created TEXT DEFAULT CURRENT_TIMESTAMP)",
  ],
  queries: [
    { name: "begin", sql: "BEGIN" },
    {
      name: "add",
      sql: "INSERT INTO t(id,n,meta) SELECT ?,?,json_set('{}','$.text',?)",
    },
    { name: "commit", sql: "COMMIT" },
    {
      name: "all",
      sql: "SELECT id,CAST(json_extract(meta,'$.text') AS TEXT),sum(n) OVER(ORDER BY id),date(created) FROM t ORDER BY id",
    },
    {
      name: "recursive",
      sql: "WITH RECURSIVE r(n) AS(VALUES(1) UNION ALL SELECT n+1 FROM r WHERE n<4) SELECT sum(n) FROM r",
    },
  ],
});
let code = "";
test.beforeAll(async () => {
  const bundles = await build({
    configFile: false,
    publicDir: false,
    logLevel: "error",
    build: {
      write: false,
      rolldownOptions: { output: { codeSplitting: false } },
      minify: true,
      target: "esnext",
      lib: { entry: "e2e/fixtures/app-features-runtime.ts", formats: ["es"] },
    },
  });
  for (const b of Array.isArray(bundles) ? bundles : [bundles])
    if ("output" in b)
      for (const item of b.output) if (item.type === "chunk") code += item.code;
});
test("SQL transaction isolation, clock/JSON/window/recursive ASTs and optional search survive IndexedDB reload", async ({
  page,
}) => {
  await page.route("**/app-features-test", (r) =>
    r.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.route("**/app-features-test.js", (r) =>
    r.fulfill({ contentType: "text/javascript", body: code }),
  );
  await page.goto("/app-features-test");
  const abandoned = await page.evaluate(
    async ({ artifact, hash }) => {
      const path = "/app-features-test.js";
      const { AotDatabase, MoonImageStore } = (await import(
        path
      )) as typeof Runtime;
      const open = async () =>
        AotDatabase.withStore(
          artifact,
          hash,
          await MoonImageStore.open("app-features-browser"),
        );
      const db = await open();
      await db.execute("begin");
      await db.execute("add", [1n, 3n, "uncommitted"]);
      const other = await open();
      const count = (await other.execute("all")).rows.length;
      await other.close();
      await db.close();
      return count;
    },
    { artifact: built.artifact, hash: built.manifest.artifactSHA256 },
  );
  expect(abandoned).toBe(0);
  await page.reload();
  const stored = await page.evaluate(
    async ({ artifact, hash }) => {
      const path = "/app-features-test.js";
      const { AotDatabase, MoonImageStore, SearchIndex } = (await import(
        path
      )) as typeof Runtime;
      const db = await AotDatabase.withStore(
        artifact,
        hash,
        await MoonImageStore.open("app-features-browser"),
      );
      const before = (await db.execute("all")).rows.length;
      await db.execute("begin");
      await db.execute("add", [1n, 3n, "one two"]);
      await db.execute("add", [2n, 4n, "three"]);
      await db.execute("commit");
      const rows = (await db.execute("all")).rows;
      const search = new SearchIndex(["text"]);
      search.rebuild(
        rows.map((row) => ({
          rowid: row[0] as bigint,
          fields: [String(row[1])],
        })),
      );
      const ids = search.search("one").map((h) => String(h.rowid));
      const recursive = (await db.execute("recursive")).rows.map((row) =>
        row.map(String),
      );
      const checkpoint = await db.checkpoint();
      await db.close();
      return { before, ids, recursive, created: checkpoint.created };
    },
    { artifact: built.artifact, hash: built.manifest.artifactSHA256 },
  );
  expect(stored).toEqual({
    before: 0,
    ids: ["1"],
    recursive: [["10"]],
    created: true,
  });
  await page.reload();
  const restored = await page.evaluate(
    async ({ artifact, hash }) => {
      const path = "/app-features-test.js";
      const { AotDatabase, MoonImageStore } = (await import(
        path
      )) as typeof Runtime;
      const db = await AotDatabase.withStore(
        artifact,
        hash,
        await MoonImageStore.open("app-features-browser"),
      );
      const rows = (await db.execute("all")).rows.map((row) => row.map(String));
      await db.close();
      return rows;
    },
    { artifact: built.artifact, hash: built.manifest.artifactSHA256 },
  );
  expect(restored.map((r) => r.slice(0, 3))).toEqual([
    ["1", "one two", "3"],
    ["2", "three", "7"],
  ]);
  expect(restored[0]?.[3]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});
