import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, rm, readdir, copyFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { build } from "vite";

const root = process.cwd(), exec = promisify(execFile);
const version = JSON.parse(await readFile("package.json", "utf8")).version;
const destination = resolve("generated/npm");
await mkdir(destination, { recursive: true });
const rawModules = [
  "sqlike/sqlike", "sqlike/defined/defined", "sqlike/defined-sqlite/defined-sqlite",
  "sqlike/compiler/compiler", "litestream/litestream", "litestream-example/runtime/runtime",
];
const declarations = new Map<string, string>();
for (const file of await readdir("types")) {
  if (!file.endsWith(".d.ts")) continue;
  const text = await readFile(join("types", file), "utf8");
  // These maintained ABI files use one unindented closing brace per module.
  for (const match of text.matchAll(/^declare module "([^"]+)" \{\n([\s\S]*?)^\}/gm)) {
    for (const module of rawModules) {
      const path = `_build/js/release/build/mizchi/${module}.js`;
      const pattern = match[1]!;
      if (path.endsWith(pattern.replace(/^\*/, "")))
        declarations.set(path, match[2]!.trim() + "\n");
    }
  }
}
const reports = [];
for (const name of ["sqlike", "litestream"]) {
  const directory = resolve("npm", name), dist = join(directory, "dist");
  const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  assert.equal(pkg.name, `@mizchi/${name}`);
  assert.equal(pkg.version, version);
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.publishConfig.access, "public");
  assert.equal(pkg.repository.url, "git+https://github.com/mizchi/sqlike.git");
  assert.equal(pkg.private, undefined);
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  const entries: Record<string, string> = {};
  for (const specifier of Object.keys(pkg.exports)) {
    const mapping = pkg.exports[specifier];
    if (typeof mapping === "string") continue;
    const entry = mapping.import.replace("./dist/", "").replace(/\.js$/, "");
    entries[entry] = entry === "engine"
      ? resolve(`_build/js/release/build/mizchi/${name}/${name}.js`)
      : join(directory, `${entry}.ts`);
  }
  const chunks: Record<string, unknown> = {};
  await build({
    configFile: false, publicDir: false, logLevel: "silent", input: entries,
    plugins: [{
      name: "npm-audit",
      generateBundle(_, bundle) {
        for (const [file, chunk] of Object.entries(bundle)) if (chunk.type === "chunk")
          chunks[file] = {
            imports: chunk.imports, dynamicImports: chunk.dynamicImports,
            modules: Object.keys(chunk.modules).map((path) => path.startsWith(root) ? relative(root, path) : path),
          };
      },
    }],
    build: {
      ssr: true, outDir: dist, emptyOutDir: false, target: "esnext", minify: "oxc",
      rolldownOptions: {
        preserveEntrySignatures: "strict",
        external: (id) => !id.startsWith(".") && !id.startsWith("/") && !id.startsWith("\0"),
        output: { format: "es", entryFileNames: "[name].js", chunkFileNames: "chunks/[name]-[hash].js", comments: { annotation: true, legal: true, jsdoc: false } },
      },
    },
  });
  const types = join(dist, "types");
  const config = join(destination, `${name}-types.json`);
  await writeFile(config, JSON.stringify({
    extends: resolve("tsconfig.json"), include: [], exclude: [],
    files: [
      ...Object.values(entries).filter((path) => path.endsWith(".ts")),
      ...(await readdir("types")).filter((file) => file.endsWith(".d.ts")).map((file) => resolve("types", file)),
    ],
    compilerOptions: { noEmit: false, declaration: true, emitDeclarationOnly: true,
      rewriteRelativeImportExtensions: true, rootDir: root, outDir: types },
  }));
  try { await exec("pnpm", ["exec", "tsc", "--project", config]); }
  catch (error) { throw Error((error as { stdout?: string }).stdout ?? String(error)); }
  const needed = new Set([`_build/js/release/build/mizchi/${name}/${name}.js`]);
  for (const item of await readdir(types, { recursive: true, withFileTypes: true })) {
    if (!item.isFile() || !item.name.endsWith(".d.ts")) continue;
    const file = join(item.parentPath, item.name);
    // TypeScript rewrites JS imports, but preserves source extensions in .d.ts.
    const text = (await readFile(file, "utf8")).replace(
      /(["'])((?:\.\.?\/)[^"']+)\.ts\1/g, "$1$2.js$1",
    );
    await writeFile(file, text);
    for (const match of text.matchAll(/["']([^"']*_build\/[^"']+\.js)["']/g))
      needed.add(relative(types, resolve(dirname(file), match[1]!)));
  }
  for (const path of needed) {
    const text = declarations.get(path);
    assert.ok(text, `missing public generated ABI: ${path}`);
    const file = join(types, path.replace(/\.js$/, ".d.ts"));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
  }
  for (const [specifier, mapping] of Object.entries(pkg.exports)) {
    if (!specifier.startsWith("./wasm/")) continue;
    assert.equal(typeof mapping, "string");
    const module = name === "litestream" ? "litestream/litestream" : specifier.endsWith("defined.wasm") ? "sqlike/defined/defined" : "sqlike/sqlike";
    const target = join(directory, String(mapping));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(`_build/wasm-gc/release/build/mizchi/${module}.wasm`, target);
  }
  assert.equal(await readFile(join(directory, "LICENSE"), "utf8"), await readFile("LICENSE", "utf8"));
  await exec("pnpm", ["pack", "--pack-destination", destination], { cwd: directory });
  const tarball = join(destination, `mizchi-${name}-${version}.tgz`);
  const { stdout } = await exec("tar", ["-tzf", tarball]);
  const files = stdout.trim().split("\n").map((file) => file.replace(/^package\//, ""));
  for (const mapping of Object.values(pkg.exports) as (string | { types: string; import: string })[])
    for (const path of typeof mapping === "string" ? [mapping] : [mapping.types, mapping.import])
      assert.ok(files.includes(path.replace(/^\.\//, "")), `missing packed export ${path}`);
  reports.push({ name: pkg.name, tarball: relative(root, tarball), files, chunks });
  console.log(`${pkg.name}@${version}: ${files.length} packed files`);
}
await writeFile(join(destination, "audit.json"), JSON.stringify({ version, packages: reports }, null, 2) + "\n");
