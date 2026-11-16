import { cp, mkdtemp, readFile, writeFile, mkdir, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineSqlike, type SqlikeProfile } from "../src/sqlike-features.ts";
import { runtimeDeclarations } from "./sqlike-runtime-declarations.ts";
import { minifyRuntime } from "./oxc-runtime.ts";
import {
  catalogFunctionConstants,
  catalogStatementConstants,
  catalogQueryConstants,
} from "../src/catalog-capabilities.ts";
import type { CatalogSource } from "../src/aot-contract.ts";
import type { CatalogRequirements } from "../src/catalog-requirements-contract.ts";
const exec = promisify(execFile),
  root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const flags = {
  OUTER_JOIN: "rightFullJoin",
  STRICT: "strictTables",
  PRIMARY_INDEX: "primaryKeyIndex",
  TRIGGERS: "triggers",
  FOREIGN_KEYS: "foreignKeys",
  BINARY_SYNC: "binarySync",
  SQL_JSON: "sqlJson",
  DATETIME: "dateTime",
  WINDOWS: "windowFunctions",
  SCHEMA_METADATA: "schemaMetadata",
  AGGREGATE_FILTER: "aggregateFilter",
} as const;
const aot = [
  "aot_open",
  "aot_info",
  "aot_set_clock",
  "aot_execute",
  "aot_dump",
  "aot_restore",
  "aot_query_info",
  "aot_clone",
  "aot_copy_connection_state",
  "aot_delta",
  "aot_ack_delta",
  "aot_apply_delta",
];
const sql = [
  "database_open",
  "database_autocommit",
  "database_set_clock",
  "database_exec",
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
    targets = ["js", "wasm-gc"],
    minify = true,
    catalog: catalogInput,
  }: {
    outDir: string;
    targets?: readonly ("js" | "wasm-gc")[];
    minify?: boolean;
    /** Infer semantic features and trim function/statement implementations from typed IR. */
    catalog?: CatalogSource;
  },
) {
  if (catalogInput !== undefined && input.mode === "sql")
    throw Error("catalog specialization requires aot or defined");
  const catalog = catalogInput === undefined ? undefined : structuredClone(catalogInput);
  const requirements: CatalogRequirements | undefined =
    catalog !== undefined
      ? (await import("./analyze-catalog.ts")).analyzeCatalogRequirements(catalog)
      : undefined;
  const profile = defineSqlike({
    mode: input.mode,
    features: [...input.features, ...(requirements?.features ?? [])].map((name) => ({ name })),
  });
  const work = await mkdtemp(join(tmpdir(), "sqlike-profile-"));
  const output = resolve(outDir);
  try {
    await mkdir(join(work, "packages"), { recursive: true });
    for (const p of ["sqlike", "litestream"])
      await cp(join(root, "packages", p), join(work, "packages", p), {
        recursive: true,
        filter: (s) => !s.includes("/_build/") && !s.includes("/.mooncakes/"),
      });
    await mkdir(join(work, "examples"), { recursive: true });
    await cp(join(root, "examples/aot"), join(work, "examples/aot"), {
      recursive: true,
    });
    await writeFile(
      join(work, "moon.work"),
      'members = ["packages/sqlike", "packages/litestream", "examples/aot"]\n',
    );
    await writeFile(
      join(work, "packages/sqlike/src/feature_config.mbt"),
      Object.entries(flags)
        .map(
          ([key, value]) => `const FEATURE_${key} : Bool = ${profile.features.includes(value)}\n`,
        )
        .join(""),
    );
    if (requirements) {
      const configPath = join(work, "packages/sqlike/src/capability_config_generated.mbt");
      let code = await readFile(configPath, "utf8");
      const replace = (name: string, value: boolean) => {
        const pattern = new RegExp(`const ${name} : Bool = (?:true|false)`);
        if (!pattern.test(code)) throw Error(`missing catalog capability constant ${name}`);
        code = code.replace(pattern, `const ${name} : Bool = ${value}`);
      };
      replace("CAP_CATALOG_SPECIALIZED", true);
      for (const [name, constant] of Object.entries(catalogFunctionConstants))
        replace(
          constant,
          requirements.functionGroups.includes(name as keyof typeof catalogFunctionConstants),
        );
      for (const [name, constant] of Object.entries(catalogStatementConstants))
        replace(
          constant,
          requirements.statements.includes(name as keyof typeof catalogStatementConstants),
        );
      for (const [name, constant] of Object.entries(catalogQueryConstants))
        replace(
          constant,
          requirements.queryParts.includes(name as keyof typeof catalogQueryConstants),
        );
      await writeFile(configPath, code);
    }
    const definedEntry = "packages/sqlike/src/defined";
    const definedPkg = await readFile(join(work, definedEntry, "moon.pkg"), "utf8");
    // moon.pkg is MoonBit's DSL: moon fmt adds trailing commas to arrays.
    // Export names are identifiers, so read quoted names rather than JSON.
    const exportBlock = definedPkg.match(/"exports":\s*(\[[^\]]+\])/)?.[1];
    if (!exportBlock) throw Error("missing defined runtime exports");
    const defined = [...exportBlock.matchAll(/"([a-z_][a-z_0-9]*)"/g)].map((m) => m[1]!);
    const exports = [
      ...(profile.mode === "defined" ? defined : profile.mode === "aot" ? aot : sql),
    ];
    if (profile.features.includes("binarySync")) exports.push("database_changeset");
    if (profile.features.includes("sqlitePages"))
      exports.push(
        ...(profile.mode === "aot"
          ? ["aot_export_sqlite", "sqlite_data", "sqlite_info", "sqlite_data_base64"]
          : ["database_import_sqlite", "database_import_sqlite_base64"]),
      );
    if (profile.features.includes("ltx"))
      exports.push(
        "encode_ltx",
        "apply_ltx",
        "ltx_data",
        "ltx_info",
        "encode_ltx_base64",
        "apply_ltx_base64",
        "ltx_data_base64",
      );
    if (profile.mode === "sql" && profile.features.includes("ltx"))
      throw Error("ltx exports currently require the aot runtime");
    const entry =
      profile.mode === "aot"
        ? "examples/aot/src/runtime"
        : profile.mode === "defined"
          ? definedEntry
          : "packages/sqlike/src";
    const imports =
      profile.mode === "aot"
        ? 'import { "mizchi/sqlike", "mizchi/litestream" }\n'
        : profile.mode === "defined"
          ? 'import { "mizchi/sqlike" }\n'
          : (await readFile(join(work, entry, "moon.pkg"), "utf8")).split("// Match")[0];
    await writeFile(
      join(work, entry, "moon.pkg"),
      imports +
        `\noptions(link: { "js": { "exports": ${JSON.stringify(exports)}, "format": "esm" }, "wasm-gc": { "exports": ${JSON.stringify(exports)}, "use-js-builtin-string": true, "imported-string-constants": "_" } })\n`,
    );
    // The profile package is the only link target; imports still compile normally.
    await mkdir(output, { recursive: true });
    for (const target of targets) {
      await exec("moon", ["build", entry, "--target", target, "--release"], {
        cwd: work,
        maxBuffer: 4 * 1024 * 1024,
      });
      const base =
        profile.mode === "aot"
          ? "mizchi/litestream-example/runtime/runtime"
          : profile.mode === "defined"
            ? "mizchi/sqlike/defined/defined"
            : "mizchi/sqlike/sqlike";
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
          minify ? await minifyRuntime(artifact, exports) : await readFile(artifact, "utf8"),
        );
      else await copyFile(artifact, join(output, "runtime.wasm"));
    }
    await writeFile(join(output, "runtime.d.ts"), runtimeDeclarations(exports));
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
          minify: targets.includes("js") && minify ? "oxc" : false,
          ...(requirements ? { requirements } : {}),
        },
        null,
        2,
      ) + "\n",
    );
    return { directory: output, profile, exports, ...(requirements ? { requirements } : {}) };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [config, outDir, ...extra] = process.argv.slice(2);
  if (!config || !outDir || extra.length)
    throw Error("usage: tsx scripts/build-sqlike-runtime.ts profile.json output-directory");
  const data = JSON.parse(await readFile(config, "utf8")) as {
    mode?: SqlikeProfile["mode"];
    features?: import("../src/sqlike-features.ts").SqlikeFeatureName[];
    catalog?: string | CatalogSource;
  };
  const built = await buildSqlikeRuntime(
    defineSqlike({
      mode: data.mode,
      features: data.features?.map((name) => ({ name })),
    }),
    {
      outDir,
      catalog:
        typeof data.catalog === "string"
          ? JSON.parse(await readFile(resolve(dirname(resolve(config)), data.catalog), "utf8"))
          : data.catalog,
    },
  );
  console.log(JSON.stringify(built));
}
