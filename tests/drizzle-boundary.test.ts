import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "vite";
import { excludeOptionalDrizzle } from "../scripts/production-boundary.ts";
test("default demo build rejects accidental optional ORM imports", async () => {
  await assert.rejects(
    build({
      configFile: false,
      publicDir: false,
      logLevel: "silent",
      plugins: [excludeOptionalDrizzle()],
      build: {
        write: false,
        target: "esnext",
        lib: { entry: "adapters/drizzle.ts", formats: ["es"] },
      },
    }),
    /Optional Drizzle must stay outside default demo bundles/,
  );
});
