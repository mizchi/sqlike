import { test } from "node:test";
import assert from "node:assert/strict";
import { build, type PluginOption } from "vite";
import { excludeExperimentalLsm } from "../scripts/production-boundary.ts";
import config from "../vite.config.ts";

async function fixture(id: string) {
  const entry = `\0boundary-fixture:${id}`;
  return build({
    configFile: false,
    publicDir: false,
    logLevel: "silent",
    plugins: [
      {
        name: "boundary-fixture",
        resolveId: (source) => (source === entry ? entry : undefined),
        load: (source) =>
          source === entry ? "export const value = 1;" : undefined,
      },
      excludeExperimentalLsm(),
    ],
    build: { write: false, minify: false, rolldownOptions: { input: entry } },
  });
}

for (const id of [
  "/repo/adapters/lsm-database.ts",
  "/repo/adapters/lsm-indexeddb.ts",
  "/repo/_build/js/release/build/mizchi/sqlike/lsm/lsm.js",
  "/repo/_build/wasm-gc/release/build/mizchi/sqlike/lsm/lsm.wasm?url",
  "/repo/scripts/lsm-bench-workload.ts",
])
  test(`production build rejects experimental LSM: ${id}`, async () => {
    await assert.rejects(fixture(id), /experimental LSM.*production/i);
  });

test("production build accepts the existing row journal", async () => {
  await fixture("/repo/adapters/moon-image-store.ts");
});

async function names(option: PluginOption): Promise<string[]> {
  const value = await option;
  if (Array.isArray(value)) return (await Promise.all(value.map(names))).flat();
  return value ? [value.name] : [];
}
for (const mode of ["production", "lite"])
  test(`${mode} guards both page and worker bundles`, async () => {
    assert.equal(typeof config, "function");
    if (typeof config !== "function")
      throw Error("expected Vite config factory");
    const options = await config({ command: "build", mode });
    assert.ok(
      (await names(options.plugins ?? [])).includes("exclude-experimental-lsm"),
    );
    assert.ok(
      (await names(options.worker?.plugins?.() ?? [])).includes(
        "exclude-experimental-lsm",
      ),
    );
  });
