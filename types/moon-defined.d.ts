declare module "*defined/defined.js" {
  export interface DefinedHandle {
    readonly __definedHandle: "sqlike-defined-handle";
  }
  export interface BinaryResult {
    readonly __binaryResult: "sqlike-binary-result";
  }
  export function defined_open(
    schema: Uint8Array,
    statements: Uint8Array,
    image: Uint8Array,
  ): DefinedHandle;
  export function defined_info(db: DefinedHandle): string;
  export function defined_execute(
    db: DefinedHandle,
    name: string,
    bindings: string,
  ): string;
  export function defined_query_info(db: DefinedHandle, name: string): string;
  export function defined_set_clock(db: DefinedHandle, millis: string): string;
  export function defined_clone(db: DefinedHandle): DefinedHandle;
  export function defined_copy_connection_state(
    target: DefinedHandle,
    source: DefinedHandle,
  ): string;
  export function defined_snapshot(db: DefinedHandle): BinaryResult;
  export function defined_restore(db: DefinedHandle, image: Uint8Array): string;
  export function defined_delta(db: DefinedHandle, full: boolean): BinaryResult;
  export function defined_apply_delta(
    db: DefinedHandle,
    image: Uint8Array,
  ): string;
  export function defined_ack_delta(db: DefinedHandle, serial: number): string;
  export function binary_info(result: BinaryResult): string;
  export function binary_data(result: BinaryResult): Uint8Array<ArrayBuffer>;
  export function defined_open_base64(
    schema: string,
    statements: string,
    image: string,
  ): DefinedHandle;
  export function binary_data_base64(result: BinaryResult): string;
  export function defined_restore_base64(
    db: DefinedHandle,
    image: string,
  ): string;
  export function defined_apply_delta_base64(
    db: DefinedHandle,
    image: string,
  ): string;
}
declare module "*defined-sqlite/defined-sqlite.js" {
  export interface DefinedSqliteResult {
    readonly __definedSqliteResult: unique symbol;
  }
  export function defined_export_sqlite(
    schema: Uint8Array,
    statements: Uint8Array,
    layout: Uint8Array,
    image: Uint8Array,
  ): DefinedSqliteResult;
  export function sqlite_info(result: DefinedSqliteResult): string;
  export function sqlite_data(
    result: DefinedSqliteResult,
  ): Uint8Array<ArrayBuffer>;
}
