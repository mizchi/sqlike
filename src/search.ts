import * as runtime from "../_build/js/release/build/mizchi/sqlike/fts/fts.js";
/** Optional, rebuildable search index. Import separately from the SQL runtime. */
export interface SearchHit {
  rowid: bigint;
  rank: number;
}
export type SearchTokenizer = "ascii" | "trigram";
function checked<T extends { error?: string }>(text: string): T {
  const value = JSON.parse(text) as T;
  if (value.error) throw Error(value.error);
  return value;
}
export class SearchIndex {
  private readonly handle: ReturnType<typeof runtime.fts_open>;
  constructor(
    readonly columns: readonly string[],
    readonly tokenizer: SearchTokenizer = "ascii",
  ) {
    this.columns = Object.freeze([...columns]);
    this.handle = runtime.fts_open(JSON.stringify(columns), tokenizer);
    checked(runtime.fts_info(this.handle));
  }
  put(rowid: bigint, fields: readonly string[]): void {
    checked(
      runtime.fts_put(this.handle, String(rowid), JSON.stringify(fields)),
    );
  }
  delete(rowid: bigint): void {
    checked(runtime.fts_delete(this.handle, String(rowid)));
  }
  search(query: string, limit = 100): SearchHit[] {
    return checked<{ error?: string; hits: { rowid: string; rank: number }[] }>(
      runtime.fts_search(this.handle, query, limit),
    ).hits.map((r: { rowid: string; rank: number }) => ({
      rowid: BigInt(r.rowid),
      rank: r.rank,
    }));
  }
  dump(): string {
    return runtime.fts_dump(this.handle);
  }
  restore(image: string): void {
    checked(runtime.fts_restore(this.handle, image));
  }
  /** Construct and validate the complete candidate before replacing derived state. */
  rebuild(rows: Iterable<{ rowid: bigint; fields: readonly string[] }>): void {
    const candidate = new SearchIndex(this.columns, this.tokenizer);
    for (const row of rows) candidate.put(row.rowid, row.fields);
    this.restore(candidate.dump());
  }
}
