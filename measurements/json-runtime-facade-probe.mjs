import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const exec = promisify(execFile),
  root = process.cwd(),
  work = "/tmp/browser-litestream-json-runtime-work";
const library = path.resolve(process.argv[2] || "../x");
const imp = (p) => import(pathToFileURL(path.resolve(p)));
const { buildSqlikeRuntime } = await imp("scripts/build-sqlike-runtime.ts");
const { defineSqlike, primaryKeyIndex } = await imp("src/sqlike-features.ts");
const { minifyRuntime } = await imp("scripts/oxc-runtime.ts");
const compiler = await imp(
  "_build/js/release/build/mizchi/sqlike/compiler/compiler.js",
);
const { aotBindings, aotValue } = await imp("src/aot-values.ts");
const exports = JSON.parse(
  await fs.readFile(
    "generated/optional-functions/notes-minimal/profile.json",
    "utf8",
  ),
).exports;
await fs.mkdir(path.join(work, "packages"), { recursive: true });
for (const p of ["sqlike", "litestream"])
  await fs.cp(path.join(root, "packages", p), path.join(work, "packages", p), {
    recursive: true,
  });
await fs.mkdir(path.join(work, "examples"), { recursive: true });
await fs.cp("examples/aot", path.join(work, "examples/aot"), {
  recursive: true,
});
await fs.writeFile(
  path.join(work, "moon.work"),
  'members = ["packages/sqlike", "packages/litestream", "examples/aot"]\n',
);
const flags = [
  "OUTER_JOIN",
  "STRICT",
  "PRIMARY_INDEX",
  "TRIGGERS",
  "FOREIGN_KEYS",
  "BINARY_SYNC",
  "SQL_JSON",
  "DATETIME",
  "WINDOWS",
];
await fs.writeFile(
  path.join(work, "packages/sqlike/src/feature_config.mbt"),
  flags
    .map((f) => `const FEATURE_${f} : Bool = ${f === "PRIMARY_INDEX"}\n`)
    .join(""),
);
const target = path.join(work, "packages/sqlike/src/vendor/json");
await fs.mkdir(target, { recursive: true });
await fs.cp(path.join(library, "src/json"), target, { recursive: true });
const pkg = path.join(work, "packages/sqlike/src/moon.pkg");
await fs.writeFile(
  pkg,
  (await fs.readFile(pkg, "utf8")).replace(
    "import {",
    'import {\n  "mizchi/sqlike/vendor/json" @fastjson,',
  ),
);
const aot = path.join(work, "packages/sqlike/src/aot.mbt");
const originalAot = await fs.readFile(aot, "utf8");
assert.equal(
  originalAot.split("@json.from_json(@json.parse(bindings))").length,
  2,
  "binding parser changed",
);
await fs.writeFile(
  aot,
  originalAot.replace(
    "@json.from_json(@json.parse(bindings))",
    "@json.from_json(@fastjson.parse(bindings))",
  ),
);
await exec(
  "moon",
  ["build", "packages/sqlike/src/defined", "--target", "js", "--release"],
  { cwd: work, maxBuffer: 4 * 1024 * 1024 },
);
const variant = path.join(root, "generated/json-runtime-facade.mjs");
await fs.writeFile(
  variant,
  await minifyRuntime(
    path.join(work, "_build/js/release/build/mizchi/sqlike/defined/defined.js"),
    exports,
  ),
);
const baselinePath = path.join(root, "generated/json-runtime-core");
await buildSqlikeRuntime(
  defineSqlike({ mode: "defined", features: [primaryKeyIndex] }),
  { outDir: baselinePath, targets: ["js"] },
);
const codecs = {
  core: await imp(path.join(baselinePath, "runtime.js")),
  facade: await imp(variant),
};
const source = {
  schema: [],
  queries: [{ name: "q", sql: "SELECT ? AS id,? AS n,? AS text,? AS blob" }],
};
const artifact = compiler.compile_program(JSON.stringify(source));
assert.equal(JSON.parse(artifact).error, undefined);
const packed = compiler.pack_program_binary(artifact);
assert.equal(JSON.parse(compiler.binary_catalog_info(packed)).error, undefined);
const def = [
  compiler.binary_catalog_schema(packed),
  compiler.binary_catalog_statements(packed),
  new Uint8Array(),
];
const dbs = {};
for (const b of ["core", "facade"]) {
  dbs[b] = codecs[b].defined_open(...def);
  assert.equal(JSON.parse(codecs[b].defined_info(dbs[b])).error, undefined);
}
const params = aotBindings([
  9007199254740993n,
  -0,
  "\ufeffhello\0",
  new Uint8Array([0, 255, 0]),
]);
const execute = (b, bindings = params) =>
  JSON.parse(codecs[b].defined_execute(dbs[b], "q", bindings));
