export interface QuerySource {
  name: string;
  sql: string;
}
export interface CatalogSource {
  schema: string[];
  queries: QuerySource[];
}
export interface StorageField {
  column: number;
  collation: string;
  descending: boolean;
  /** Opaque MoonBit AST, emitted only for expression index fields. */
  expression?: unknown;
}
export interface StorageTree {
  name: string;
  table: string;
  root: number;
  kind: "table" | "index" | "without-rowid" | "sequence";
  fields: StorageField[];
  predicate?: unknown;
}
export interface StoragePlan {
  format: "sqlite-template@1";
  page_size: number;
  image: string;
  trees: StorageTree[];
}
export interface CatalogManifest {
  format: "moon-aot-build@1";
  artifactSHA256: string;
  sourceSHA256: string;
  templateSHA256: string;
  pageSize: number;
  nativeSQLite: string;
  queries: { name: string; parameters: number; columns: string[] }[];
}
