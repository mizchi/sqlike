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
  sqlite_data: "(result: SqliteResult): Uint8Array<ArrayBuffer>",
  sqlite_data_base64: "(result: SqliteResult): string",
  encode_ltx_base64:
    "(base: string, data: string, min: string, max: string, timestamp: string): LtxResult",
  apply_ltx_base64:
    "(base: string, txid: string, file: string, version: number): LtxResult",
  ltx_data_base64: "(result: LtxResult): string",
  sqlite_info: "(result: SqliteResult): string",
  encode_ltx:
    "(base: Uint8Array, data: Uint8Array, min: string, max: string, timestamp: string): LtxResult",
  apply_ltx:
    "(base: Uint8Array, txid: string, file: Uint8Array, version: number): LtxResult",
  ltx_data: "(result: LtxResult): Uint8Array<ArrayBuffer>",
  ltx_info: "(result: LtxResult): string",
};

const nativeAotSignatures: Record<string, string> = {
  open: "(program: string, image: string): NativeAotDatabase",
  info: "(db: NativeAotDatabase): string",
  query_info: "(db: NativeAotDatabase, name: string): string",
  execute: "(db: NativeAotDatabase, name: string, bindings: string): string",
  prepare: "(db: NativeAotDatabase, name: string): NativeAotQuery",
  values: "(query: NativeAotQuery, bindings: string): NativeCell[][]",
  finalize: "(query: NativeAotQuery): string",
  restore: "(db: NativeAotDatabase, image: string): string",
  snapshot: "(db: NativeAotDatabase): string",
  set_clock: "(db: NativeAotDatabase, millis: string): string",
  clone: "(db: NativeAotDatabase): NativeAotDatabase",
};
export const nativeAotExports = Object.keys(nativeAotSignatures);
export function nativeAotDeclarations() {
  return `export interface NativeAotDatabase { readonly __nativeAotDatabase: unique symbol }
export interface NativeAotQuery { readonly __nativeAotQuery: unique symbol }
export type NativeCell = bigint | number | string | null | Uint8Array;
` + nativeAotExports.map(name => `export function ${name}${nativeAotSignatures[name]};\n`).join("");
}
export function runtimeDeclarations(exports: readonly string[]): string {
  return (
    "// Generated selected runtime ABI.\n" +
    [
      "Connection",
      "SqlPrepared",
      "AotDatabase",
      "SqliteResult",
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
    exports
      .map((name) => {
        const signature = signatures[name];
        if (!signature) throw Error(`missing runtime ABI declaration: ${name}`);
        return `export function ${name}${signature};\n`;
      })
      .join("")
  );
}
