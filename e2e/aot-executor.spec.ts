import { test, expect } from "@playwright/test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSqlikeRuntime } from "../scripts/build-sqlike-runtime.ts";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import { defineSqlike } from "../src/sqlike-features.ts";
import { buildOxcBundle } from "../scripts/oxc-runtime.ts";

test.use({ serviceWorkers: "block" });
const catalog = {
  schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER CHECK(n>0))"],
  queries: [
    { name: "add", sql: "INSERT INTO t VALUES(?,?)" },
    { name: "bad", sql: "INSERT INTO t VALUES(2,2),(3,-1)" },
    { name: "read", sql: "SELECT id,n FROM t ORDER BY id" },
  ],
};
for (const target of ["js", "wasm"] as const) {
  test(`execute-only ${target} runs offline with four exports and atomic rejection`, async ({
    page,
    context,
  }) => {
    test.setTimeout(90000);
    const dir = await mkdtemp(join(tmpdir(), "sqlike-executor-browser-"));
    try {
      const built = await buildSqlikeRuntime(defineSqlike({ mode: "aot" }), {
        catalog,
        outDir: join(dir, "engine"),
        apiCapabilities: [],
        optimizers: [],
        targets: [target === "js" ? "js" : "wasm-gc"],
      });
      expect(built.exports).toHaveLength(4);
      const host = JSON.stringify(resolve("src/sqlike-aot-executor.ts"));
      const entry = join(dir, "entry.ts");
      await writeFile(
        entry,
        target === "js"
          ? `import * as runtime from ${JSON.stringify(join(dir, "engine/runtime.js"))};import {openAotExecutor} from ${host};export function open(program:string){return openAotExecutor(runtime,program)}`
          : `import {openAotExecutor,aotExecutorWasm} from ${host};const {instance}=await WebAssembly.instantiate(await(await fetch('/executor-assets/runtime.wasm')).arrayBuffer(),{},{builtins:['js-string'],importedStringConstants:'_'});export function open(program:string){return openAotExecutor(aotExecutorWasm(instance.exports),program)}`,
      );
      const bundle = await buildOxcBundle(entry);
      const chunks = (Array.isArray(bundle) ? bundle : [bundle]).flatMap((r) =>
        "output" in r ? r.output : [],
      );
      expect(chunks).toHaveLength(1);
      const chunk = chunks[0]!;
      if (chunk.type !== "chunk") throw Error("missing executor JS");
      expect(chunk.imports).toEqual([]);
      expect(chunk.dynamicImports).toEqual([]);
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route("**/executor", (r) =>
        r.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
      );
      await page.route("**/executor-assets/host.js", (r) =>
        r.fulfill({ contentType: "text/javascript", body: chunk.code }),
      );
      if (target === "wasm") {
        const bytes = await readFile(join(dir, "engine/runtime.wasm"));
        await page.route("**/executor-assets/runtime.wasm", (r) =>
          r.fulfill({ contentType: "application/wasm", body: bytes }),
        );
      }
      await page.goto("/executor");
      await page.evaluate(async (program) => {
        const entry = "/executor-assets/host.js";
        const { open } = await import(/* @vite-ignore */ entry);
        (globalThis as any).executor = open(program);
      }, buildCatalog(catalog).artifact);
      await context.setOffline(true);
      const observed = await page.evaluate(() => {
        const db = (globalThis as any).executor;
        db.execute("add", [1n, 9n]);
        let rejected = false;
        try {
          db.execute("bad");
        } catch {
          rejected = true;
        }
        const rows = db.execute("read").rows;
        const hidden = !["dump", "restore", "transaction", "prepare"].some(
          (n) => n in db,
        );
        db.close();
        let closed = false;
        try {
          db.execute("read");
        } catch {
          closed = true;
        }
        return {
          rejected,
          hidden,
          closed,
          rows: rows.map((r: bigint[]) => r.map(String)),
        };
      });
      expect(observed).toEqual({
        rejected: true,
        hidden: true,
        closed: true,
        rows: [["1", "9"]],
      });
      expect(errors).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
