import {
  apply_ltx,
  ltx_data,
  ltx_info,
  plan_ltx,
} from "../_build/js/release/build/mizchi/litestream/litestream.js";
import { failure } from "./errors.ts";

export const MAX_IMAGE = 64 * 1024 * 1024;
export interface LtxInfo {
  minTXID: string;
  maxTXID: string;
  pageSize: number;
  pageCount: number;
  pagesApplied: number;
  postChecksum: string;
}
export interface LtxFile {
  id: string;
  minTXID: string;
  maxTXID: string;
  size: number;
}
export function applyLtx(
  base: Uint8Array,
  txid: string,
  file: Uint8Array,
  version: number,
): { data: Uint8Array<ArrayBuffer>; info: LtxInfo } {
  const result = apply_ltx(base, txid, file, version);
  const info = JSON.parse(ltx_info(result)) as LtxInfo & { error?: string };
  if (info.error) throw failure("ltx-invalid", info.error, "integrity");
  // MoonBit allocates the completed image in a fresh, non-shared Bytes array.
  return { data: ltx_data(result) as Uint8Array<ArrayBuffer>, info };
}
export function planLtx(
  files: LtxFile[],
  current: string,
  target: string,
): string[] {
  const result = JSON.parse(plan_ltx(JSON.stringify(files), current, target));
  if (result.error) throw failure("ltx-gap", result.error, "integrity");
  return result;
}
