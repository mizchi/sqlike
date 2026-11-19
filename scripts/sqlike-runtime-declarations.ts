/** Host ABI for the selected exports. Kept separate from generated engine code. */
const signatures: Record<string, string> = {
  defined_open:
    "(schema: Uint8Array, statements: Uint8Array, image: Uint8Array): DefinedHandle",
  defined_info: "(db: DefinedHandle): string",
  defined_execute:
    "(db: DefinedHandle, name: string, bindings: string): string",
  defined_query_info: "(db: DefinedHandle, name: string): string",
  defined_set_clock: "(db: DefinedHandle, millis: string): string",
  defined_clone: "(db: DefinedHandle): DefinedHandle",
  defined_copy_connection_state:
    "(target: DefinedHandle, source: DefinedHandle): string",
  defined_snapshot: "(db: DefinedHandle): BinaryResult",
  defined_restore: "(db: DefinedHandle, image: Uint8Array): string",
  defined_delta: "(db: DefinedHandle, full: boolean): BinaryResult",
  defined_apply_delta: "(db: DefinedHandle, image: Uint8Array): string",
  defined_ack_delta: "(db: DefinedHandle, serial: number): string",
  binary_data: "(result: BinaryResult): Uint8Array<ArrayBuffer>",
  binary_info: "(result: BinaryResult): string",
  defined_open_base64:
    "(schema: string, statements: string, image: string): DefinedHandle",
  binary_data_base64: "(result: BinaryResult): string",
  defined_restore_base64: "(db: DefinedHandle, image: string): string",
  defined_apply_delta_base64: "(db: DefinedHandle, image: string): string",
  database_open: "(): Connection",
  database_prepare: "(db: Connection, sql: string): SqlPrepared",
  database_prepared_exec:
    "(query: SqlPrepared, bindings: string, readonly: boolean, positional: boolean): string",
  database_autocommit: "(db: Connection): boolean",
  database_set_clock: "(db: Connection, milliseconds: string): string",
  database_exec:
    "(db: Connection, sql: string, bindings: string, readonly: boolean): string",
  database_query_values:
    "(db: Connection, sql: string, bindings: string): string",
  database_exec_values:
    "(db: Connection, sql: string, bindings: string): string",
  database_dump: "(db: Connection): string",
  database_restore: "(db: Connection, image: string): string",
  database_version: "(db: Connection): number",
  database_is_readonly: "(sql: string): boolean",
  database_copy_connection_state:
    "(target: Connection, source: Connection): void",
  database_clone: "(db: Connection): Connection",
  database_delta: "(db: Connection, snapshot: boolean): string",
  database_ack_delta: "(db: Connection, serial: number): string",
  database_apply_delta: "(db: Connection, delta: string): string",
  database_serial: "(db: Connection): number",
  database_changeset: "(db: Connection, before: Connection): string",
  database_import_sqlite: "(db: Connection, image: Uint8Array): string",
  database_import_sqlite_base64: "(db: Connection, image: string): string",
  aot_open: "(artifact: string, image: string): AotDatabase",
  aot_info: "(db: AotDatabase): string",
  aot_set_clock: "(db: AotDatabase, milliseconds: string): string",
  aot_execute: "(db: AotDatabase, name: string, bindings: string): string",
  aot_prepare_values: "(db: AotDatabase, name: string): AotPreparedQuery",
  aot_prepared_execute: "(query: AotPreparedQuery, bindings: string): string",
  aot_finalize_values: "(query: AotPreparedQuery): string",
  aot_snapshot_incremental: "(db: AotDatabase): AotSnapshot",
  aot_snapshot_reuse:
    "(current: AotSnapshot, before: AotSnapshot, index: number): number",
  aot_snapshot_open: "(db: AotDatabase): AotSnapshot",
  aot_snapshot_info: "(snapshot: AotSnapshot): string",
  aot_snapshot_chunk: "(snapshot: AotSnapshot, index: number): SqliteResult",
  aot_snapshot_restore: "(db: AotDatabase, header: string): AotSnapshotReader",
  aot_snapshot_supply: "(reader: AotSnapshotReader, data: Uint8Array): string",
  aot_snapshot_supply_base64:
    "(reader: AotSnapshotReader, data: string): string",
  aot_snapshot_finish: "(reader: AotSnapshotReader): string",
  aot_dump: "(db: AotDatabase): string",
  aot_restore: "(db: AotDatabase, image: string): string",
  aot_query_info: "(db: AotDatabase, name: string): string",
  aot_copy_connection_state:
    "(target: AotDatabase, source: AotDatabase): string",
  aot_clone: "(db: AotDatabase): AotDatabase",
  aot_delta: "(db: AotDatabase, snapshot: boolean): string",
  aot_ack_delta: "(db: AotDatabase, serial: number): string",
  aot_apply_delta: "(db: AotDatabase, delta: string): string",
  aot_export_sqlite: "(db: AotDatabase): SqliteResult",
  sqlite_pager_supply_base64:
    "(batch: SqlitePageBatch, page: number, data: string): string",
  sqlite_pager_page_base64: "(batch: SqlitePageBatch, index: number): string",
  defined_pager_prepare_base64:
    "(db: DefinedHandle, layout: string, pager: SqlitePager): SqlitePageBatch",
  sqlite_pager_open: "(): SqlitePager",
  aot_pager_prepare: "(db: AotDatabase, pager: SqlitePager): SqlitePageBatch",
  defined_pager_prepare:
    "(db: DefinedHandle, layout: Uint8Array, pager: SqlitePager): SqlitePageBatch",
  sqlite_pager_info: "(batch: SqlitePageBatch): string",
  sqlite_pager_supply:
    "(batch: SqlitePageBatch, page: number, data: Uint8Array): string",
  sqlite_pager_page:
    "(batch: SqlitePageBatch, index: number): Uint8Array<ArrayBuffer>",
  sqlite_pager_ack: "(pager: SqlitePager, batch: SqlitePageBatch): string",
  sqlite_data: "(result: SqliteResult): Uint8Array<ArrayBuffer>",
  sqlite_data_base64: "(result: SqliteResult): string",
  encode_ltx_base64:
    "(base: string, data: string, min: string, max: string, timestamp: string): LtxResult",
  apply_ltx_base64:
    "(base: string, txid: string, file: string, version: number): LtxResult",
  ltx_data_base64: "(result: LtxResult): string",
  sqlite_info: "(result: SqliteResult): string",
  encode_ltx_pages:
    "(state: string, metadata: string, data: Uint8Array): LtxResult",
  encode_ltx_pages_base64:
    "(state: string, metadata: string, data: string): LtxResult",
  encode_ltx_pages_binary:
    "(state: string, metadata: string, data: Uint8Array, previous: Uint8Array): LtxResult",
  encode_ltx_pages_binary_base64:
    "(state: string, metadata: string, data: string, previous: string): LtxResult",
  encode_ltx:
    "(base: Uint8Array, data: Uint8Array, min: string, max: string, timestamp: string): LtxResult",
  apply_ltx:
    "(base: Uint8Array, txid: string, file: Uint8Array, version: number): LtxResult",
  ltx_data: "(result: LtxResult): Uint8Array<ArrayBuffer>",
  ltx_info: "(result: LtxResult): string",
};

