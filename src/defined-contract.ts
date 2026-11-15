/** Data-only build artifact. DDL/SQL parsing belongs to defined-compiler. */
export interface DefinedManifest {
  format: "sqlike-defined-build@1";
  schemaId: string;
  programId: string;
  schemaSHA256: string;
  statementsSHA256: string;
  storageSHA256?: string;
  sourceSHA256: string;
  queries: readonly {
    name: string;
    parameters: number;
    columns: readonly string[];
  }[];
}
export interface DefinedCatalog {
  readonly schema: Uint8Array;
  readonly statements: Uint8Array;
  readonly storage?: Uint8Array;
  readonly manifest: DefinedManifest;
}
