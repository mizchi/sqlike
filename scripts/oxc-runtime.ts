import assert from "node:assert/strict";
import { build } from "vite";

/** Shared build-time policy for engines and their measurement hosts. */
export function buildOxcBundle(entry: string) {
  return build({
    configFile: false,
    publicDir: false,
    logLevel: "silent",
    input: entry,
    build: {
      write: false,
      minify: "oxc",
      target: "esnext",
      rolldownOptions: {
        preserveEntrySignatures: "strict",
        output: {
          format: "es",
          comments: { annotation: true, legal: true, jsdoc: false },
        },
      },
    },
  });
}

/** Keep the ESM API and purity annotations for downstream consumers. */
export async function minifyRuntime(
  entry: string,
  exports: readonly string[],
): Promise<string> {
  const result = await buildOxcBundle(entry);
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) =>
    "output" in r ? r.output : [],
  );
  assert.equal(outputs.length, 1, "runtime must be a standalone JS module");
  const chunk = outputs[0];
  assert.ok(chunk?.type === "chunk");
  assert.deepEqual(chunk.imports, [], "runtime cannot depend on other chunks");
  assert.deepEqual(
    chunk.dynamicImports,
    [],
    "runtime cannot load optional chunks",
  );
  assert.deepEqual(
    [...chunk.exports].sort(),
    [...exports].sort(),
    "runtime exports changed during minification",
  );
  return chunk.code;
}
