import { toBase64, fromBase64 } from "./aot-values.ts";
import type {
  SqlitePagerRuntime,
  SqliteAotPagerRuntime,
  SqliteDefinedPagerRuntime,
} from "./sqlite-pager-contract.ts";

/** One page per transfer; no full-image base64 round trip on incremental writes. */
export function sqlitePagerWasm(
  raw: WebAssembly.Exports,
): SqliteAotPagerRuntime & SqliteDefinedPagerRuntime {
  const core = raw as unknown as SqliteAotPagerRuntime &
    SqliteDefinedPagerRuntime & {
      sqlite_pager_supply_base64(
        batch: unknown,
        page: number,
        data: string,
      ): string;
      sqlite_pager_page_base64(batch: unknown, index: number): string;
      defined_pager_prepare_base64(
        db: unknown,
        layout: string,
        pager: unknown,
      ): unknown;
    };
  return {
    sqlite_pager_open: () => core.sqlite_pager_open(),
    aot_pager_prepare: (db, pager) => core.aot_pager_prepare(db, pager),
    sqlite_pager_info: (batch) => core.sqlite_pager_info(batch),
    sqlite_pager_ack: (pager, batch) => core.sqlite_pager_ack(pager, batch),
    sqlite_pager_supply: (batch, page, data) =>
      core.sqlite_pager_supply_base64(batch, page, toBase64(data)),
    sqlite_pager_page: (batch, index) =>
      fromBase64(core.sqlite_pager_page_base64(batch, index)),
    defined_pager_prepare: (db, layout, pager) =>
      core.defined_pager_prepare_base64(db, toBase64(layout), pager),
  };
}
