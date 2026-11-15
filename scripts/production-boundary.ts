import type { Plugin } from "vite";

/** The optional ORM has its own entry; keep main/lite/Workers parser-free
 * profiles independent of it. Consumer builds opt in without this demo guard. */
export function excludeOptionalDrizzle(): Plugin {
  return {
    name: "exclude-optional-drizzle",
    apply: "build",
    moduleParsed(module) {
      const id = module.id.replaceAll("\\", "/").split("?")[0]!;
      if (
        id.includes("/drizzle-orm/") ||
        /\/adapters\/drizzle(?:-node|-migrator)?\.ts$/.test(id)
      )
        this.error(
          `Optional Drizzle must stay outside default demo bundles: ${module.id}`,
        );
    },
  };
}

/** Build-time only. LSM remains available to configFile:false experiments. */
export function excludeExperimentalLsm(): Plugin {
  return {
    name: "exclude-experimental-lsm",
    apply: "build",
    moduleParsed(module) {
      const id = module.id.replaceAll("\\", "/").split("?")[0]!;
      if (
        /\/(?:adapters\/lsm-|src\/lsm-|(?:mizchi\/sqlike|packages\/sqlike\/src)\/lsm\/|scripts\/(?:bench-lsm|lsm-bench-workload)\.ts$|e2e\/fixtures\/lsm-runtime\.ts$)/.test(
          id,
        )
      )
        this.error(
          `Experimental LSM must stay outside production bundles: ${module.id}`,
        );
    },
  };
}
