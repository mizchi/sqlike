import { encode_ltx, ltx_info, ltx_data } from "../../_build/js/release/build/mizchi/litestream/litestream.js";
import { failure } from "../../src/errors.ts";
import type { LtxInfo } from "../../src/ltx.ts";
export { applyLtx, planLtx, MAX_IMAGE } from "../../src/ltx.ts";
export type { LtxInfo, LtxFile } from "../../src/ltx.ts";
export function encodeLtx(base: Uint8Array, image: Uint8Array, minTXID: string, maxTXID: string, timestamp = "0"): { data: Uint8Array<ArrayBuffer>; info: LtxInfo } {
  const result = encode_ltx(base, image, minTXID, maxTXID, timestamp);
  const info = JSON.parse(ltx_info(result)) as LtxInfo & { error?: string };
  if (info.error) throw failure("ltx-invalid", info.error, "integrity");
  // The fixed MoonBit runtime allocates these Bytes in a fresh ArrayBuffer.
  return { data: ltx_data(result) as Uint8Array<ArrayBuffer>, info };
}