export function sqlitePagerExports(mode: "aot" | "defined"): string[] {
  return [
    "sqlite_pager_open",
    "sqlite_pager_info",
    "sqlite_pager_supply",
    "sqlite_pager_supply_base64",
    "sqlite_pager_page",
    "sqlite_pager_page_base64",
    "sqlite_pager_ack",
    ...(mode === "aot"
      ? ["aot_pager_prepare"]
      : ["defined_pager_prepare", "defined_pager_prepare_base64"]),
  ];
}

const nativeAotSignatures: Record<string, string> = {
  open: "(program: string, image: string): NativeAotDatabase",
  info: "(db: NativeAotDatabase): string",
  query_info: "(db: NativeAotDatabase, name: string): string",
  execute: "(db: NativeAotDatabase, name: string, bindings: string): string",
  prepare: "(db: NativeAotDatabase, name: string): NativeAotQuery",
  values: "(query: NativeAotQuery, bindings: string): NativeCell[][]",
  values_typed:
    "(query: NativeAotQuery, bindings: readonly NativeCell[]): NativeCell[][]",
  execute_typed:
    "(db: NativeAotDatabase, name: string, bindings: readonly NativeCell[]): NativeExecution",
  copy_connection_state:
    "(target: NativeAotDatabase, source: NativeAotDatabase): string",
  finalize: "(query: NativeAotQuery): string",
  restore: "(db: NativeAotDatabase, image: string): string",
  snapshot: "(db: NativeAotDatabase): string",
  set_clock: "(db: NativeAotDatabase, millis: string): string",
  clone: "(db: NativeAotDatabase): NativeAotDatabase",
};
export const nativeAotExports = Object.keys(nativeAotSignatures);
export function nativeAotDeclarations() {
  return (
    `export interface NativeAotDatabase { readonly __nativeAotDatabase: unique symbol }
export interface NativeAotQuery { readonly __nativeAotQuery: unique symbol }
export type NativeCell = bigint | number | string | null | Uint8Array;
export interface NativeExecution { names: string[]; rows: NativeCell[][]; readonly: boolean; changes: number }
` +
    nativeAotExports
      .map((name) => `export function ${name}${nativeAotSignatures[name]};\n`)
      .join("")
  );
}
export function runtimeDeclarations(
  exports: readonly string[],
  { aotImageRestore = true }: { aotImageRestore?: boolean } = {},
): string {
  return (
    "// Generated selected runtime ABI.\n" +
    [
      "Connection",
      "SqlPrepared",
      "AotDatabase",
      "AotSnapshot",
      "AotSnapshotReader",
      "AotPreparedQuery",
      "SqliteResult",
      "SqlitePager",
      "SqlitePageBatch",
      "LtxResult",
      "DefinedHandle",
      "BinaryResult",
    ]
      .map((name) => {
        const brand =
          name === "DefinedHandle"
            ? '__definedHandle: "sqlike-defined-handle"'
            : name === "BinaryResult"
              ? '__binaryResult: "sqlike-binary-result"'
              : `__${name}: unique symbol`;
        return `export interface ${name} { readonly ${brand} }\n`;
      })
      .join("") +
    [...exports]
      .sort()
      .map((name) => {
        const signature =
          name === "aot_open" && !aotImageRestore
            ? '(artifact: string, image: ""): AotDatabase'
            : signatures[name];
        if (!signature) throw Error(`missing runtime ABI declaration: ${name}`);
        return `export function ${name}${signature};\n`;
      })
      .join("")
  );
}
