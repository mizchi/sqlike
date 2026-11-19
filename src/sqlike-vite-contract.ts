import type { CatalogRequirements } from "./catalog-requirements-contract.ts";
import type { SqlikeOptimizer } from "./sqlike-build-graph.ts";

export interface SqlikeAotOptions {
  /** Query globs relative to Vite root. Defaults to SQL files below src/client. */
  include?: string | readonly string[];
  exclude?: string | readonly string[];
  /** Trusted DDL statements evaluated by the build-time compiler. */
  schema?: readonly string[];
  schemaFiles?: string | readonly string[];
  /** execute is the four-export host; connection adds prepared queries, images and transactions. */
  api?: "execute" | "connection";
  primaryKeyIndex?: boolean;
  optimizers?: readonly SqlikeOptimizer[];
  /** Generated @mizchi/sqlike/aot types. Default: src/sqlike-aot.generated.d.ts. */
  dts?: string | false;
  /** Production build asset. Default: sqlike-aot-report.json. */
  reportFile?: string | false;
}

export interface SqlikeAotBuildInfo {
  format: "sqlike-vite-aot@1";
  fingerprint: string;
  engineHash: string;
  runtimeSHA256: string;
  api: "execute" | "connection";
  files: readonly string[];
  queries: readonly string[];
  exports: readonly string[];
  /** Minified engine bytes before the application's final bundling/compression. */
  runtimeBytes: number;
  artifactBytes: number;
  requirements: CatalogRequirements;
}
