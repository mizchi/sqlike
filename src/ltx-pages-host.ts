import { toBase64, fromBase64 } from "./aot-values.ts";

export interface LtxPageCodec<Result = unknown> {
  encode_ltx_pages(state: string, metadata: string, data: Uint8Array): Result;
  encode_ltx_pages_binary?(
    state: string,
    metadata: string,
    data: Uint8Array,
    previous: Uint8Array,
  ): Result;
  ltx_info(result: Result): string;
  ltx_data(result: Result): Uint8Array;
}
export interface LtxPageBatch {
  pageSize: number;
  pageCount: number;
  snapshot: boolean;
  pages: readonly { page: number; data: Uint8Array }[];
}
export interface LtxChecksumStorage {
  /** Return owned BE64 entries in requested ascending order, checking generation. */
  readChecksums?(
    generation: number,
    pages: readonly number[],
  ): Promise<Uint8Array>;
}
export interface LtxStoredHead {
  metadata?: string;
  generation?: number;
}
export interface LtxPagePublication {
  metadata: string;
  files: { name: string; data: Uint8Array }[];
  checksumFormat?: "crc64-be@1";
  checksumSnapshot?: boolean;
  checksums?: { page: number; data: Uint8Array }[];
}
interface Encoding {
  data: Uint8Array;
  state: string;
  info: Record<string, unknown>;
  checksumFormat?: "crc64-be@1";
  checksumSnapshot?: boolean;
  checksums?: { page: number; data: Uint8Array }[];
}
interface PageEncoderBase {
  encode(
    state: string,
    batch: LtxPageBatch,
    minTXID: string,
    maxTXID?: string,
    timestamp?: string,
  ): Encoding;
  encodeStored(
    head: LtxStoredHead | undefined,
    batch: LtxPageBatch,
    minTXID: string,
    maxTXID?: string,
    timestamp?: string,
  ): Promise<Encoding>;
}
export function createPageLtxEncoder<Result>(
  runtime: LtxPageCodec<Result>,
): PageEncoderBase & {
  prepareCommit(
    head: LtxStoredHead | undefined,
    batch: LtxPageBatch,
  ): LtxPagePublication;
};
export function createPageLtxEncoder<Result>(
  runtime: LtxPageCodec<Result>,
  storage: LtxChecksumStorage | undefined,
): PageEncoderBase & {
  prepareCommit(
    head: LtxStoredHead | undefined,
    batch: LtxPageBatch,
  ): LtxPagePublication | Promise<LtxPagePublication>;
};
/** Database-independent adapter: only supplied pages cross the ABI. State is
 * returned as a candidate and must be published atomically with the file. */
