import {
  cp,
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  rm,
  copyFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  defineSqlike,
  baselineSqlike,
  fullSqlike,
  type SqlikeProfile,
} from "../src/sqlike-features.ts";
import {
  runtimeDeclarations,
  nativeAotDeclarations,
  sqlitePagerExports,
} from "./sqlike-runtime-declarations.ts";
import { minifyRuntime } from "./oxc-runtime.ts";
import { createBuildStage, publishBuildStage } from "./build-staging.ts";
import {
  catalogFunctionConstants,
  catalogExpressionConstants,
  catalogStatementConstants,
  catalogQueryConstants,
} from "../src/catalog-capabilities.ts";
import type { CatalogSource } from "../src/aot-contract.ts";
import type { CatalogRequirements } from "../src/catalog-requirements-contract.ts";
import {
  selectedAotExports,
  type SqlikeOptimizer,
  type AotApiCapability,
} from "../src/sqlike-build-graph.ts";
import {
  createBuildPlan,
  catalogHasSecondaryIndexes,
} from "../src/sqlike-build-plan.ts";
const exec = promisify(execFile),
  root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sql = [
  "database_open",
  "database_autocommit",
  "database_set_clock",
  "database_exec",
  "database_prepare",
  "database_prepared_exec",
  "database_query_values",
  "database_exec_values",
  "database_dump",
  "database_restore",
  "database_version",
  "database_is_readonly",
  "database_clone",
  "database_copy_connection_state",
  "database_delta",
  "database_ack_delta",
  "database_apply_delta",
  "database_serial",
];
/** Compile in isolation: no edits to the source workspace or its build cache.
 * Constants let MoonBit remove disabled implementations in both JS and Wasm.
 * AOT exports never root the SQL lexer/parser. JS remains an ESM module. */
