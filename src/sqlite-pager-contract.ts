/** Maximum attached files supported by the page provider. */
export const SQLITE_PAGE_FILE_LIMIT = 128;

/** SQLite page numbers are one-based. An immutable generation is the unit of
 * publication; a provider must reject stale reads/writes and publish atomically. */
export interface SqlitePageHead {
  format: "sqlike-pages@1";
  generation: number;
  programId: string;
  pageSize: number;
  pageCount: number;
  serial: number;
  metadata?: string;
  files?: string[];
  checksumFormat?: "crc64-be@1";
}
export interface SqlitePageWrite {
  page: number;
  data: Uint8Array;
}
export interface SqlitePageCommit {
  programId: string;
  pageSize: number;
  pageCount: number;
  serial: number;
  snapshot: boolean;
  pages: readonly SqlitePageWrite[];
  metadata?: string;
  files?: readonly { name: string; data: Uint8Array }[];
  removeFiles?: readonly string[];
  checksumFormat?: "crc64-be@1";
  checksumSnapshot?: boolean;
  /** One owned BE64 CRC per supplied page; full catalogs are only migrations/snapshots. */
  checksums?: readonly SqlitePageWrite[];
}
export interface SqlitePageStore {
  head(): Promise<SqlitePageHead | undefined>;
  readPage(generation: number, page: number): Promise<Uint8Array>;
  readFile?(generation: number, name: string): Promise<Uint8Array>;
  /** Owned concatenated BE64 CRCs for ascending page numbers in one generation. */
  readChecksums?(
    generation: number,
    pages: readonly number[],
  ): Promise<Uint8Array>;
  commit(expected: number, value: SqlitePageCommit): Promise<SqlitePageHead>;
  close(): void;
}
export interface SqlitePagerProgress {
  error?: string;
  ready: boolean;
  need?: number;
  pageSize: number;
  pageCount: number;
  serial: number;
  programId: string;
  snapshot: boolean;
  fallback?: string;
  pages: number[];
  changedRows: number;
  logicalBlocks: number;
  reads: number;
}
/** Opaque MoonBit handles stay within the runtime that created them. */
export interface SqlitePagerRuntime<Pager = unknown, Batch = unknown> {
  sqlite_pager_open(): Pager;
  sqlite_pager_info(batch: Batch): string;
  sqlite_pager_supply(batch: Batch, page: number, data: Uint8Array): string;
  sqlite_pager_page(batch: Batch, index: number): Uint8Array;
  sqlite_pager_ack(pager: Pager, batch: Batch): string;
}
export interface SqliteAotPagerRuntime<
  Database = unknown,
  Pager = unknown,
  Batch = unknown,
> extends SqlitePagerRuntime<Pager, Batch> {
  aot_pager_prepare(db: Database, pager: Pager): Batch;
}
export interface SqliteDefinedPagerRuntime<
  Database = unknown,
  Pager = unknown,
  Batch = unknown,
> extends SqlitePagerRuntime<Pager, Batch> {
  defined_pager_prepare(db: Database, layout: Uint8Array, pager: Pager): Batch;
}
