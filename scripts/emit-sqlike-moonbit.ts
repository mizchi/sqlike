import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineSqlike, type SqlikeProfile } from "../src/sqlike-features.ts";
import {
  selectedAotExports,
  type SqlikeOptimizer,
  type AotApiCapability,
} from "../src/sqlike-build-graph.ts";
import type { CatalogSource } from "../src/aot-contract.ts";
import {
  createBuildPlan,
  catalogHasSecondaryIndexes,
} from "../src/sqlike-build-plan.ts";
import { analyzeCatalogRequirements } from "./analyze-catalog.ts";
import { buildCatalog } from "./aot-compiler.ts";
import { engineSource, packageConfig } from "./generate-sqlike-packages.ts";
import { withBuildStage } from "./build-staging.ts";
import { sqlitePagerExports } from "./sqlike-runtime-declarations.ts";
const exec = promisify(execFile);
/** Emits MoonBit source, never stitched JS. A consumer's MoonBit linker owns
 * runtime sharing. Both portable backends must check before publication. */
export async function emitSqlikeMoonbit(
  input: SqlikeProfile,
  {
    outDir,
    catalog,
    moduleName = "app/sqlike-aot",
    optimizers,
    apiCapabilities,
  }: {
    outDir: string;
    catalog: CatalogSource;
    moduleName?: string;
    optimizers?: readonly SqlikeOptimizer[];
    apiCapabilities?: readonly AotApiCapability[];
  },
) {
  if (input.mode !== "aot") throw Error("MoonBit source emitter requires AOT");
  if (input.features.includes("ltx"))
    throw Error(
      "MoonBit source output uses the independent mizchi/litestream module for LTX; choose sqlitePages without ltx",
    );
  if (!/^[a-z][a-z0-9_-]*\/[a-z][a-z0-9_-]*$/.test(moduleName))
    throw Error("invalid MoonBit module name");
  const requirements = analyzeCatalogRequirements(catalog),
    built = buildCatalog(catalog);
  const profile = defineSqlike({
    mode: "aot",
    features: [...input.features, ...requirements.features].map((name) => ({
      name,
    })),
  });
  const schema = JSON.parse(built.artifact).schema;
  const hasSecondaryIndexes = catalogHasSecondaryIndexes(schema);
  const plan = createBuildPlan(profile, {
    requirements,
    hasSecondaryIndexes,
    optimizers,
    emitter: "moonbit-source",
    apiCapabilities,
  });
  const exports = [
    ...new Set([
      ...selectedAotExports(plan.selected),
      ...(profile.features.includes("sqlitePages")
        ? [
            "aot_export_sqlite",
            "sqlite_data",
            "sqlite_info",
            "sqlite_data_base64",
            ...sqlitePagerExports("aot"),
          ]
        : []),
    ]),
  ];
  await withBuildStage(outDir, async (stage) => {
    await mkdir(join(stage, "src/aot"), { recursive: true });
    await writeFile(
      join(stage, "moon.mod"),
      `name = ${JSON.stringify(moduleName)}\nversion = "0.0.0"\nsource = "src"\npreferred_target = "js"\nimport { "moonbitlang/x@0.5.5" }\n`,
    );
    await writeFile(
      join(stage, "src/aot/engine.mbt"),
      await engineSource(plan.constants, "aot", exports),
    );
    await writeFile(
      join(stage, "src/aot/moon.pkg"),
      await packageConfig(exports),
    );
    await writeFile(join(stage, "program.json"), built.artifact + "\n");
    await writeFile(
      join(stage, "build-plan.json"),
      JSON.stringify({ ...plan, requirements, moduleName }, null, 2) + "\n",
    );
    for (const target of ["js", "wasm-gc"]) {
      await exec("moon", ["check", "--target", target], {
        cwd: stage,
        maxBuffer: 4 * 1024 * 1024,
      });
    }
  });
  return {
    directory: resolve(outDir),
    moduleName,
    profile,
    requirements,
    plan,
    artifact: built.artifact,
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [catalogPath, outDir, moduleName] = process.argv.slice(2);
  if (!catalogPath || !outDir)
    throw Error(
      "usage: emit-sqlike-moonbit catalog.json output-directory [module/name]",
    );
  console.log(
    (
      await emitSqlikeMoonbit(defineSqlike({ mode: "aot" }), {
        catalog: JSON.parse(await readFile(catalogPath, "utf8")),
        outDir,
        moduleName,
      })
    ).directory,
  );
}
