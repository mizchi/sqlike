import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { brotliCompressSync, constants } from "node:zlib";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { buildSqlikeRuntime } from "./build-sqlike-runtime.ts";
import { buildCatalog } from "./aot-compiler.ts";
import { defineSqlike, primaryKeyIndex } from "../src/sqlike-features.ts";
import {
  openAotExecutor,
  aotExecutorWasm,
} from "../src/sqlike-aot-executor.ts";
import { buildOxcBundle } from "./oxc-runtime.ts";
import {
  engineSourcePaths,
  sourceHashes,
  fileHash,
} from "./measurement-manifest.ts";

const catalog = {
  schema: ["CREATE TABLE item(id INTEGER PRIMARY KEY,title TEXT,n INTEGER)"],
  queries: [
    { name: "create", sql: "INSERT INTO item VALUES(?,?,?)" },
    { name: "read", sql: "SELECT id,title,n FROM item WHERE id=?" },
    { name: "update", sql: "UPDATE item SET title=?,n=? WHERE id=?" },
    { name: "delete", sql: "DELETE FROM item WHERE id=?" },
  ],
};
const program = buildCatalog(catalog).artifact;
const indexed = defineSqlike({ mode: "aot", features: [primaryKeyIndex] });
const profiles = [
  { name: "crud", profile: indexed, options: {} },
  { name: "crud-no-optimizers", profile: indexed, options: { optimizers: [] } },
  {
    name: "crud-minimal",
    profile: defineSqlike({ mode: "aot" }),
    options: { optimizers: [] },
  },
  {
    name: "crud-no-delta",
    profile: defineSqlike({ mode: "aot" }),
    options: {
      optimizers: [],
      apiCapabilities: ["prepared", "snapshot", "transaction"],
    },
  },
  {
    name: "crud-chunks",
    profile: defineSqlike({ mode: "aot" }),
    options: {
      optimizers: [],
      apiCapabilities: ["prepared", "snapshotChunks", "transaction", "delta"],
    },
  },
  {
    name: "crud-incremental",
    profile: defineSqlike({ mode: "aot" }),
    options: {
      optimizers: [],
      apiCapabilities: [
        "prepared",
        "snapshotIncremental",
        "transaction",
        "delta",
      ],
    },
  },
  ...(
    [
      [],
      ["prepared"],
      ["snapshot"],
      ["snapshotChunks"],
      ["snapshotIncremental"],
      ["transaction"],
      ["delta"],
    ] as const
  ).map((apiCapabilities) => ({
    name: `crud-executor${apiCapabilities.length ? `-${apiCapabilities[0]}` : ""}`,
    profile: defineSqlike({ mode: "aot" }),
    options: { optimizers: [], apiCapabilities },
  })),
] as const;
const rows = [];
for (const { name, profile, options } of profiles) {
  const directory = join("generated/crud-sizes", name);
  const built = await buildSqlikeRuntime(profile, {
    outDir: directory,
    catalog,
    ...options,
  });
  const js = await import(
    pathToFileURL(join(process.cwd(), directory, "runtime.js")).href
  );
  const wasm = (
    await WebAssembly.instantiate(
      await readFile(join(directory, "runtime.wasm")),
      {},
      {
        builtins: ["js-string"],
        importedStringConstants: "_",
      },
    )
  ).instance.exports;
  for (const runtime of [js, aotExecutorWasm(wasm)]) {
    const db = openAotExecutor(runtime, program);
    const oracle = new DatabaseSync(":memory:");
    try {
      oracle.exec(catalog.schema[0]!);
      const read = oracle.prepare(catalog.queries[1]!.sql);
      read.setReadBigInts(true);
      read.setReturnArrays(true);
      const id = 9007199254740993n;
      db.execute("create", [id, "hello", 1n]);
      oracle.prepare(catalog.queries[0]!.sql).run(id, "hello", 1n);
      assert.deepEqual(db.execute("read", [id]).rows, read.all(id));
      db.execute("update", ["changed", 2n, id]);
      oracle.prepare(catalog.queries[2]!.sql).run("changed", 2n, id);
      assert.deepEqual(db.execute("read", [id]).rows, read.all(id));
      db.execute("delete", [id]);
      oracle.prepare(catalog.queries[3]!.sql).run(id);
      assert.deepEqual(db.execute("read", [id]).rows, read.all(id));
    } finally {
      db.close();
      oracle.close();
    }
  }
  const files = [];
  for (const target of ["js", "wasm"]) {
    const path = join(directory, `runtime.${target}`),
      bytes = await readFile(path);
    files.push({
      target,
      bytes: bytes.length,
      brotli: brotliCompressSync(bytes, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
      }).length,
      sha256: fileHash(path),
    });
  }
  async function measureHost(module: string, fn: string, filename: string) {
    const host = relative(resolve(directory), resolve(module)).replaceAll(
      "\\",
      "/",
    );
    const entry = join(directory, filename + ".ts");
    await writeFile(
      entry,
      `import * as runtime from './runtime.js';import {${fn}} from '${host}';export function open(program:string){return ${fn}(runtime,program)}\n`,
    );
    const result = await buildOxcBundle(resolve(entry));
    const chunks = (Array.isArray(result) ? result : [result]).flatMap((r) =>
      "output" in r ? r.output : [],
    );
    assert.equal(chunks.length, 1);
    const chunk = chunks[0]!;
    assert.ok(chunk.type === "chunk");
    assert.deepEqual(chunk.imports, []);
    assert.deepEqual(chunk.dynamicImports, []);
    const path = join(directory, filename + ".js");
    await writeFile(path, chunk.code);
    const bundled = await import(pathToFileURL(resolve(path)).href);
    const connection = bundled.open(program);
    connection.execute("create", [1n, "bundled", 2n]);
    assert.deepEqual(connection.execute("read", [1n]).rows, [
      [1n, "bundled", 2n],
    ]);
    if (fn === "openPortableCompiled") {
      const image = connection.dump();
      assert.throws(
        () =>
          connection.transaction(() => {
            connection.execute("create", [2n, "undo", 3n]);
            throw Error("rollback");
          }),
        /rollback/,
      );
      assert.deepEqual(connection.execute("read", [2n]).rows, []);
      connection.execute("update", ["changed", 9n, 1n]);
      connection.restore(image);
      assert.deepEqual(connection.execute("read", [1n]).rows, [
        [1n, "bundled", 2n],
      ]);
    }
    connection.close();
    const bytes = Buffer.from(chunk.code);
    return {
      bytes: bytes.length,
      brotli: brotliCompressSync(bytes, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
      }).length,
      sha256: fileHash(path),
    };
  }
  const hostBundle = await measureHost(
    "src/sqlike-aot-executor.ts",
    "openAotExecutor",
    "host",
  );
  const portableHostBundle = (
    ["prepared", "snapshot", "transaction"] as const
  ).every((c) => built.plan.apiCapabilities.includes(c))
    ? await measureHost(
        "src/sqlike-portable-aot.ts",
        "openPortableCompiled",
        "portable-host",
      )
    : undefined;
  rows.push({
    name,
    features: built.profile.features,
    exports: built.exports,
    plan: built.plan,
    files,
    hostBundle,
    ...(portableHostBundle ? { portableHostBundle } : {}),
  });
}
await mkdir("measurements", { recursive: true });
await writeFile(
  "measurements/sqlike-crud-size-current.json",
  JSON.stringify(
    {
      format: "sqlike-crud-sizes@1",
      measuredAt: new Date().toISOString(),
      node: process.version,
      moon: execFileSync("moon", ["version"], { encoding: "utf8" }).trim(),
      scope:
        "Four named AOT CRUD statements, no RETURNING/JOIN/aggregate/FK/STRICT/JSON/date/window/CTE. Files are engine only: release Wasm GC and OXC-minified JS; Brotli quality 11. hostBundle separately measures standalone JS engine plus execute-only host; portableHostBundle includes the full portable host where supported. Both exclude catalog. Standard profiles retain 15 exports; other profiles select optional API capabilities. Independent removals are not additive.",
      verification:
        "INSERT/read/UPDATE/read/DELETE/read matched native SQLite, including int64 rowid, on JS and Wasm for each profile.",
      catalog,
      catalogBytes: Buffer.byteLength(program),
      rows,
      sources: sourceHashes([
        ...engineSourcePaths(),
        "scripts/measure-crud-size.ts",
        "scripts/aot-compiler.ts",
        "scripts/build-sqlike-runtime.ts",
        "scripts/oxc-runtime.ts",
        "src/sqlike-build-graph.json",
        "src/sqlike-build-plan.ts",
        "src/sqlike-features.ts",
        "src/sqlike-portable-aot.ts",
        "src/sqlike-aot-executor.ts",
      ]),
    },
    null,
    2,
  ) + "\n",
);
console.table(
  rows.flatMap((r) =>
    r.files.map((f) => ({
      profile: r.name,
      target: f.target,
      KiB: (f.bytes / 1024).toFixed(2),
      BrotliKiB: (f.brotli / 1024).toFixed(2),
    })),
  ),
);
