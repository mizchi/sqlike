import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

const name = "@mizchi/sqlike";
const helpers = new Set([
  `${name}/aot/core`,
  `${name}/defined/core`,
  `${name}/defined/wasm`,
  `${name}/drizzle/prepared`,
  `${name}/features`,
  `${name}/pager`,
  `${name}/package.json`,
]);

/** Immutable classification of public entries and their resolved package files. */
export async function createSqlikeAotImportGuard(packageRoot: string) {
  const pkg = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  if (pkg.name !== name)
    throw Error("invalid SQLike package for the AOT import guard");
  const roots = [...new Set([packageRoot, await realpath(packageRoot)])].map(
    (root) => root.replaceAll("\\", "/") + "/",
  );
  const files = new Map<string, string>();
  for (const [path, target] of Object.entries(pkg.exports) as [
    string,
    string | { import: string },
  ][]) {
    const specifier = path === "." ? name : name + path.slice(1);
    const file = typeof target === "string" ? target : target.import;
    files.set(file.replace(/^\.\//, ""), specifier);
    if (typeof target !== "string")
      files.set(
        file.replace(/^\.\/dist\//, "").replace(/\.js$/, ".ts"),
        specifier,
      );
  }
  return (id: string, importer?: string) => {
    const clean = id.replaceAll("\\", "/").split(/[?#]/, 1)[0]!;
    const bare = clean === name || clean.startsWith(name + "/");
    let specifier = bare ? clean : undefined;
    if (!bare) {
      const root = roots.find((root) => clean.startsWith(root));
      const marker = "/node_modules/@mizchi/sqlike/";
      const index = clean.lastIndexOf(marker);
      const file = root
        ? clean.slice(root.length)
        : index < 0
          ? undefined
          : clean.slice(index + marker.length);
      if (file) specifier = files.get(file);
    }
    if (
      !specifier ||
      helpers.has(specifier) ||
      (bare && specifier === `${name}/aot`)
    )
      return undefined;
    return {
      code: "SQLIKE_AOT_MIXED_MODE",
      id: importer ?? id,
      message: `[SQLIKE_AOT_MIXED_MODE] sqlikeAot() cannot mix its generated AOT with ${JSON.stringify(specifier)}.\nImported by: ${importer ?? id}\nUse @mizchi/sqlike/aot and engine-free helpers, or build dynamic SQL separately without sqlikeAot().`,
    };
  };
}
