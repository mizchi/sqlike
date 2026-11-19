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
  export interface AotSnapshot {
    readonly __snapshot: unique symbol;
  }
  export interface AotSnapshotReader {
    readonly __snapshotReader: unique symbol;
  }
  export function aot_snapshot_incremental(db: AotDatabase): AotSnapshot;
  export function aot_snapshot_reuse(
    current: AotSnapshot,
    before: AotSnapshot,
    index: number,
  ): number;
  export function aot_snapshot_open(db: AotDatabase): AotSnapshot;
  export function aot_snapshot_info(snapshot: AotSnapshot): string;
  export function aot_snapshot_chunk(
    snapshot: AotSnapshot,
    index: number,
  ): SqliteResult;
  export function aot_snapshot_restore(
    db: AotDatabase,
    header: string,
  ): AotSnapshotReader;
  export function aot_snapshot_supply(
    reader: AotSnapshotReader,
    data: Uint8Array,
  ): string;
  export function aot_snapshot_finish(reader: AotSnapshotReader): string;
  export function aot_snapshot_supply_base64(
    reader: AotSnapshotReader,
    data: string,
  ): string;
  export function aot_dump(db: AotDatabase): string;
  export function aot_restore(db: AotDatabase, image: string): string;
  export function aot_query_info(db: AotDatabase, name: string): string;
  export function aot_clone(db: AotDatabase): AotDatabase;
  export interface SqlitePager {
    readonly __sqlitePager: unique symbol;
  }
  export interface SqlitePageBatch {
    readonly __sqlitePageBatch: unique symbol;
  }
  export function sqlite_pager_open(): SqlitePager;
  export function aot_pager_prepare(
    db: AotDatabase,
    pager: SqlitePager,
  ): SqlitePageBatch;
  export function sqlite_pager_info(batch: SqlitePageBatch): string;
  export function sqlite_pager_supply(
    batch: SqlitePageBatch,
    page: number,
    data: Uint8Array,
  ): string;
  export function sqlite_pager_page(
    batch: SqlitePageBatch,
    index: number,
  ): Uint8Array;
  export function sqlite_pager_ack(
    pager: SqlitePager,
    batch: SqlitePageBatch,
  ): string;
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
  export function encode_ltx_pages_binary(
    state: string,
    metadata: string,
    data: Uint8Array,
    previous: Uint8Array,
  ): LtxResult;
  export function encode_ltx_pages_binary_base64(
    state: string,
    metadata: string,
    data: string,
    previous: string,
  ): LtxResult;
  export function encode_ltx_pages(
    state: string,
    metadata: string,
    data: Uint8Array,
  ): LtxResult;
  export function ltx_data(result: LtxResult): Uint8Array<ArrayBuffer>;
  export function ltx_data_base64(result: LtxResult): string;
}
