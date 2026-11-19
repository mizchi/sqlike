import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  stat,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

test(
  "packed Vite plugin replaces the AOT entry with typed prepared/image APIs and preserves the prebuilt entry without the plugin",
  { timeout: 120_000 },
  async () => {
    const audit = JSON.parse(
      await readFile("generated/npm/audit.json", "utf8"),
    );
    const pkg = audit.packages.find(
      (p: { name: string }) => p.name === "@mizchi/sqlike",
    );
    assert.ok(pkg.files.includes("dist/vite.js"));
    assert.ok(
      pkg.files.includes(
        "dist/build-sources/packages/sqlike/src/full/parser.mbt",
      ),
    );
    const root = await mkdtemp(join(tmpdir(), "sqlike-vite-consumer-"));
    const run = (command: string, args: string[]) =>
      execFileSync(command, args, {
        cwd: root,
        encoding: "utf8",
        stdio: "pipe",
        timeout: 90_000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, npm_config_userconfig: "/dev/null" },
      });
    try {
      await mkdir(join(root, "src/client"), { recursive: true });
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          private: true,
          type: "module",
          dependencies: {
            "@mizchi/sqlike": `file:${resolve(pkg.tarball)}`,
            vite: JSON.parse(
              await readFile("node_modules/vite/package.json", "utf8"),
            ).version,
          },
        }),
      );
      run("pnpm", ["install", "--ignore-scripts", "--lockfile=false"]);
      run(process.execPath, [
        "--input-type=module",
        "-e",
        "import assert from 'node:assert/strict'; import {openAotDatabase} from '@mizchi/sqlike/aot'; assert.equal(typeof openAotDatabase, 'function');",
      ]);
      await writeFile(
        join(root, "src/schema.sql"),
        "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER);",
      );
      await writeFile(
        join(root, "src/client/item.sql"),
        "-- name: add\nINSERT INTO t VALUES(?,?);\n-- name: get\nSELECT n FROM t WHERE id=?;\n-- name: set\nUPDATE t SET n=? WHERE id=?;",
      );
      await writeFile(
        join(root, "src/main.ts"),
        `import {openDatabase,queries,metadata} from '@mizchi/sqlike/aot';
import type {Value} from '@mizchi/sqlike';
export {metadata};
// @ts-expect-error the plugin replaces the prebuilt entry with a catalog-bound API
type Prebuilt = typeof import('@mizchi/sqlike/aot').openAotDatabase;
export function smoke(){
 const value:Value=3n;
 const db=openDatabase('',{clock:()=>0}); db.execute(queries.add,[1n,value]);
 const q=db.prepare(queries.get); const before=q.get([1n]); const image=db.dump();
 db.execute(queries.set,[7n,1n]); db.restore(image);
 try{db.transaction(()=>{db.execute(queries.set,[9n,1n]);throw Error('rollback');})}catch(e){if((e as Error).message!=='rollback')throw e;}
 const after=q.get([1n]); q.finalize(); db.close(); return {before,after};
}
if(false){const db=openDatabase();
// @ts-expect-error unknown catalog query must not typecheck
db.execute('not_in_catalog');}
`,
      );
      await writeFile(
        join(root, "vite.config.mjs"),
        `import {sqlikeAot} from '@mizchi/sqlike/vite';
export default {plugins:[sqlikeAot({schemaFiles:'src/schema.sql',api:'connection'})],build:{lib:{entry:'src/main.ts',formats:['es'],fileName:()=> 'app.js'},target:'esnext'}};`,
      );
      run(process.execPath, [
        join(root, "node_modules/vite/bin/vite.js"),
        "build",
      ]);
      const app = await import(pathToFileURL(join(root, "dist/app.js")).href);
      assert.deepEqual(app.smoke(), { before: [3n], after: [3n] });
      assert.equal(app.metadata.api, "connection");
      assert.equal(app.metadata.exports.length, 12);
      run(process.execPath, [
        resolve("node_modules/typescript/bin/tsc"),
        "--noEmit",
        "--strict",
        "--module",
        "nodenext",
        "--moduleResolution",
        "nodenext",
        "--target",
        "esnext",
        "src/main.ts",
        "src/sqlike-aot.generated.d.ts",
      ]);
      const code = await readFile(join(root, "dist/app.js"), "utf8");
      assert.doesNotMatch(
        code,
        /node:sqlite|node:fs|compile_program|parse__statement|\.mbt/,
      );
      const report = JSON.parse(
        await readFile(join(root, "dist/sqlike-aot-report.json"), "utf8"),
      );
      assert.equal(report.runtimeSHA256, app.metadata.runtimeSHA256);
      const engine = join(
        root,
        "node_modules/.vite/sqlike-aot",
        report.engineHash,
        "runtime.js",
      );
      const stamp = (await stat(engine)).mtimeMs;
      run(process.execPath, [
        join(root, "node_modules/vite/bin/vite.js"),
        "build",
      ]);
      const repeated = JSON.parse(
        await readFile(join(root, "dist/sqlike-aot-report.json"), "utf8"),
      );
      assert.equal(repeated.engineHash, report.engineHash);
      assert.equal(
        (await stat(engine)).mtimeMs,
        stamp,
        "separate Vite processes must reuse a verified engine cache",
      );
      await writeFile(
        join(root, "src/main.ts"),
        "export {openDatabase} from '@mizchi/sqlike/aot'; export * as legacy from 'legacy-sql';",
      );
      await writeFile(
        join(root, "vite.config.mjs"),
        `import {sqlikeAot} from '@mizchi/sqlike/vite';
export default {plugins:[sqlikeAot({schemaFiles:'src/schema.sql'})],resolve:{alias:{'legacy-sql':${JSON.stringify(join(root, "node_modules/@mizchi/sqlike/dist/full.js"))}}},build:{lib:{entry:'src/main.ts',formats:['es']},target:'esnext'}};`,
      );
      assert.throws(
        () => run(process.execPath, [
          join(root, "node_modules/vite/bin/vite.js"), "build",
        ]),
        /SQLIKE_AOT_MIXED_MODE/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