assert.deepEqual(execute("facade"), execute("core"));
const malformed = JSON.stringify([
  { t: "integer", v: "1" },
  { t: "real", v: 1 },
  { t: "text", v: "\ud800" },
  { t: "blob", v: [] },
]);
const behaviour = [
  { name: "typed-bindings", matched: true },
  {
    name: "lone-surrogate",
    core: execute("core", malformed),
    facade: execute("facade", malformed),
  },
];
const before = [];
for (const b of ["core", "facade"]) for (let i = 0; i < 1000; i++) execute(b);
for (let run = 0; run < 8; run++)
  for (const backend of run % 2 ? ["facade", "core"] : ["core", "facade"]) {
    const start = performance.now();
    let value;
    for (let i = 0; i < 5000; i++)
      value = codecs[backend].defined_execute(dbs[backend], "q", params);
    const us = ((performance.now() - start) * 1000) / 5000;
    assert.equal(JSON.parse(value).rows.length, 1);
    before.push({ backend, run, microseconds: us });
  }
const median = (a) => {
  a = [...a].sort((x, y) => x - y);
  return (a[3] + a[4]) / 2;
};
const summary = Object.fromEntries(
  ["core", "facade"].map((b) => [
    b,
    median(before.filter((x) => x.backend === b).map((x) => x.microseconds)),
  ]),
);
const sizes = {};
for (const b of ["core", "facade"]) {
  const p = b === "core" ? path.join(baselinePath, "runtime.js") : variant;
  const bytes = await fs.readFile(p);
  sizes[b] = {
    raw: bytes.length,
    gzip: gzipSync(bytes, { level: 9 }).length,
    brotli: brotliCompressSync(bytes, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).length,
    SHA256: createHash("sha256").update(bytes).digest("hex"),
  };
}
const sourceHashes = {};
for (const p of [
  "measurements/json-runtime-facade-probe.mjs",
  "scripts/build-sqlike-runtime.ts",
  "scripts/oxc-runtime.ts",
  "packages/sqlike/src/aot.mbt",
  "packages/sqlike/src/model.mbt",
  ...["json.mbt", "json_js.mbt", "json_default.mbt", "moon.pkg"].map((f) =>
    path.join(library, "src/json", f),
  ),
])
  sourceHashes[p] = createHash("sha256")
    .update(await fs.readFile(p))
    .digest("hex");
const report = {
  sourceHashes,
  library,
  commit: (
    await exec("git", ["rev-parse", "HEAD"], { cwd: library })
  ).stdout.trim(),
  measuredAt: new Date().toISOString(),
  node: process.version,
  method:
    "Transient workspace, actual copied mizchi/x/json code from the recorded checkout and source hashes. Only aot_execute binding parse replaced, no serializer/SQL JSON/schema/snapshot change. Same defined entry exports, primaryKeyIndex only, Oxc with annotations preserved. Eight alternating warmed Node runs, 5000 executions each; host bind encoding and output JSON.parse excluded from timing. No production source/dependency changes. Lone-surrogate response mismatch prevents blanket default adoption.",
  sizes,
  summary,
  samples: before,
  behaviour,
};
await fs.writeFile(
  "measurements/json-runtime-facade-probe-current.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report));
