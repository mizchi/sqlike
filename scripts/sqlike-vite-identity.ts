import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

const inputs = [
  "scripts/sqlike-vite-build.ts",
  "scripts/sqlike-vite-identity.ts",
  "scripts/build-sqlike-runtime.ts",
  "scripts/build-staging.ts",
  "scripts/oxc-runtime.ts",
  "scripts/sqlike-runtime-declarations.ts",
  "scripts/analyze-catalog.ts",
  "scripts/aot-compiler.ts",
  "src/sqlike-build-plan.ts",
  "src/sqlike-build-graph.ts",
  "src/sqlike-build-graph.generated.ts",
  "src/sqlike-features.ts",
  "src/catalog-capabilities.ts",
  "_build/js/release/build/mizchi/sqlike/compiler/compiler.js",
];
/** The packed plugin carries the same build-input digest without shipping these TS sources. */
export async function viteCompilerIdentity(root: string): Promise<string> {
  try {
    const stamp = JSON.parse(
      await readFile(join(root, "compiler-id.json"), "utf8"),
    );
    if (
      stamp.format !== "sqlike-aot-compiler@1" ||
      !/^[0-9a-f]{64}$/.test(stamp.sha256)
    )
      throw Error("invalid SQLike AOT compiler identity");
    return stamp.sha256;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const hash = createHash("sha256");
  for (const path of inputs) {
    hash.update(path + "\0");
    hash.update(await readFile(join(root, path)));
  }
  return hash.digest("hex");
}
