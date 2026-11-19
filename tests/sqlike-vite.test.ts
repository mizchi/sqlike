import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  readdir,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { build, createServer, createLogger } from "vite";
import { chromium, expect } from "@playwright/test";
import { sqlikeAotPlugin } from "../scripts/sqlike-vite.ts";
import type { SqlikeAotBuildInfo } from "../src/sqlike-vite-contract.ts";
import type { SqlikeAotOptions } from "../src/sqlike-vite-contract.ts";

test("Vite AOT rejects invalid configuration and output paths before compilation", () => {
  for (const options of [
    { api: "wasm" },
    { include: "../client/*.sql" },
    { dts: "../unowned.d.ts" },
    { reportFile: "../report.json" },
    { schema: "CREATE TABLE t(id INTEGER)" },
    { primaryKeyIndex: "yes" },
  ])
    assert.throws(() =>
      sqlikeAotPlugin(options as unknown as SqlikeAotOptions, resolve(".")),
    );
});

test("Vite AOT rejects incompatible imports through re-exports, dynamic imports, aliases and externals", async () => {
  const root = await mkdtemp(join(tmpdir(), "sqlike-vite-mixed-"));
  const incompatible = [
    "@mizchi/sqlike",
    "@mizchi/sqlike/full",
    "@mizchi/sqlike/engine",
    "@mizchi/sqlike/runtime",
    "@mizchi/sqlike/compiler",
    "@mizchi/sqlike/defined",
    "@mizchi/sqlike/aot/native",
    "@mizchi/sqlike/wasm/full.wasm",
  ];
  const runBuild = (external = false) =>
    build({
      root,
      configFile: false,
      logLevel: "silent",
      cacheDir: join(root, ".cache"),
      resolve: {
        alias: {
          "@mizchi/sqlike/aot/core": resolve("npm/sqlike/aot-core.ts"),
          "legacy-sql": resolve("npm/sqlike/full.ts"),
        },
      },
      plugins: [
        sqlikeAotPlugin({}, resolve(".")),
        {
          name: "ordinary-runtime-fixture",
          resolveId(id) {
            if (incompatible.includes(id)) return "\0ordinary-runtime";
          },
          load(id) {
            if (id === "\0ordinary-runtime") return "export const value = 1;";
          },
        },
      ],
      build: {
        write: false,
        target: "esnext",
        lib: { entry: "src/main.ts", formats: ["es"] },
        rolldownOptions: {
          external: external ? incompatible : [],
        },
      },
    });
  const aot = "export {openDatabase,queries} from '@mizchi/sqlike/aot';\n";
  try {
    await mkdir(join(root, "src/client"), { recursive: true });
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await writeFile(join(root, "src/client/get.sql"), "SELECT ? AS v;");
    for (const id of incompatible) {
      await writeFile(
        join(root, "src/main.ts"),
        `${aot}export * as legacy from ${JSON.stringify(id)};`,
      );
      await assert.rejects(runBuild(), (error: Error) => {
        assert.match(error.message, /SQLIKE_AOT_MIXED_MODE/);
        assert.ok(error.message.includes(id));
        assert.match(error.message, /main\.ts/);
        return true;
      });
    }
    await writeFile(
      join(root, "src/legacy.ts"),
      "export const load = () => import('@mizchi/sqlike/full');",
    );
    await writeFile(
      join(root, "src/main.ts"),
      `${aot}export {load} from './legacy.ts';`,
    );
    await assert.rejects(runBuild(), /SQLIKE_AOT_MIXED_MODE[\s\S]*legacy\.ts/);
    await writeFile(
      join(root, "src/main.ts"),
      `${aot}export * as legacy from 'legacy-sql';`,
    );
    await assert.rejects(runBuild(), /SQLIKE_AOT_MIXED_MODE/);
    await writeFile(
      join(root, "src/main.ts"),
      `${aot}export const load = () => import('@mizchi/sqlike/full');`,
    );
    await assert.rejects(runBuild(true), /SQLIKE_AOT_MIXED_MODE/);
    await writeFile(
      join(root, "src/main.ts"),
      `${aot}import type {Value} from '@mizchi/sqlike';
export {openAotExecutor} from '@mizchi/sqlike/aot/core';
export const example = "import('@mizchi/sqlike/full')";`,
    );
    await runBuild();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Vite AOT compiles scanned CRUD to a standalone parser-free bundle and expands only when SQL needs JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "sqlike-vite-"));
  const schema = ["CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT)"];
  const outDir = join(root, "dist");
  const runBuild = () =>
    build({
      root,
      configFile: false,
      logLevel: "silent",
      cacheDir: join(root, ".cache"),
      resolve: {
        alias: { "@mizchi/sqlike/aot/core": resolve("npm/sqlike/aot-core.ts") },
      },
      plugins: [
        sqlikeAotPlugin({ schema, include: "src/client/*.sql" }, resolve(".")),
      ],
      build: {
        outDir,
        lib: {
          entry: join(root, "src/main.ts"),
          formats: ["es"],
          fileName: () => "app.js",
        },
        minify: "oxc",
        target: "esnext",
      },
    });
  try {
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await mkdir(join(root, "src/client"), { recursive: true });
    await writeFile(
      join(root, "src/client/notes.sql"),
      "-- name: add\nINSERT INTO t VALUES(?,?);\n-- name: get\nSELECT v FROM t WHERE id=?;",
    );
    await writeFile(
      join(root, "src/main.ts"),
      "export {openDatabase, queries, metadata, runtime} from '@mizchi/sqlike/aot';",
    );
    await runBuild();
    const first = JSON.parse(
      await readFile(join(outDir, "sqlike-aot-report.json"), "utf8"),
    );
    assert.equal(first.exports.length, 4);
    assert.deepEqual(first.queries, ["add", "get"]);
    assert.ok(!first.requirements.features.includes("sqlJson"));
    const app = await import(
      pathToFileURL(join(outDir, "app.js")).href + "?crud"
    );
    const db = app.openDatabase();
    assert.equal(db.execute(app.queries.add, [1n, "hello"]).changes, 1);
    assert.deepEqual(db.execute(app.queries.get, [1n]).rows, [["hello"]]);
    db.close();
    const code = await readFile(join(outDir, "app.js"), "utf8");
    assert.doesNotMatch(
      code,
      /node:sqlite|node:fs|compile_program|parse__statement|database_prepare|sqlike-profile-/,
    );
    const declarations = await readFile(
      join(root, "src/sqlike-aot.generated.d.ts"),
      "utf8",
    );
    assert.match(declarations, /declare module "@mizchi\/sqlike\/aot"/);
    assert.doesNotMatch(declarations, /virtual:sqlike/);
    assert.match(declarations, /"add" \| "get"/);
    const cache = join(root, ".cache/sqlike-aot");
    const before = (await readdir(cache)).sort();
    const engineFile = join(cache, first.engineHash, "runtime.js");
    await writeFile(engineFile, "throw Error('corrupt cache');");
    await runBuild();
    assert.doesNotMatch(await readFile(engineFile, "utf8"), /corrupt cache/);
    assert.equal(
      JSON.parse(await readFile(join(outDir, "sqlike-aot-report.json"), "utf8"))
        .runtimeSHA256,
      first.runtimeSHA256,
    );
    await writeFile(
      join(root, "src/client/notes.sql"),
      "-- name: add\nINSERT INTO t VALUES(?,?);\n-- name: get\nSELECT v||'!' AS v FROM t WHERE id=?;",
    );
    await runBuild();
    const edited = JSON.parse(
      await readFile(join(outDir, "sqlike-aot-report.json"), "utf8"),
    );
    assert.equal(
      edited.engineHash,
      first.engineHash,
      "same capability set must reuse the engine",
    );
    assert.notEqual(edited.fingerprint, first.fingerprint);
    assert.deepEqual((await readdir(cache)).sort(), before);
    await writeFile(
      join(root, "src/client/json.sql"),
      "SELECT json_array(?) AS v;",
    );
    await runBuild();
    const json = JSON.parse(
      await readFile(join(outDir, "sqlike-aot-report.json"), "utf8"),
    );
    assert.ok(json.requirements.features.includes("sqlJson"));
    assert.ok(json.runtimeBytes > first.runtimeBytes);
    assert.notEqual(json.engineHash, first.engineHash);
    const rich = await import(
      pathToFileURL(join(outDir, "app.js")).href + "?json"
    );
    assert.ok(rich.metadata.queries.includes("json"));
    const richDb = rich.openDatabase();
    assert.deepEqual(richDb.execute("json", ["x"]).rows, [['["x"]']]);
    richDb.close();
    const dts = join(root, "src/sqlike-aot.generated.d.ts");
    await writeFile(dts, "declare const userType: unique symbol;");
    await assert.rejects(runBuild(), /refusing to overwrite non-generated/);
    assert.equal(
      await readFile(dts, "utf8"),
      "declare const userType: unique symbol;",
    );
    await rm(dts);
    await writeFile(
      join(root, "src/client/json.sql"),
      "SELECT no_such_sql_function(?)",
    );
    await assert.rejects(
      runBuild(),
      /no_such_sql_function|unknown|unsupported/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "Vite build watch updates both emitted catalog and engine on SQL additions and deletions",
  { timeout: 60_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "sqlike-vite-watch-"));
    let watcher: { close(): Promise<unknown> } | undefined;
    const reports: SqlikeAotBuildInfo[] = [],
      failures: string[] = [];
    try {
      await mkdir(join(root, "src/client"), { recursive: true });
      await writeFile(join(root, "package.json"), '{"type":"module"}');
      await writeFile(join(root, "src/client/get.sql"), "SELECT ? AS v;");
      await writeFile(
        join(root, "src/main.ts"),
        "export {openDatabase,metadata} from '@mizchi/sqlike/aot';",
      );
      const result = await build({
        root,
        configFile: false,
        logLevel: "silent",
        cacheDir: join(root, ".cache"),
        resolve: {
          alias: {
            "@mizchi/sqlike/aot/core": resolve("npm/sqlike/aot-core.ts"),
          },
        },
        plugins: [
          sqlikeAotPlugin({}, resolve(".")),
          {
            name: "observe-build",
            writeBundle(_, bundle) {
              const report = bundle["sqlike-aot-report.json"];
              if (report?.type === "asset")
                reports.push(JSON.parse(String(report.source)));
            },
          },
        ],
        build: {
          watch: {},
          rolldownOptions: { external: ["@mizchi/sqlike/full"] },
          outDir: join(root, "dist"),
          target: "esnext",
          minify: "oxc",
          lib: {
            entry: "src/main.ts",
            formats: ["es"],
            fileName: () => "app.js",
          },
        },
      });
      assert.ok(!Array.isArray(result) && "on" in result);
      watcher = result;
      result.on("event", (event) => {
        if (event.code === "ERROR") failures.push(event.error.message);
      });
      await expect
        .poll(() => reports.length, { timeout: 15_000 })
        .toBeGreaterThan(0);
      const initial = reports.at(-1)!;
      await writeFile(
        join(root, "src/client/json.sql"),
        "SELECT json_array(?) AS v;",
      );
      await expect
        .poll(() => reports.at(-1)?.queries.includes("json"), {
          timeout: 15_000,
        })
        .toBe(true);
      const json = reports.at(-1)!;
      assert.ok(json.runtimeBytes > initial.runtimeBytes);
      const app = await import(
        pathToFileURL(join(root, "dist/app.js")).href + "?watch-json"
      );
      const db = app.openDatabase();
      assert.deepEqual(db.execute("json", ["x"]).rows, [['["x"]']]);
      db.close();
      await rm(join(root, "src/client/json.sql"));
      await expect
        .poll(() => reports.at(-1)?.fingerprint, { timeout: 15_000 })
        .toBe(initial.fingerprint);
      const plain = await import(
        pathToFileURL(join(root, "dist/app.js")).href + "?watch-plain"
      );
      assert.deepEqual(plain.metadata.queries, ["get"]);
      assert.equal(plain.metadata.runtimeBytes, initial.runtimeBytes);
      assert.equal(failures.length, 0);
      const completed = reports.length;
      await writeFile(
        join(root, "src/main.ts"),
        "export {openDatabase,metadata} from '@mizchi/sqlike/aot'; export * as legacy from '@mizchi/sqlike/full';",
      );
      await expect
        .poll(
          () => failures.some((message) => message.includes("SQLIKE_AOT_MIXED_MODE")),
          { timeout: 15_000 },
        )
        .toBe(true);
      assert.equal(
        reports.length,
        completed,
        "mixed runtimes must not be published",
      );
      await writeFile(
        join(root, "src/main.ts"),
        "export {openDatabase,metadata} from '@mizchi/sqlike/aot';",
      );
      await expect
        .poll(() => reports.length, { timeout: 15_000 })
        .toBeGreaterThan(completed);
      assert.equal(reports.at(-1)!.fingerprint, initial.fingerprint);
      assert.equal(failures.length, 1);
    } finally {
      await watcher?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "Vite dev rebuilds changed, added and deleted SQL and recovers from invalid SQL without serving a stale catalog",
  { timeout: 60_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "sqlike-vite-dev-"));
    let server: Awaited<ReturnType<typeof createServer>> | undefined;
    const browser = await chromium.launch();
    const errors: string[] = [];
    const logger = createLogger("silent");
    logger.error = (message) => {
      errors.push(message);
    };
    try {
      await mkdir(join(root, "src/client"), { recursive: true });
      await writeFile(join(root, "package.json"), '{"type":"module"}');
      await writeFile(
        join(root, "index.html"),
        '<script type="module" src="/src/main.ts"></script>',
      );
      const main = join(root, "src/main.ts");
      const mainSource = `import {openDatabase,queries,metadata} from '@mizchi/sqlike/aot';
const db=openDatabase(); window.demo={value:db.execute(queries.get,['x']).rows[0][0],metadata};`;
      await writeFile(main, mainSource);
      const query = join(root, "src/client/get.sql"),
        extra = join(root, "src/client/extra.sql");
      await writeFile(query, "SELECT ? AS v;");
      server = await createServer({
        root,
        configFile: false,
        logLevel: "silent",
        customLogger: logger,
        cacheDir: join(root, ".cache"),
        resolve: {
          alias: {
            "@mizchi/sqlike/aot/core": resolve("npm/sqlike/aot-core.ts"),
          },
        },
        plugins: [sqlikeAotPlugin({}, resolve("."))],
        server: {
          host: "127.0.0.1",
          port: 0,
          fs: { allow: [root, resolve(".")] },
        },
      });
      await server.listen();
      const page = await browser.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await page.goto(server.resolvedUrls!.local[0]!);
      let observed: { value: string; metadata: SqlikeAotBuildInfo } | undefined;
      const inspect = async () => {
        try {
          const value = await page.evaluate(
            () =>
              (
                window as unknown as {
                  demo: {
                    value: string;
                    metadata: import("../src/sqlike-vite-contract.ts").SqlikeAotBuildInfo;
                  };
                }
              ).demo,
          );
          if (value) observed = value;
          return value;
        } catch (error) {
          // Full reload is the plugin's update contract; polling can overlap navigation.
          if (
            /Execution context was destroyed|Cannot find context with specified id/.test(
              (error as Error).message,
            )
          )
            return undefined;
          throw error;
        }
      };
      await expect
        .poll(async () => (await inspect())?.value, { timeout: 15_000 })
        .toBe("x")
        .catch((error) => {
          throw Error(`browser did not initialize: ${errors.join("\n")}`, {
            cause: error,
          });
        });
      const before = observed!.metadata;
      await writeFile(query, "SELECT json_array(?) AS v;");
      await expect
        .poll(async () => (await inspect())?.value, { timeout: 15_000 })
        .toBe('["x"]');
      const rich = observed!.metadata;
      assert.ok(rich.runtimeBytes > before.runtimeBytes);
      assert.ok(rich.requirements.features.includes("sqlJson"));
      await writeFile(extra, "SELECT 2 AS v;");
      await expect
        .poll(
          async () => (await inspect())?.metadata.queries.includes("extra"),
          { timeout: 15_000 },
        )
        .toBe(true);
      await rm(extra);
      await expect
        .poll(
          async () => (await inspect())?.metadata.queries.includes("extra"),
          { timeout: 15_000 },
        )
        .toBe(false);
      await writeFile(query, "SELECT missing_sql_function(?);");
      await page
        .locator("vite-error-overlay")
        .waitFor({ state: "attached", timeout: 10_000 });
      await writeFile(query, "SELECT json_array(?) AS v;");
      await page
        .locator("vite-error-overlay")
        .waitFor({ state: "detached", timeout: 15_000 });
      await expect.poll(async () => (await inspect())?.value).toBe('["x"]');
      assert.equal(observed!.metadata.fingerprint, rich.fingerprint);
      await writeFile(
        join(root, "src/legacy.ts"),
        "export * from '@mizchi/sqlike/full';",
      );
      await writeFile(
        main,
        mainSource + "\nexport * as legacy from './legacy.ts';",
      );
      await expect(page.locator("vite-error-overlay")).toContainText(
        "SQLIKE_AOT_MIXED_MODE",
      );
      await expect(page.locator("vite-error-overlay")).toContainText("legacy.ts");
      await writeFile(main, mainSource);
      await page
        .locator("vite-error-overlay")
        .waitFor({ state: "detached", timeout: 15_000 });
      await expect.poll(async () => (await inspect())?.value).toBe('["x"]');
    } finally {
      await browser.close();
      await server?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