export function createPageLtxEncoder<Result>(
  runtime: LtxPageCodec<Result>,
  storage?: LtxChecksumStorage,
) {
  function encode(
    state: string,
    batch: LtxPageBatch,
    minTXID: string,
    maxTXID = minTXID,
    timestamp = "0",
  ): Encoding {
    if (
      !Number.isInteger(batch.pageSize) ||
      batch.pageSize < 512 ||
      batch.pageSize > 65536 ||
      batch.pageSize & (batch.pageSize - 1) ||
      !Number.isInteger(batch.pageCount) ||
      batch.pageCount < 0 ||
      batch.pageCount > 67108864 / batch.pageSize ||
      !Array.isArray(batch.pages) ||
      batch.pages.length > batch.pageCount ||
      state.length > 8388608
    )
      throw Error("invalid LTX page batch size");
    const data = new Uint8Array(batch.pages.length * batch.pageSize);
    batch.pages.forEach((p, i) => {
      if (p.data.length !== batch.pageSize)
        throw Error("invalid LTX page length");
      data.set(p.data, i * batch.pageSize);
    });
    const metadata = {
      pageSize: batch.pageSize,
      pageCount: batch.pageCount,
      snapshot: batch.snapshot,
      pages: batch.pages.map((p) => p.page),
      min: minTXID,
      max: maxTXID,
      timestamp,
    };
    const result = runtime.encode_ltx_pages(
        state,
        JSON.stringify(metadata),
        data,
      ),
      info = JSON.parse(runtime.ltx_info(result));
    if (info.error) throw Error(info.error);
    return {
      data: runtime.ltx_data(result),
      info,
      state: JSON.stringify(info.pageState) as string,
    };
  }
  async function encodeStored(
    head: LtxStoredHead | undefined,
    batch: LtxPageBatch,
    minTXID: string,
    maxTXID = minTXID,
    timestamp = "0",
  ): Promise<Encoding> {
    const state = head?.metadata ?? "";
    if (!storage?.readChecksums || !runtime.encode_ltx_pages_binary) {
      if (state && JSON.parse(state).format === "ltx-page-state@2")
        throw Error("binary LTX checksum provider required");
      return encode(state, batch, minTXID, maxTXID, timestamp);
    }
    if (
      state.length > 8388608 ||
      !Number.isInteger(batch.pageSize) ||
      batch.pageSize < 512 ||
      batch.pageSize > 65536 ||
      batch.pageSize & (batch.pageSize - 1) ||
      !Number.isInteger(batch.pageCount) ||
      batch.pageCount < 0 ||
      batch.pageCount > 67108864 / batch.pageSize ||
      !Array.isArray(batch.pages) ||
      batch.pages.length > batch.pageCount
    )
      throw Error("invalid binary LTX page batch");
    batch = {
      ...batch,
      pages: batch.pages.map((p) => ({ page: p.page, data: p.data })),
    };
    const data = new Uint8Array(batch.pages.length * batch.pageSize);
    batch.pages.forEach((p, i) => {
      if (!(p.data instanceof Uint8Array) || p.data.length !== batch.pageSize)
        throw Error("invalid LTX page length");
      data.set(p.data, i * batch.pageSize);
    });
    const old = state
      ? (JSON.parse(state) as {
          format: string;
          pageSize: number;
          pageCount: number;
          pages?: [number, string][];
        })
      : undefined;
    if (
      old &&
      (!Number.isInteger(old.pageCount) ||
        old.pageCount < 0 ||
        old.pageCount > 67108864 / batch.pageSize ||
        old.pageSize !== batch.pageSize)
    )
      throw Error("invalid LTX checksum cursor");
    let previous: Uint8Array = new Uint8Array();
    if (old?.format === "ltx-page-state@2" && !batch.snapshot) {
      if (!Number.isSafeInteger(head?.generation) || head!.generation! < 1)
        throw Error("missing LTX checksum generation");
      const needed = [
        ...batch.pages
          .filter((p) => p.page <= old.pageCount)
          .map((p) => p.page),
        ...Array.from(
          { length: Math.max(old.pageCount - batch.pageCount, 0) },
          (_, i) => batch.pageCount + 1 + i,
        ),
      ];
      previous = await storage.readChecksums(head!.generation!, needed);
      if (previous.length !== needed.length * 8)
        throw Error("incomplete binary LTX checksums");
    }
    const result = runtime.encode_ltx_pages_binary(
      state,
      JSON.stringify({
        pageSize: batch.pageSize,
        pageCount: batch.pageCount,
        pages: batch.pages.map((p) => p.page),
        snapshot: batch.snapshot,
        min: minTXID,
        max: maxTXID,
        timestamp,
      }),
      data,
      previous,
    );
    const info = JSON.parse(runtime.ltx_info(result));
    if (info.error) throw Error(info.error);
    if (
      !info.pageState ||
      info.pageState.format !== "ltx-page-state@2" ||
      info.pageState.pageSize !== batch.pageSize ||
      info.pageState.pageCount !== batch.pageCount ||
      info.pageState.txid !== maxTXID
    )
      throw Error("invalid binary LTX cursor result");
    if (
      typeof info.pageChecksums !== "string" ||
      info.pageChecksums.length > Math.ceil((batch.pages.length * 8) / 3) * 4
    )
      throw Error("invalid binary LTX checksum result");
    const binary = fromBase64(info.pageChecksums);
    if (binary.length !== batch.pages.length * 8)
      throw Error("invalid binary LTX checksum result size");
    let checksums: { page: number; data: Uint8Array }[] = batch.pages.map(
      (p, i) => ({ page: p.page, data: binary.slice(i * 8, (i + 1) * 8) }),
    );
    const checksumSnapshot =
      batch.snapshot || !old || old.format === "ltx-page-state@1";
    if (old?.format === "ltx-page-state@1" && !batch.snapshot) {
      const all = new Map<number, Uint8Array>();
      for (const [page, value] of old.pages!)
        if (page <= batch.pageCount) {
          const data = new Uint8Array(8);
          new DataView(data.buffer).setBigUint64(0, BigInt(value));
          all.set(page, data);
        }
      for (const c of checksums) all.set(c.page, c.data);
      checksums = Array.from({ length: batch.pageCount }, (_, i) => {
        const data = all.get(i + 1);
        if (!data) throw Error("incomplete migrated checksum catalog");
        return { page: i + 1, data };
      });
    }
    return {
      data: runtime.ltx_data(result),
      info,
      state: JSON.stringify(info.pageState),
      checksums,
      checksumFormat: "crc64-be@1",
      checksumSnapshot,
    };
  }
  function prepareCommit(
    head: LtxStoredHead | undefined,
    batch: LtxPageBatch,
  ): LtxPagePublication | Promise<LtxPagePublication> {
    const previous = head?.metadata ?? "";
    if (previous.length > 8388608) throw Error("LTX page state input limit");
    const next = previous ? BigInt(JSON.parse(previous).txid) + 1n : 1n;
    if (storage && runtime.encode_ltx_pages_binary)
      return encodeStored(
        head,
        batch,
        String(next),
        String(next),
        String(Date.now()),
      ).then((result) => ({
        metadata: result.state,
        checksums: result.checksums,
        checksumFormat: result.checksumFormat,
        checksumSnapshot: result.checksumSnapshot,
        files: [
          {
            name: `${next.toString(16).padStart(16, "0")}-${next.toString(16).padStart(16, "0")}.ltx`,
            data: result.data,
          },
        ],
      }));
    const result = encode(
      previous,
      batch,
      String(next),
      String(next),
      String(Date.now()),
    );
    const id = next.toString(16).padStart(16, "0");
    return {
      metadata: result.state,
      files: [{ name: `${id}-${id}.ltx`, data: result.data }],
    };
  }
  return { encode, encodeStored, prepareCommit };
}

export function ltxPageWasm(raw: WebAssembly.Exports): LtxPageCodec {
  const core = raw as unknown as {
    encode_ltx_pages_base64(
      state: string,
      metadata: string,
      data: string,
    ): unknown;
    ltx_info(result: unknown): string;
    ltx_data_base64(result: unknown): string;
    encode_ltx_pages_binary_base64?(
      state: string,
      metadata: string,
      data: string,
      previous: string,
    ): unknown;
  };
  return {
    ...(core.encode_ltx_pages_binary_base64
      ? {
          encode_ltx_pages_binary: (
            state: string,
            metadata: string,
            data: Uint8Array,
            previous: Uint8Array,
          ) =>
            core.encode_ltx_pages_binary_base64!(
              state,
              metadata,
              toBase64(data),
              toBase64(previous),
            ),
        }
      : {}),
    encode_ltx_pages: (state, metadata, data) =>
      core.encode_ltx_pages_base64(state, metadata, toBase64(data)),
    ltx_info: (result) => core.ltx_info(result),
    ltx_data: (result) => fromBase64(core.ltx_data_base64(result)),
  };
}
