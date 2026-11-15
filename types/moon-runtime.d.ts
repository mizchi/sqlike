declare module "*runtime/runtime.js" {
  export interface AotDatabase {
    readonly __aotDatabase: unique symbol;
  }
  export function aot_open(program: string, image: string): AotDatabase;
  export function aot_info(db: AotDatabase): string;
  export function aot_set_clock(db: AotDatabase, milliseconds: string): string;
  export function aot_execute(
    db: AotDatabase,
    name: string,
    bindings: string,
  ): string;
  export function aot_dump(db: AotDatabase): string;
  export function aot_restore(db: AotDatabase, image: string): string;
  export function aot_query_info(db: AotDatabase, name: string): string;
  export function aot_clone(db: AotDatabase): AotDatabase;
  export interface SqliteResult {
    readonly __sqliteResult: unique symbol;
  }
  export interface LtxResult {
    readonly __ltxResult: unique symbol;
  }
  export function aot_export_sqlite(db: AotDatabase): SqliteResult;
  export function sqlite_info(result: SqliteResult): string;
  export function sqlite_data(result: SqliteResult): Uint8Array<ArrayBuffer>;
  export function sqlite_data_base64(result: SqliteResult): string;
  export function encode_ltx(
    base: Uint8Array,
    data: Uint8Array,
    min: string,
    max: string,
    timestamp: string,
  ): LtxResult;
  export function encode_ltx_base64(
    base: string,
    data: string,
    min: string,
    max: string,
    timestamp: string,
  ): LtxResult;
  export function apply_ltx(
    base: Uint8Array,
    txid: string,
    file: Uint8Array,
    version: number,
  ): LtxResult;
  export function apply_ltx_base64(
    base: string,
    txid: string,
    file: string,
    version: number,
  ): LtxResult;
  export function ltx_info(result: LtxResult): string;
  export function ltx_data(result: LtxResult): Uint8Array<ArrayBuffer>;
  export function ltx_data_base64(result: LtxResult): string;
}
