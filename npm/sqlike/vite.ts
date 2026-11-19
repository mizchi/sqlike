import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { sqlikeAotPlugin } from "../../scripts/sqlike-vite.ts";
import type { SqlikeAotOptions } from "../../src/sqlike-vite-contract.ts";
export type {
  SqlikeAotOptions,
  SqlikeAotBuildInfo,
} from "../../src/sqlike-vite-contract.ts";

/** Scan SQL files and compile one catalog-selected JS engine during Vite builds. */
export function sqlikeAot(options: SqlikeAotOptions = {}) {
  const packageFile = createRequire(import.meta.url).resolve(
    "@mizchi/sqlike/package.json",
  );
  return sqlikeAotPlugin(
    options,
    resolve(dirname(packageFile), "dist/build-sources"),
    dirname(packageFile),
  );
}
