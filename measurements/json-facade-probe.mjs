import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import assert from "node:assert/strict";
const exec = promisify(execFile),
  root = process.cwd(),
  work = "/tmp/browser-litestream-json-facade-work";
const library = path.resolve(
  process.argv.slice(2).find((x) => !x.startsWith("--")) || "../x",
);
const { minifyRuntime } = await import(
  pathToFileURL(path.join(root, "scripts/oxc-runtime.ts"))
);
const samples = [
  ["ordinary", '{"id":1,"name":"hello","active":true}'],
  ["int64", '{"n":9223372036854775807}'],
  ["precision", '{"n":9007199254740993}'],
  ["negative-zero", '{"n":-0.0}'],
  ["numeric-keys", '{"2":"two","1":"one"}'],
  ["duplicate-keys", '{"k":1,"k":2}'],
  ["proto-key", '{"__proto__":{"x":1},"constructor":"ok"}'],
  ["escaped-surrogate", '"\\ud800"'],
  ["overflow", '{"n":1e999}'],
  [
    "binding-envelope",
    '[{"t":"integer","v":"9223372036854775807"},{"t":"real","v":-0.0},{"t":"blob","v":[0,255]},{"t":"text","v":"\\ufeffa\\u0000"}]',
  ],
  ["malformed", "[1,]"],
];
const common = `
///|
fn sample() -> Json {
  let rows : Array[Json] = []
  for i in 0..<50 {
    rows.push({"id": i, "name": "item_" + i.to_string(), "score": 3.14159, "active": true, "tags": ["a", "b", "c"]})
  }
  Json::array(rows)
}
///|
let document : Json = sample()
///|
pub fn parse_count(input : String) -> Int32 {
  try {
    let value = @codec.parse(input)
    match value { Array(a) => a.length(); Object(o) => o.length(); _ => 1 }
  } catch { _ => -1 }
}
///|
pub fn valid(input : String) -> Bool { @codec.valid(input) }
`;
if (process.argv.includes("--prepare")) {
  await fs.mkdir(work, { recursive: true });
  await fs.mkdir(path.join(work, "facade/src"), { recursive: true });
  await fs.cp(
    path.join(library, "src/json"),
    path.join(work, "facade/src/json"),
    { recursive: true },
  );
  await fs.writeFile(
    path.join(work, "facade/moon.mod"),
    'name = "mizchi/x"\nversion = "0.7.0"\nsource = "src"\npreferred_target = "js"\n',
  );
  await fs.writeFile(
    path.join(work, "moon.work"),
    'members = ["facade", "probe"]\n',
  );
  await fs.mkdir(path.join(work, "probe"), { recursive: true });
  await fs.writeFile(
    path.join(work, "probe/moon.mod"),
    'name = "mizchi/json-probe"\nversion = "0.0.1"\nsource = "src"\npreferred_target = "js"\nimport { "mizchi/x@0.7.0" }\n',
  );
  for (const backend of ["core", "facade"]) {
    const entry = path.join(work, "probe/src", backend);
    await fs.mkdir(entry, { recursive: true });
    const imports =
      backend === "core"
        ? 'import { "moonbitlang/core/json" @codec }'
        : 'import { "moonbitlang/core/json", "mizchi/x/json" @codec }';
    const serialize = (value) =>
      backend === "core"
        ? `${value}.stringify()`
        : `@codec.stringify(${value})`;
    const source =
      common +
      `\n///|\npub fn roundtrip(input : String) -> String {\ntry { let value = @codec.parse(input)\n${serialize("value")} } catch { e => "ERROR:" + e.to_string() }\n}\n///|\npub fn stringify_sample() -> String { ${serialize("document")} }\n`;
    const special = `
///|
pub fn stringify_special() -> String {
let value : Json = { "zero": Json::number(-0.0, repr="-0.0"), "integer": Json::number(9007199254740992.0, repr="9007199254740993") }
${serialize("value")}
}
`;
    await fs.writeFile(path.join(entry, "probe.mbt"), source + special);
    await fs.writeFile(
      path.join(entry, "moon.pkg"),
      imports +
        '\noptions(link: { "js": { "exports": ["roundtrip", "parse_count", "valid", "stringify_sample", "stringify_special"], "format": "esm" } })\n',
    );
  }
  await exec(
    "moon",
    [
      "build",
      "probe/src/core",
      "probe/src/facade",
      "--target",
      "js",
      "--release",
    ],
    { cwd: work, maxBuffer: 4 * 1024 * 1024 },
  );
  for (const backend of ["core", "facade"]) {
    const entry = path.join(
      work,
      "_build/js/release/build/mizchi/json-probe",
      backend,
      backend + ".js",
    );
    await fs.writeFile(
      path.join(work, backend + ".mjs"),
      await minifyRuntime(entry, [
        "roundtrip",
        "parse_count",
        "valid",
        "stringify_sample",
        "stringify_special",
      ]),
    );
  }
  console.log("Prepared actual mizchi/x/json source in isolated workspace");
  process.exit(0);
}
const codecs = {};
for (const b of ["core", "facade"])
  codecs[b] = await import(pathToFileURL(path.join(work, b + ".mjs")));