export async function buildSqlikeRuntime(
  input: SqlikeProfile,
  {
    outDir,
    nativeResults = false,
    targets = nativeResults ? ["js"] : ["js", "wasm-gc"],
    minify = true,
    catalog: catalogInput,
    optimizers,
    apiCapabilities,
    sourceRoot = root,
  }: {
    outDir: string;
    /** AOT-only JS native bindings/results; separate from the default JSON ABI. */
    nativeResults?: boolean;
    targets?: readonly ("js" | "wasm-gc")[];
    minify?: boolean;
    /** Infer semantic features and trim function/statement implementations from typed IR. */
    catalog?: CatalogSource;
    /** Optional execution shortcuts, independent of SQL semantic features. */
    optimizers?: readonly SqlikeOptimizer[];
    /** Optional public portable AOT APIs; execution is always included. */
    apiCapabilities?: readonly AotApiCapability[];
    /** Build-time MoonBit assets, including the source-only assets shipped with the Vite entry. */
    sourceRoot?: string;
  },
) {
  if (typeof nativeResults !== "boolean")
    throw Error("nativeResults must be a boolean");
  if (nativeResults && apiCapabilities !== undefined)
    throw Error(
      "API capability selection requires portable AOT; nativeResults keeps its existing ABI",
    );
  if (
    !targets.length ||
    new Set(targets).size !== targets.length ||
    targets.some((t) => t !== "js" && t !== "wasm-gc")
  )
    throw Error("targets must be a non-empty unique JS/Wasm GC list");
  if (
    nativeResults &&
    (input.mode !== "aot" || targets.some((t) => t !== "js"))
  )
    throw Error("nativeResults requires the AOT JS target");
  if (
    nativeResults &&
    input.features.some((f) => ["ltx", "sqlitePages", "binarySync"].includes(f))
  )
    throw Error(
      "experimental native AOT does not expose SQLite/LTX/binary sync exports",
    );
  if (catalogInput !== undefined && input.mode === "sql")
    throw Error("catalog specialization requires aot or defined");
  const catalog =
    catalogInput === undefined ? undefined : structuredClone(catalogInput);
  const requirements: CatalogRequirements | undefined =
    catalog !== undefined
      ? (await import("./analyze-catalog.ts")).analyzeCatalogRequirements(
          catalog,
        )
      : undefined;
  const profile = defineSqlike({
    mode: input.mode,
    features: [...input.features, ...(requirements?.features ?? [])].map(
      (name) => ({ name }),
    ),
  });
  let hasSecondaryIndexes = true;
  if (catalog) {
    const built = (await import("./aot-compiler.ts")).buildCatalog(catalog);
    const schema = JSON.parse(built.artifact).schema;
    hasSecondaryIndexes = catalogHasSecondaryIndexes(schema);
  }
  const plan = createBuildPlan(
    { ...profile, ...(input.preset ? { preset: input.preset } : {}) },
    {
      requirements,
      hasSecondaryIndexes,
      optimizers,
      apiCapabilities,
      apiBackend: nativeResults ? "native" : "portable",
    },
  );
  const { constants } = plan;
  const preset = input.preset;
  const work = await mkdtemp(join(tmpdir(), "sqlike-profile-"));
  const destination = resolve(outDir),
    output = await createBuildStage(destination);
  try {
    await writeFile(join(output, "package.json"), '{"type":"module"}\n');
    await mkdir(join(work, "packages"), { recursive: true });
    for (const p of ["sqlike", "litestream"])
      await cp(join(sourceRoot, "packages", p), join(work, "packages", p), {
        recursive: true,
        filter: (s) => !s.includes("/_build/") && !s.includes("/.mooncakes/"),
      });
    await mkdir(join(work, "examples"), { recursive: true });
    await cp(join(sourceRoot, "examples/aot"), join(work, "examples/aot"), {
      recursive: true,
    });
    await writeFile(
      join(work, "moon.work"),
      'members = ["packages/sqlike", "packages/litestream", "examples/aot"]\n',
    );
    await writeFile(
      join(work, "packages/sqlike/src/full/feature_config.mbt"),
      Object.entries(constants)
        .filter(([name]) => name.startsWith("FEATURE_"))
        .map(([name, on]) => `const ${name} : Bool = ${on}\n`)
        .join(""),
    );
    await writeFile(
      join(work, "packages/sqlike/src/full/optimizer_config.mbt"),
      Object.entries(constants)
        .filter(([name]) => name.startsWith("OPT_"))
        .map(([name, value]) => `const ${name} : Bool = ${value}\n`)
        .join(""),
    );
    await writeFile(
      join(work, "packages/sqlike/src/full/api_config.mbt"),
      `const CAP_API_SNAPSHOT : Bool = ${constants.CAP_API_SNAPSHOT}\n`,
    );
    {
      const configPath = join(
        work,
        "packages/sqlike/src/full/capability_config_generated.mbt",
      );
      let code = await readFile(configPath, "utf8");
      const replace = (name: string, value: boolean) => {
        const pattern = new RegExp(`const ${name} : Bool = (?:true|false)`);
        if (!pattern.test(code))
          throw Error(`missing catalog capability constant ${name}`);
        code = code.replace(pattern, `const ${name} : Bool = ${value}`);
      };
      replace(
        "CAP_CATALOG_SPECIALIZED",
        !!requirements || preset === "baseline",
      );
      for (const constant of [
        ...Object.values(catalogFunctionConstants),
        ...Object.values(catalogExpressionConstants),
        ...Object.values(catalogStatementConstants),
        ...Object.values(catalogQueryConstants),
      ]) {
        if (typeof constants[constant] !== "boolean")
          throw Error(`missing build capability constant ${constant}`);
        replace(constant, constants[constant]);
      }
      await writeFile(configPath, code);
    }
    const definedEntry = "packages/sqlike/src/defined";
    const definedPkg =
      profile.mode === "defined"
        ? await readFile(join(work, definedEntry, "moon.pkg"), "utf8")
        : "";
    // moon.pkg is MoonBit's DSL: moon fmt adds trailing commas to arrays.
    // Export names are identifiers, so read quoted names rather than JSON.
    const exportBlock = definedPkg.match(/"exports":\s*(\[[^\]]+\])/)?.[1];
    if (profile.mode === "defined" && !exportBlock)
      throw Error("missing defined runtime exports");
    const defined = [
      ...(exportBlock ?? "").matchAll(/"([a-z_][a-z_0-9]*)"/g),
    ].map((m) => m[1]!);
    const requestedExports = [
      ...(nativeResults
        ? selectedAotExports(plan.selected, "native")
        : profile.mode === "defined"
          ? defined
          : profile.mode === "aot"
            ? selectedAotExports(plan.selected)
            : sql),
    ];
    if (profile.features.includes("binarySync"))
      requestedExports.push("database_changeset");
    if (profile.features.includes("sqlitePages"))
      requestedExports.push(
        ...(profile.mode === "aot"
          ? [
              "aot_export_sqlite",
              "sqlite_data",
              "sqlite_info",
              "sqlite_data_base64",
            ]
          : profile.mode === "sql"
            ? ["database_import_sqlite", "database_import_sqlite_base64"]
            : []),
      );
    if (profile.features.includes("sqlitePages") && profile.mode !== "sql")
      requestedExports.push(...sqlitePagerExports(profile.mode));
    if (profile.features.includes("ltx"))
      requestedExports.push(
        "encode_ltx",
        "encode_ltx_pages",
        "encode_ltx_pages_base64",
        "encode_ltx_pages_binary",
        "encode_ltx_pages_binary_base64",
        "apply_ltx",
        "ltx_data",
        "ltx_info",
        "encode_ltx_base64",
        "apply_ltx_base64",
        "ltx_data_base64",
      );
    if (profile.mode === "sql" && profile.features.includes("ltx"))
      throw Error("ltx exports currently require the aot runtime");
    const exports = [...new Set(requestedExports)];
    const entry = nativeResults
      ? "packages/sqlike/src/experimental-aot-typed"
      : profile.mode === "aot"
        ? "examples/aot/src/runtime"
        : profile.mode === "defined"
          ? definedEntry
          : "packages/sqlike/src/full";
    const imports = nativeResults
      ? 'import { "mizchi/sqlike/full" @sqlike, "mizchi/sqlike/experimental-typed" @native }\n'
      : profile.mode === "aot"
        ? 'import { "mizchi/sqlike/full" @sqlike, "mizchi/litestream" }\n'
        : profile.mode === "defined"
          ? 'import { "mizchi/sqlike/full" @sqlike }\n'
          : (await readFile(join(work, entry, "moon.pkg"), "utf8")).split(
              "options(",
            )[0];
    await writeFile(
      join(work, entry, "moon.pkg"),
      imports +
        (nativeResults
          ? `\noptions(targets: { "aot.mbt": ["js"] }, link: { "js": { "exports": ${JSON.stringify(exports)}, "format": "esm" } })\n`
          : `\noptions(link: { "js": { "exports": ${JSON.stringify(exports)}, "format": "esm" }, "wasm-gc": { "exports": ${JSON.stringify(exports)}, "use-js-builtin-string": true, "imported-string-constants": "_" } })\n`),
    );
    // The profile package is the only link target; imports still compile normally.
    await mkdir(output, { recursive: true });
    for (const target of targets) {
      await exec("moon", ["build", entry, "--target", target, "--release"], {
        cwd: work,
        maxBuffer: 4 * 1024 * 1024,
      });
      const base = nativeResults
        ? "mizchi/sqlike/experimental-aot-typed/experimental-aot-typed"
        : profile.mode === "aot"
          ? "mizchi/litestream-example/runtime/runtime"
          : profile.mode === "defined"
            ? "mizchi/sqlike/defined/defined"
            : "mizchi/sqlike/full/full";
      const artifact = join(
        work,
        "_build",
        target,
        "release/build",
        base + (target === "js" ? ".js" : ".wasm"),
      );
      if (target === "js")
        await writeFile(
          join(output, "runtime.js"),
          minify
            ? await minifyRuntime(artifact, exports)
            : await readFile(artifact, "utf8"),
        );
      else await copyFile(artifact, join(output, "runtime.wasm"));
    }
    await writeFile(
      join(output, "runtime.d.ts"),
      nativeResults
        ? nativeAotDeclarations()
        : runtimeDeclarations(exports, {
            aotImageRestore: plan.apiCapabilities.includes("snapshot"),
          }),
    );
    await writeFile(
      join(output, "build-plan.json"),
      JSON.stringify(plan, null, 2) + "\n",
    );
    if (targets.includes("js")) {
      const module = await import(
        pathToFileURL(join(output, "runtime.js")).href
      );
      if (
        JSON.stringify(Object.keys(module).sort()) !==
        JSON.stringify([...exports].sort())
      )
        throw Error("JS export contract mismatch");
    }
    if (targets.includes("wasm-gc")) {
      const module = await WebAssembly.compile(
        await readFile(join(output, "runtime.wasm")),
        { builtins: ["js-string"], importedStringConstants: "_" },
      );
      const actual = WebAssembly.Module.exports(module)
        .filter((e) => e.kind === "function")
        .map((e) => e.name)
        .sort();
      if (JSON.stringify(actual) !== JSON.stringify([...exports].sort()))
        throw Error("Wasm export contract mismatch");
    }
    await writeFile(
      join(output, "package.json"),
      JSON.stringify({
        type: "module",
        sideEffects: false,
        types: "./runtime.d.ts",
      }) + "\n",
    );
    await writeFile(
      join(output, "profile.json"),
      JSON.stringify(
        {
          ...profile,
          exports,
          targets,
          ...(nativeResults ? { nativeResults: true } : {}),
          minify: targets.includes("js") && minify ? "oxc" : false,
          ...(requirements ? { requirements } : {}),
        },
        null,
        2,
      ) + "\n",
    );
    await publishBuildStage(output, destination);
    return {
      directory: destination,
      profile,
      exports,
      plan,
      ...(requirements ? { requirements } : {}),
    };
  } finally {
    await rm(work, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [config, outDir, ...extra] = process.argv.slice(2);
  if (!config || !outDir || extra.length)
    throw Error(
      "usage: tsx scripts/build-sqlike-runtime.ts profile.json output-directory",
    );
  const data = JSON.parse(await readFile(config, "utf8")) as {
    mode?: SqlikeProfile["mode"];
    features?: import("../src/sqlike-features.ts").SqlikeFeatureName[];
    nativeResults?: boolean;
    catalog?: string | CatalogSource;
    preset?: "baseline" | "full";
    emitter?: "flat-single-link" | "moonbit-source";
    moduleName?: string;
    optimizers?: readonly SqlikeOptimizer[];
    targets?: readonly ("js" | "wasm-gc")[];
    apiCapabilities?: readonly AotApiCapability[];
  };
  if (data.preset !== undefined && !["baseline", "full"].includes(data.preset))
    throw Error("unknown preset");
  if (
    data.emitter !== undefined &&
    !["flat-single-link", "moonbit-source"].includes(data.emitter)
  )
    throw Error("unknown emitter");
  if (data.preset && data.features)
    throw Error("choose either a preset or explicit features");
  if (data.preset === "baseline" && data.mode && data.mode !== "sql")
    throw Error("baseline preset requires SQL mode");
  const profile =
    data.preset === "baseline"
      ? baselineSqlike()
      : data.preset === "full"
        ? fullSqlike(data.mode)
        : defineSqlike({
            mode: data.mode,
            features: data.features?.map((name) => ({ name })),
          });
  const catalog =
    typeof data.catalog === "string"
      ? (JSON.parse(
          await readFile(
            resolve(dirname(resolve(config)), data.catalog),
            "utf8",
          ),
        ) as CatalogSource)
      : data.catalog;
  const built =
    data.emitter === "moonbit-source"
      ? await (async () => {
          if (!catalog) throw Error("MoonBit source output requires a catalog");
          if (data.nativeResults || data.targets)
            throw Error(
              "MoonBit source output checks both portable targets; nativeResults/targets are direct-output options",
            );
          const { emitSqlikeMoonbit } = await import(
            "./emit-sqlike-moonbit.ts"
          );
          return emitSqlikeMoonbit(profile, {
            outDir,
            catalog,
            moduleName: data.moduleName,
            optimizers: data.optimizers,
            apiCapabilities: data.apiCapabilities,
          });
        })()
      : await buildSqlikeRuntime(profile, {
          outDir,
          nativeResults: data.nativeResults,
          catalog,
          optimizers: data.optimizers,
          targets: data.targets,
          apiCapabilities: data.apiCapabilities,
        });
  console.log(
    JSON.stringify(
      "artifact" in built ? { ...built, artifact: undefined } : built,
    ),
  );
}
