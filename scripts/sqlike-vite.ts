import { dirname, isAbsolute, matchesGlob, relative, resolve } from "node:path";
import type { Plugin, ViteDevServer } from "vite";
import {
  SqlikeViteBuilder,
  viteAotClient,
  type ViteAotCompilation,
} from "./sqlike-vite-build.ts";
import { sqlPatterns } from "./sqlike-vite-sql.ts";
import { createSqlikeAotImportGuard } from "./sqlike-vite-imports.ts";
import type { SqlikeAotOptions } from "../src/sqlike-vite-contract.ts";

const entry = "@mizchi/sqlike/aot",
  client = "\0sqlike:aot/client",
  runtimePrefix = "\0sqlike:aot/runtime/";

/** Node-only Vite adapter; scanning and compiler/cache state are separate modules. */
export function sqlikeAotPlugin(
  input: SqlikeAotOptions,
  sourceRoot: string,
  packageRoot = resolve(sourceRoot, "npm/sqlike"),
): Plugin {
  const options = structuredClone(input);
  const includes = sqlPatterns(options.include ?? "src/client/**/*.sql");
  const schemas = sqlPatterns(options.schemaFiles),
    excludes = sqlPatterns(options.exclude);
  if (
    options.api !== undefined &&
    !["execute", "connection"].includes(options.api)
  )
    throw Error("unknown SQLike AOT API");
  if (
    options.schema !== undefined &&
    (!Array.isArray(options.schema) ||
      !options.schema.every((s) => typeof s === "string"))
  )
    throw Error("SQLike schema must be an array of DDL strings");
  if (
    options.primaryKeyIndex !== undefined &&
    typeof options.primaryKeyIndex !== "boolean"
  )
    throw Error("primaryKeyIndex must be boolean");
  for (const [kind, path] of [
    ["dts", options.dts],
    ["reportFile", options.reportFile],
  ] as const)
    if (
      path !== undefined &&
      path !== false &&
      (typeof path !== "string" ||
        !path ||
        isAbsolute(path) ||
        path.replaceAll("\\", "/").split("/").includes("..") ||
        /[*?{}\[\]]/.test(path) ||
        !path.endsWith(kind === "dts" ? ".d.ts" : ".json"))
    )
      throw Error(
        `${kind} must be a relative ${kind === "dts" ? ".d.ts" : ".json"} path inside the Vite root, or false`,
      );
  let root: string,
    building = false,
    builder: SqlikeViteBuilder,
    current: ViteAotCompilation | undefined;
  let importGuard: Awaited<ReturnType<typeof createSqlikeAotImportGuard>>;
  let server: ViteDevServer | undefined,
    closed = false,
    failed = false,
    refreshTail = Promise.resolve();
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const relevant = (file: string) => {
    const path = relative(root, file).replaceAll("\\", "/");
    return (
      !path.startsWith("../") &&
      [...includes, ...schemas].some((p) => matchesGlob(path, p)) &&
      !excludes.some((p) => matchesGlob(path, p))
    );
  };
  const refresh = () => {
    refreshTail = refreshTail
      .then(async () => {
        if (closed) return;
        const next = await builder.build();
        if (
          closed ||
          (!failed &&
            next.metadata.fingerprint === current?.metadata.fingerprint)
        )
          return;
        failed = false;
        current = next;
        server!.moduleGraph.invalidateAll();
        server!.ws.send({ type: "full-reload", path: "*" });
      })
      .catch((error: Error) => {
        if (closed) return;
        failed = true;
        server!.config.logger.error(error.message);
        server!.ws.send({
          type: "error",
          err: {
            message: error.message,
            stack: error.stack ?? "",
            plugin: "sqlike-aot",
          },
        });
      });
  };
  const changed = (file: string) => {
    if (closed || !relevant(file)) return;
    clearTimeout(refreshTimer);
    // Coalesce editor save bursts before compiling. Reporting an error inside
    // Chokidar's 50 ms throttle window can hide an immediate corrective save.
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      refresh();
    }, 100);
  };
  const watchRoots = () => [
    ...new Set(
      [...includes, ...schemas].map((pattern) => {
        const prefix = pattern.split(/[*?{\[]/, 1)[0]!;
        return resolve(
          root,
          prefix.endsWith("/") ? prefix : dirname(prefix || "."),
        );
      }),
    ),
  ];
  return {
    name: "vite-plugin-sqlike-aot",
    enforce: "pre",
    config() {
      // Keep SQLike imports visible to the guard rather than an old optimized dependency.
      return { optimizeDeps: { exclude: ["@mizchi/sqlike"] } };
    },
    async configResolved(config) {
      if (
        config.plugins.filter((p) => p.name === "vite-plugin-sqlike-aot")
          .length > 1
      )
        throw Error(
          "only one sqlikeAot plugin can own @mizchi/sqlike/aot; combine SQL include patterns",
        );
      root = config.root;
      building = config.command === "build";
      importGuard = await createSqlikeAotImportGuard(packageRoot);
      builder = new SqlikeViteBuilder(
        root,
        resolve(config.cacheDir, "sqlike-aot"),
        sourceRoot,
        options,
      );
    },
    async buildStart() {
      current = await builder.build();
      for (const file of [...current.files, ...(building ? watchRoots() : [])])
        this.addWatchFile(file);
    },
    resolveId(id, importer) {
      const diagnostic = importGuard(id, importer);
      if (diagnostic) this.error(diagnostic);
      if (id === entry) return client;
      if (id.startsWith(runtimePrefix)) return id;
    },
    async load(id) {
      const diagnostic = importGuard(id);
      if (diagnostic) this.error(diagnostic);
      if (id.startsWith(runtimePrefix))
        return {
          code: await builder.runtime(id.slice(runtimePrefix.length)),
          moduleSideEffects: false,
        };
      if (id !== client) return;
      current = await builder.build();
      for (const file of [...current.files, ...(building ? watchRoots() : [])])
        this.addWatchFile(file);
      return {
        code: viteAotClient(
          current,
          runtimePrefix + current.metadata.engineHash,
        ),
        moduleSideEffects: false,
      };
    },
    configureServer(value) {
      server = value;
      for (const directory of watchRoots()) server.watcher.add(directory);
      server.watcher
        .on("add", changed)
        .on("change", changed)
        .on("unlink", changed);
    },
    handleHotUpdate({ file }) {
      if (relevant(file)) return [];
    },
    generateBundle() {
      // External modules can bypass resolveId/load; they still belong to the build graph.
      for (const id of this.getModuleIds()) {
        const info = this.getModuleInfo(id);
        const diagnostic = importGuard(
          id,
          info?.importers[0] ?? info?.dynamicImporters[0],
        );
        if (diagnostic) this.error(diagnostic);
      }
      if (current && options.reportFile !== false)
        this.emitFile({
          type: "asset",
          fileName: options.reportFile ?? "sqlike-aot-report.json",
          source: JSON.stringify(current.metadata, null, 2) + "\n",
        });
    },
    async closeBundle() {
      closed = true;
      clearTimeout(refreshTimer);
      server?.watcher
        .off("add", changed)
        .off("change", changed)
        .off("unlink", changed);
      await refreshTail;
    },
  };
}
