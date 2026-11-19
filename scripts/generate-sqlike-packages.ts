import assert from "node:assert/strict";
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  runtimeDeclarations,
  nativeAotDeclarations,
} from "./sqlike-runtime-declarations.ts";
import {
  buildGraph,
  baselineRoots,
  dependencyClosure,
  constantsForSelection,
} from "../src/sqlike-build-graph.ts";
export const canonicalEngine = "packages/sqlike/src/full";
const api = JSON.parse(
  await readFile("src/sqlike-public-api.json", "utf8"),
) as {
  fullFunctions: string[];
  fullTypes: string[];
  traits: string[];
  sqlExports: string[];
  baselineExports: string[];
  aotExports: string[];
};
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const all = dependencyClosure(
  buildGraph.nodes
    .filter(
      (n) =>
        n.kind !== "implementation" &&
        !["feature/ltx", "feature/sqlitePages", "feature/binarySync"].includes(
          n.id,
        ),
    )
    .map((n) => n.id),
);
export function formatMoon(text: string, kind = "mbt") {
  // A regular input descriptor also supplies EOF reliably on Node/macOS when
  // large generated sources would otherwise stall in the child stdin pipe.
  const directory = mkdtempSync(join(tmpdir(), "sqlike-moonfmt-"));
  let input: number | undefined;
  try {
    const path = join(directory, "input");
    writeFileSync(path, text);
    input = openSync(path, "r");
    return execFileSync("moonfmt", ["-", "-file-type", kind], {
      stdio: [input, "pipe", "pipe"],
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30_000,
    });
  } finally {
    if (input !== undefined) closeSync(input);
    rmSync(directory, { recursive: true, force: true });
  }
}
export async function engineSource(
  constants: Record<string, boolean>,
  kind: "baseline" | "aot" = "aot",
  exports?: readonly string[],
) {
  const files = (await readdir(canonicalEngine))
    .filter((n) => n.endsWith(".mbt") && !/_w?b?test\.mbt$/.test(n))
    .sort();
  const allowed = new Set(
    exports ?? (kind === "baseline" ? api.baselineExports : api.aotExports),
  );
  const typedStatements =
    kind === "baseline" || allowed.has("aot_prepare_values");
  const methods =
    kind === "baseline"
      ? new Set([
          "Connection::open",
          "Connection::prepare",
          "Connection::close",
          "Connection::changes",
          "Connection::set_clock",
        ])
      : new Set(
          typedStatements
            ? [
                "Connection::from_program",
                "Connection::prepare_compiled",
                "Connection::close",
                "Connection::changes",
                "Connection::set_clock",
                "Program::load",
                "Program::load_binary",
                "Program::query",
              ]
            : [],
        );
  const chunks = [];
  for (const file of files) {
    let text = await readFile(join(canonicalEngine, file), "utf8");
    for (const [name, on] of Object.entries(constants))
      text = text.replace(
        new RegExp(`const ${name} : Bool = (?:true|false)`, `g`),
        `const ${name} : Bool = ${on}`,
      );
    text = text.replace(
      "const CAP_CATALOG_SPECIALIZED : Bool = false",
      "const CAP_CATALOG_SPECIALIZED : Bool = true",
    );
    text = text.replace(
      /pub fn(\[[^\]]+\])? ([A-Za-z_][A-Za-z_0-9:]*)/g,
      (whole, generic, name) =>
        allowed.has(name) ||
        methods.has(name) ||
        (typedStatements && name.startsWith("Statement::"))
          ? whole
          : `fn${generic ?? ""} ${name}`,
    );
    text = text.replace(
      "pub struct AotNativeResult",
      "priv struct AotNativeResult",
    );
    if (kind === "aot")
      text = text
        .replace(
          "fn Connection::prepare(",
          "fn Connection::prepare_sql_internal(",
        )
        .replace(
          "fn Connection::open(",
          "fn Connection::open_memory_internal(",
        );
    chunks.push(`// Source: ${file}\n${text}`);
  }
  if (kind === "aot" && typedStatements)
    chunks.push(`///|\npub fn Connection::prepare(self : Connection, name : String) -> Statement raise SqliteError {
    self.healthy()
    guard self.program is Some(program) else { raise sqlite_misuse("AOT requires a Program") }
    self.prepare_compiled(program.query(name))
  }
  ///|\npub fn Connection::open(artifact : String) -> Connection raise SqliteError { Connection::from_program(Program::load(artifact)) }\n`);
  const text = chunks.join("\n");
  return formatMoon(
    `// Generated from canonical full engine; do not edit.\n// Source SHA256: ${digest(text)}\n\n${text}`,
  );
}
export async function packageConfig(exports: string[], full = false) {
  const pkg = await readFile(join(canonicalEngine, "moon.pkg"), "utf8");
  const imports = pkg.match(/^import \{[\s\S]*?^\}/m)?.[0];
  assert.ok(imports, "missing canonical imports");
  return formatMoon(
    imports +
      (full ? '\nimport { "moonbitlang/core/bench" } for "wbtest"\n' : "\n") +
      `\nwarnings = "${full ? "-79" : "-1-2-4-7-79"}"\noptions(link: { "js": { "exports": ${JSON.stringify(exports)}, "format": "esm" }, "wasm-gc": { "exports": ${JSON.stringify(exports)}, "use-js-builtin-string": true, "imported-string-constants": "_" } })\n`,
    "pkg",
  );
}
export async function generateSqlikePackages(check = false) {
  const output = new Map<string, string>();
  for (const [kind, dir, roots, exports] of [
    ["baseline", "packages/sqlike/src", baselineRoots(), api.baselineExports],
    [
      "aot",
      "packages/sqlike/src/aot",
      all.filter((n) => n !== "feature/binarySync"),
      api.aotExports,
    ],
  ] as const) {
    output.set(
      `${dir}/engine.mbt`,
      await engineSource(constantsForSelection(dependencyClosure(roots)), kind),
    );
    output.set(`${dir}/moon.pkg`, await packageConfig(exports));
  }
  // Full is canonical source, not a second generated implementation.
  const fullPkg = await packageConfig(api.sqlExports, true);
  output.set(`${canonicalEngine}/moon.pkg`, fullPkg);
  for (const [name, exports] of [
    ["baseline", api.baselineExports],
    ["full", api.sqlExports],
    ["aot", api.aotExports],
  ] as const)
    output.set(
      `generated/npm-runtimes/${name}/runtime.d.ts`,
      runtimeDeclarations(exports),
    );
  output.set(
    "generated/npm-runtimes/aot-native/runtime.d.ts",
    nativeAotDeclarations(),
  );
  for (const [path, text] of output) {
    if (check) {
      if (!path.startsWith("generated/"))
        assert.equal(
          await readFile(path, "utf8"),
          text,
          `stale generated package ${path}`,
        );
    } else {
      await mkdir(resolve(path, ".."), { recursive: true });
      await writeFile(path, text);
    }
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await generateSqlikePackages(process.argv.includes("--check"));
