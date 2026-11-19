import assert from "node:assert/strict";
import {
  readFile,
  writeFile,
  mkdir,
  rm,
  readdir,
  copyFile,
  cp,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { build } from "vite";
import { buildSqlikeRuntime } from "./build-sqlike-runtime.ts";
import { viteCompilerIdentity } from "./sqlike-vite-identity.ts";
import {
  baselineSqlike,
  fullSqlike,
  defineSqlike,
  allSqlikeFeatures,
} from "../src/sqlike-features.ts";

const root = process.cwd(),
  exec = promisify(execFile);
const version = JSON.parse(await readFile("package.json", "utf8")).version;
const destination = resolve("generated/npm");
await mkdir(destination, { recursive: true });
// Each JS distribution links one configured engine; never concatenate facade builds.
await buildSqlikeRuntime(baselineSqlike(), {
  outDir: "generated/npm-runtimes/baseline",
  targets: ["js"],
});
await buildSqlikeRuntime(fullSqlike(), {
  outDir: "generated/npm-runtimes/full",
  targets: ["js"],
});
const aotProfile = defineSqlike({
  mode: "aot",
  features: allSqlikeFeatures.filter(
    (f) => !["binarySync", "sqlitePages", "ltx"].includes(f.name),
  ),
});
await buildSqlikeRuntime(aotProfile, {
  outDir: "generated/npm-runtimes/aot",
  targets: ["js"],
});
await buildSqlikeRuntime(aotProfile, {
  outDir: "generated/npm-runtimes/aot-native",
  nativeResults: true,
});
const rawModules = [
  "sqlike/full/full",
  "sqlike/defined/defined",
  "sqlike/defined-sqlite/defined-sqlite",
  "sqlike/compiler/compiler",
  "litestream/litestream",
  "litestream-example/runtime/runtime",
  "sqlike/experimental-aot-typed/experimental-aot-typed",
];
const declarations = new Map<string, string>();
for (const file of await readdir("types")) {
  if (!file.endsWith(".d.ts")) continue;
  const text = await readFile(join("types", file), "utf8");
  // These maintained ABI files use one unindented closing brace per module.
  for (const match of text.matchAll(
    /^declare module "([^"]+)" \{\n([\s\S]*?)^\}/gm,
  )) {
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
  const directory = resolve("npm", name),
    dist = join(directory, "dist");
  const pkg = JSON.parse(
    await readFile(join(directory, "package.json"), "utf8"),
  );
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
    entries[entry] =
      entry === "engine" && name === "litestream"
        ? resolve(`_build/js/release/build/mizchi/${name}/${name}.js`)
        : join(directory, `${entry}.ts`);
  }
  const chunks: Record<string, unknown> = {};
  await build({
    configFile: false,
    publicDir: false,
    logLevel: "silent",
    input: entries,
    plugins: [
      {
        name: "npm-audit",
        generateBundle(_, bundle) {
          for (const [file, chunk] of Object.entries(bundle))
            if (chunk.type === "chunk")
              chunks[file] = {
                imports: chunk.imports,
                dynamicImports: chunk.dynamicImports,
                modules: Object.keys(chunk.modules).map((path) =>
                  path.startsWith(root) ? relative(root, path) : path,
                ),
              };
        },
      },
    ],
    build: {
      ssr: true,
      outDir: dist,
      emptyOutDir: false,
      target: "esnext",
      minify: "oxc",
      rolldownOptions: {
        preserveEntrySignatures: "strict",
        external: (id) =>
          !id.startsWith(".") && !id.startsWith("/") && !id.startsWith("\0"),
        output: {
          format: "es",
          entryFileNames: "[name].js",
          chunkFileNames: "chunks/[name]-[hash].js",
          comments: { annotation: true, legal: true, jsdoc: false },
        },
      },
    },
  });
  const types = join(dist, "types");
  const config = join(destination, `${name}-types.json`);
  await writeFile(
    config,
    JSON.stringify({
      extends: resolve("tsconfig.json"),
      include: [],
      exclude: [],
      files: [
        ...Object.values(entries).filter((path) => path.endsWith(".ts")),
        ...(await readdir("types"))
          .filter((file) => file.endsWith(".d.ts"))
          .map((file) => resolve("types", file)),
      ],
      compilerOptions: {
        noEmit: false,
        declaration: true,
        emitDeclarationOnly: true,
        rewriteRelativeImportExtensions: true,
        rootDir: root,
        outDir: types,
      },
    }),
  );
  try {
    await exec("pnpm", ["exec", "tsc", "--project", config]);
  } catch (error) {
    throw Error((error as { stdout?: string }).stdout ?? String(error));
  }
  const needed = new Set<string>(
    name === "litestream"
      ? [`_build/js/release/build/mizchi/${name}/${name}.js`]
      : [],
  );
  for (const item of await readdir(types, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!item.isFile() || !item.name.endsWith(".d.ts")) continue;
    const file = join(item.parentPath, item.name);
    // TypeScript rewrites JS imports, but preserves source extensions in .d.ts.
    const text = (await readFile(file, "utf8")).replace(
      /(["'])((?:\.\.?\/)[^"']+)\.ts\1/g,
      "$1$2.js$1",
    );
    await writeFile(file, text);
    for (const match of text.matchAll(
      /["']([^"']*(?:_build|generated\/npm-runtimes)\/[^"']+\.js)["']/g,
    ))
      needed.add(relative(types, resolve(dirname(file), match[1]!)));
  }
  for (const path of needed) {
    const text = path.startsWith("generated/npm-runtimes/")
      ? await readFile(path.replace(/\.js$/, ".d.ts"), "utf8")
      : declarations.get(path);
    assert.ok(text, `missing public generated ABI: ${path}`);
    const file = join(types, path.replace(/\.js$/, ".d.ts"));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
  }
  for (const [specifier, mapping] of Object.entries(pkg.exports)) {
    if (!specifier.startsWith("./wasm/")) continue;
    assert.equal(typeof mapping, "string");
    const module =
      name === "litestream"
        ? "litestream/litestream"
        : specifier.endsWith("defined.wasm")
          ? "sqlike/defined/defined"
          : specifier.endsWith("aot.wasm")
            ? "sqlike/aot/aot"
            : specifier.endsWith("full.wasm")
              ? "sqlike/full/full"
              : "sqlike/sqlike";
    const target = join(directory, String(mapping));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(
      `_build/wasm-gc/release/build/mizchi/${module}.wasm`,
      target,
    );
  }
  if (name === "sqlike") {
    // Development-only input for the Vite entry. No generated facades, tests,
    // dependency caches, FTS or experimental LSM are distributed here.
    const sources = join(dist, "build-sources");
    await mkdir(sources, { recursive: true });
    await writeFile(
      join(sources, "compiler-id.json"),
      JSON.stringify({
        format: "sqlike-aot-compiler@1",
        sha256: await viteCompilerIdentity(root),
      }) + "\n",
    );
    for (const module of [
      "packages/sqlike",
      "packages/litestream",
      "examples/aot",
    ]) {
      await mkdir(join(sources, module), { recursive: true });
      await copyFile(
        join(root, module, "moon.mod"),
        join(sources, module, "moon.mod"),
      );
    }
    for (const directory of [
      "packages/sqlike/src/full",
      "packages/litestream/src",
      "examples/aot/src/runtime",
    ])
      await cp(join(root, directory), join(sources, directory), {
        recursive: true,
        filter: (path) => {
          const name = path.split(/[\\/]/).at(-1)!;
          return (
            !name.includes(".") ||
            name === "moon.pkg" ||
            (name.endsWith(".mbt") && !/_w?b?test\.mbt$/.test(name))
          );
        },
      });
  }
  assert.equal(
    await readFile(join(directory, "LICENSE"), "utf8"),
    await readFile("LICENSE", "utf8"),
  );
  await exec("pnpm", ["pack", "--pack-destination", destination], {
    cwd: directory,
  });
  const tarball = join(destination, `mizchi-${name}-${version}.tgz`);
  const { stdout } = await exec("tar", ["-tzf", tarball]);
  const files = stdout
    .trim()
    .split("\n")
    .map((file) => file.replace(/^package\//, ""));
  for (const mapping of Object.values(pkg.exports) as (
    | string
    | { types: string; import: string }
  )[])
    for (const path of typeof mapping === "string"
      ? [mapping]
      : [mapping.types, mapping.import])
      assert.ok(
        files.includes(path.replace(/^\.\//, "")),
        `missing packed export ${path}`,
      );
  reports.push({
    name: pkg.name,
    tarball: relative(root, tarball),
    files,
    chunks,
  });
  console.log(`${pkg.name}@${version}: ${files.length} packed files`);
}
await writeFile(
  join(destination, "audit.json"),
  JSON.stringify({ version, packages: reports }, null, 2) + "\n",
);
