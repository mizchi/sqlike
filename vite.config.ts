import { defineConfig } from "vite";
import { resolve } from "node:path";
import {
  excludeExperimentalLsm,
  excludeOptionalDrizzle,
} from "./scripts/production-boundary.ts";
const proxy = {
  "/aot-ltx": "http://127.0.0.1:19878",
  "/do-aot-ltx": {
    target: "http://127.0.0.1:19879",
    rewrite: (path: string) => path.replace("/do-aot-ltx", "/aot-ltx"),
  },
  "/api": "http://127.0.0.1:19878",
  "/relay": { target: "ws://127.0.0.1:19878", ws: true },
  "/do-api": {
    target: "http://127.0.0.1:19879",
    rewrite: (path: string) => path.replace("/do-api", "/api"),
  },
  "/do-relay": {
    target: "ws://127.0.0.1:19879",
    ws: true,
    rewrite: (path: string) => path.replace("/do-relay", "/relay"),
  },
};
const headers = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};
export default defineConfig(({ mode }) => {
  const input: Record<string, string> = {
    lite: resolve(import.meta.dirname, "lite/index.html"),
  };
  if (mode !== "lite") input.main = resolve(import.meta.dirname, "index.html");
  return {
    input,
    plugins: [excludeExperimentalLsm(), excludeOptionalDrizzle()],
    server: { proxy, headers },
    preview: { host: "127.0.0.1", port: 14173, proxy, headers },
    worker: {
      format: "es",
      plugins: () => [excludeExperimentalLsm(), excludeOptionalDrizzle()],
      rolldownOptions: {
        output: {
          format: "es",
          // A module worker needs a URL inside the controlling SW's scope on reload.
          entryFileNames: (chunk) =>
            chunk.name === "aot-worker"
              ? "lite/assets/[name]-[hash].js"
              : "assets/[name]-[hash].js",
        },
      },
    },
    build: { target: "esnext", minify: "oxc", manifest: true },
  };
});