const behaviour = samples.map(([name, input]) => ({
  name,
  input,
  core: codecs.core.roundtrip(input),
  facade: codecs.facade.roundtrip(input),
  coreValid: codecs.core.valid(input),
  facadeValid: codecs.facade.valid(input),
}));
behaviour.push({
  name: "explicit-number-repr",
  input: "preconstructed Json::number with repr",
  core: codecs.core.stringify_special(),
  facade: codecs.facade.stringify_special(),
});
for (const row of behaviour) {
  row.matched = row.core === row.facade;
  console.log(JSON.stringify(row));
}
const size = (code) => {
  const b = Buffer.from(code);
  return {
    raw: b.length,
    gzip: gzipSync(b, { level: 9 }).length,
    brotli: brotliCompressSync(b, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).length,
  };
};
const sizes = {};
for (const b of ["core", "facade"])
  sizes[b] = size(await fs.readFile(path.join(work, b + ".mjs")));
const texts = {
  small: samples.find((x) => x[0] === "binding-envelope")[1],
  large: codecs.core.stringify_sample(),
};
const times = [];
for (const workload of ["small", "large"])
  for (const operation of ["parse_count", "valid", "stringify_sample"]) {
    const expected =
      operation === "stringify_sample"
        ? undefined
        : codecs.core[operation](texts[workload]);
    for (const backend of ["core", "facade"])
      for (let i = 0; i < 1000; i++)
        codecs[backend][operation](texts[workload]);
    const iterations = operation === "stringify_sample" ? 1000 : 5000;
    for (let run = 0; run < 8; run++)
      for (const backend of run % 2 ? ["facade", "core"] : ["core", "facade"]) {
        const start = performance.now();
        let value;
        for (let i = 0; i < iterations; i++)
          value = codecs[backend][operation](texts[workload]);
        const us = ((performance.now() - start) * 1000) / iterations;
        if (expected !== undefined) assert.equal(value, expected);
        times.push({ workload, operation, backend, run, microseconds: us });
      }
  }
const median = (a) => {
  a = [...a].sort((x, y) => x - y);
  return (a[(a.length - 1) >> 1] + a[a.length >> 1]) / 2;
};
const summary = [];
for (const workload of ["small", "large"])
  for (const operation of ["parse_count", "valid", "stringify_sample"])
    for (const backend of ["core", "facade"])
      summary.push({
        workload,
        operation,
        backend,
        microseconds: median(
          times
            .filter(
              (x) =>
                x.workload === workload &&
                x.operation === operation &&
                x.backend === backend,
            )
            .map((x) => x.microseconds),
        ),
      });
const sourceHashes = {};
for (const file of [
  "json.mbt",
  "json_js.mbt",
  "json_default.mbt",
  "moon.pkg",
]) {
  const p = path.join(library, "src/json", file);
  sourceHashes[p] = createHash("sha256")
    .update(await fs.readFile(p))
    .digest("hex");
}
const report = {
  measuredAt: new Date().toISOString(),
  node: process.version,
  library,
  commit: (
    await exec("git", ["rev-parse", "HEAD"], { cwd: library })
  ).stdout.trim(),
  method:
    "Isolated copy of actual mizchi/x/json development checkout, same public probe API, Oxc minify retaining exports. Standalone JSON codec microbenchmark, not a SQL/runtime size or query benchmark. Parse_count materializes full Json tree then observes container length. Stringify_sample serializes the same prebuilt 50-object Json value; small/large labels do not change this serialize fixture. Eight alternating runs after warmup. Full roundtrip differences are semantic blockers for blanket replacement.",
  sourceHashes,
  sizes,
  behaviour,
  summary,
  times,
};
sourceHashes["measurements/json-facade-probe.mjs"] = createHash("sha256")
  .update(await fs.readFile("measurements/json-facade-probe.mjs"))
  .digest("hex");
sourceHashes["scripts/oxc-runtime.ts"] = createHash("sha256")
  .update(await fs.readFile("scripts/oxc-runtime.ts"))
  .digest("hex");
await fs.writeFile(
  path.join(root, "measurements/json-facade-probe-current.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify({ sizes, summary }));
