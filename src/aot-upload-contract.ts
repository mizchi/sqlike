import type { AotCheckpoint } from "./aot-checkpoint-contract.ts";

/** A single publisher owns one physical SQLite/LTX history. SQL replication is
 * a separate protocol; these files cannot merge independent writers. */
export const AOT_LTX_MAX_BYTES = 64 * 1024 * 1024;
export const AOT_LTX_MAX_FILES = 50000;
export interface AotUploadBinding {
  endpoint: string;
  historyId: string;
  token: string;
  artifactSHA256: string;
}
/** Captured outbox bytes; storage and SQL execution remain the provider's concern. */
export interface AotLtxPendingFile {
  minTXID: string;
  maxTXID: string;
  sha256: string;
  data: Uint8Array;
}
export interface AotLtxUploadSource {
  bindUpload(endpoint: string): Promise<AotUploadBinding>;
  pending(): Promise<readonly AotLtxPendingFile[]>;
  acknowledge(head: string, sha256: string): Promise<void>;
}
export interface AotLtxSyncSource extends AotLtxUploadSource {
  checkpoint(): Promise<AotCheckpoint>;
}
export interface AotLtxUpload {
  format: "aot-ltx-upload@1";
  historyId: string;
  artifactSHA256: string;
  baseTXID: string;
  minTXID: string;
  maxTXID: string;
  sha256: string;
  size: number;
}
export interface AotLtxAck {
  format: "aot-ltx-ack@1";
  historyId: string;
  artifactSHA256: string;
  minTXID: string;
  maxTXID: string;
  sha256: string;
  imageSHA256: string;
}
export interface AotLtxReceipt {
  upload: AotLtxUpload;
  ack: AotLtxAck;
}
export interface AotLtxGatewayState {
  historyId: string;
  artifactSHA256: string;
  ownerHash: string;
  head: string;
  imageSHA256: string;
}
/** commit atomically stores the file, receipt, reconstructed image and head.
 * Its promise resolves only after durable commit. expectedHead is a CAS. */
export interface AotLtxStore {
  state(): Promise<AotLtxGatewayState | undefined>;
  image(): Promise<Uint8Array>;
  receipt(txid: string): Promise<AotLtxReceipt | undefined>;
  files(): Promise<AotLtxReceipt[]>;
  file(name: string): Promise<Uint8Array>;
  confirm(): Promise<void>;
  commit(
    expectedHead: string | undefined,
    state: AotLtxGatewayState,
    receipt: AotLtxReceipt,
    file: Uint8Array,
    image: Uint8Array,
  ): Promise<void>;
}
export class AotUploadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export const hashString = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
export const historyString = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v);
export function uploadTXID(v: unknown): bigint {
  if (
    typeof v !== "string" ||
    !/^(0|[1-9][0-9]{0,19})$/.test(v) ||
    BigInt(v) >= 1n << 64n
  )
    throw new AotUploadError(400, "txid", "invalid LTX upload TXID");
  return BigInt(v);
}
export function ltxFilename(min: string, max: string): string {
  return `${uploadTXID(min).toString(16).padStart(16, "0")}-${uploadTXID(max).toString(16).padStart(16, "0")}.ltx`;
}
export function uploadEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw Error("invalid LTX upload endpoint");
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.href.replace(/\/$/, "");
}
export function validUploadBinding(v: AotUploadBinding): boolean {
  return (
    !!v &&
    typeof v.endpoint === "string" &&
    historyString(v.historyId) &&
    hashString(v.token) &&
    hashString(v.artifactSHA256) &&
    uploadEndpoint(v.endpoint) === v.endpoint
  );
}
export function parseLtxUpload(value: unknown): AotLtxUpload {
  const v = value as AotLtxUpload;
  if (
    !v ||
    v.format !== "aot-ltx-upload@1" ||
    !historyString(v.historyId) ||
    !hashString(v.artifactSHA256) ||
    !hashString(v.sha256) ||
    !Number.isSafeInteger(v.size) ||
    v.size <= 0
  )
    throw new AotUploadError(400, "metadata", "invalid LTX upload metadata");
  if (v.size > AOT_LTX_MAX_BYTES)
    throw new AotUploadError(413, "size", "LTX upload exceeds 64 MiB");
  const base = uploadTXID(v.baseTXID),
    min = uploadTXID(v.minTXID),
    max = uploadTXID(v.maxTXID);
  if (min !== base + 1n || min !== max)
    throw new AotUploadError(
      400,
      "range",
      "LTX upload must advance exactly one TXID",
    );
  return {
    format: v.format,
    historyId: v.historyId,
    artifactSHA256: v.artifactSHA256,
    baseTXID: v.baseTXID,
    minTXID: v.minTXID,
    maxTXID: v.maxTXID,
    sha256: v.sha256,
    size: v.size,
  };
}
export function verifyLtxAck(value: unknown, file: AotLtxUpload): AotLtxAck {
  const ack = value as AotLtxAck;
  if (
    !ack ||
    ack.format !== "aot-ltx-ack@1" ||
    !hashString(ack.imageSHA256) ||
    !(
      ["historyId", "artifactSHA256", "minTXID", "maxTXID", "sha256"] as const
    ).every((k) => ack[k] === file[k])
  )
    throw Error("LTX acknowledgement identity or file hash mismatch");
  return ack;
}
