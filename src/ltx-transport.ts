import type { Ack, Database, ReplicaState, Snapshot } from "./contract.ts";
import type { PreparedSnapshot, Transport } from "./client.ts";
import type { LtxCatalog, LtxCursor } from "./ltx-contract.ts";
import { applyLtx, MAX_IMAGE, planLtx } from "./ltx.ts";
import { HttpTransport } from "./transport.ts";
import { failure, SyncFailure } from "./errors.ts";
import { responseJSON, timedRequest } from "./http.ts";

import type { ReplicaImageStore as ImageStore } from "./persistence-contract.ts";
export type { ReplicaImageStore as ImageStore } from "./persistence-contract.ts";
export async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

function catalog(value: LtxCatalog): LtxCatalog {
  if (value?.format !== 3)
    throw failure(
      "ltx-version",
      "only LTX format v3 is supported",
      "resource",
      "reject",
    );
  const txid = (x: string) =>
    typeof x === "string" && /^(0|[1-9]\d*)$/.test(x) && BigInt(x) < 1n << 64n;
  if (
    value.format !== 3 ||
    typeof value.epoch !== "string" ||
    !/^[0-9a-f-]{36}$/.test(value.epoch) ||
    !txid(value.targetTXID) ||
    !Number.isSafeInteger(value.minRevision) ||
    value.minRevision < 0 ||
    !Array.isArray(value.files) ||
    value.files.length > 50000
  )
    throw new Error("invalid LTX catalog");
  const ids = new Set<string>();
  for (const file of value.files) {
    if (Number.isSafeInteger(file.size) && file.size > MAX_IMAGE)
      throw failure(
        "ltx-size",
        "LTX file exceeds the 64 MiB supported limit",
        "resource",
      );
    if (
      !/^[0-9]\/[0-9a-f]{16}-[0-9a-f]{16}\.ltx$/.test(file.id) ||
      !txid(file.minTXID) ||
      !txid(file.maxTXID) ||
      !/^[0-9a-f]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.size) ||
      file.size <= 0 ||
      file.size > MAX_IMAGE ||
      ids.has(file.id)
    )
      throw new Error("invalid LTX catalog entry");
    ids.add(file.id);
  }
  return value;
}

async function binary(
  response: Response,
  expected: number,
): Promise<Uint8Array> {
  if (!response.ok || !response.body)
    throw new Error(`LTX download failed: HTTP ${response.status}`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > expected || size > MAX_IMAGE) {
        await reader.cancel();
        throw new Error("LTX download exceeds declared size");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (size !== expected) throw new Error("truncated LTX download");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export class LtxTransport implements Transport {
  private http: HttpTransport;
  constructor(
    private endpoint: string,
    private db: Database,
    private store: ImageStore,
    private inspect: (image: Uint8Array) => Snapshot,
    private request: typeof fetch = (...args) => fetch(...args),
  ) {
    this.http = new HttpTransport(endpoint);
    db.run(
      "CREATE TABLE IF NOT EXISTS _bls_ltx_cursor(id INTEGER PRIMARY KEY,body TEXT NOT NULL)",
    );
  }
  cursor(): LtxCursor | undefined {
    const body = this.db.all("SELECT body FROM _bls_ltx_cursor WHERE id=1")[0]
      ?.body;
    if (!body) return undefined;
    const value = JSON.parse(String(body)) as LtxCursor;
    if (
      !/^image-[0-9a-f-]{36}\.sqlite$/.test(value.image) ||
      !/^[0-9a-f]{64}$/.test(value.sha256) ||
      !/^[1-9]\d*$/.test(value.txid) ||
      BigInt(value.txid) >= 1n << 64n ||
      typeof value.endpoint !== "string" ||
      !/^[0-9a-f-]{36}$/.test(value.epoch)
    )
      throw new Error("invalid persisted LTX cursor");
    return value;
  }
  replicaState(): ReplicaState | undefined {
    return this.cursor();
  }
  async recover(): Promise<void> {
    await this.store.prune(this.cursor()?.image);
  }
  push(bytes: Uint8Array): Promise<Ack> {
    return this.http.push(bytes);
  }
  async snapshot(): Promise<Snapshot> {
    const prepared = await this.prepareSnapshot();
    try {
      return prepared.snapshot;
    } finally {
      await prepared.dispose();
    }
  }
  async prepareSnapshot(
    options: { reset?: boolean } = {},
  ): Promise<PreparedSnapshot> {
    const manifest = await timedRequest(
      `${this.endpoint}/ltx`,
      undefined,
      async (response) => {
        if (!response.ok)
          throw new SyncFailure({
            kind: "transport",
            code: "ltx-catalog",
            message: `LTX catalog failed: HTTP ${response.status}`,
            disposition: "defer",
            retryable: response.status >= 500,
          });
        try {
          return catalog((await responseJSON(response)) as LtxCatalog);
        } catch (error) {
          if (error instanceof SyncFailure) throw error;
          throw failure("ltx-catalog", String(error), "integrity");
        }
      },
      this.request,
    );
    const previous = this.cursor();
    if (previous && previous.endpoint !== this.endpoint)
      throw failure("database", "LTX endpoint identity changed", "schema");
    if (previous && previous.epoch !== manifest.epoch && !options.reset)
      throw failure(
        "replica-identity",
        "LTX replica identity changed; explicit resnapshot policy is required",
        "schema",
      );
    let image: Uint8Array = new Uint8Array();
    if (previous && !options.reset) {
      try {
        image = await this.store.read(previous.image);
      } catch {
        throw failure(
          "replica-missing",
          "stored LTX image is missing; explicit resnapshot is required",
          "integrity",
        );
      }
      if ((await sha256(image)) !== previous.sha256)
        throw failure(
          "replica-corrupt",
          "stored LTX image checksum mismatch",
          "integrity",
        );
    }
    let txid = options.reset ? "0" : (previous?.txid ?? "0");
    const ids = planLtx(manifest.files, txid, manifest.targetTXID);
    let pagesApplied = 0;
    let bytesDownloaded = 0;
    for (const id of ids) {
      const entry = manifest.files.find((file) => file.id === id)!;
      const bytes = await timedRequest(
        `${this.endpoint}/ltx/${id}`,
        undefined,
        (response) => binary(response, entry.size),
        this.request,
      );
      if ((await sha256(bytes)) !== entry.sha256)
        throw failure(
          "ltx-checksum",
          "LTX download SHA-256 mismatch",
          "integrity",
        );
      const applied = applyLtx(image, txid, bytes, manifest.format);
      if (
        applied.info.minTXID !== entry.minTXID ||
        applied.info.maxTXID !== entry.maxTXID
      )
        throw new Error("LTX catalog/header mismatch");
      image = applied.data;
      txid = applied.info.maxTXID;
      pagesApplied += applied.info.pagesApplied;
      bytesDownloaded += bytes.length;
    }
    if (!image.length) throw new Error("LTX snapshot required");
    // Validate and inspect the completed SQLite image before staging it. The
    // selected database supplies its native or pure MoonBit reader.
    let snapshot: Snapshot;
    try {
      snapshot = this.inspect(image);
    } catch (error) {
      if (error instanceof SyncFailure) throw error;
      throw failure(
        "sqlite-image-invalid",
        `restored SQLite image rejected: ${error instanceof Error ? error.message : String(error)}`,
        "integrity",
      );
    }
    if (snapshot.revision < manifest.minRevision)
      throw new Error("LTX image has not reached acknowledged revision");
    const name = ids.length
      ? `image-${crypto.randomUUID()}.sqlite`
      : previous!.image;
    const cursor: LtxCursor = {
      epoch: manifest.epoch,
      endpoint: this.endpoint,
      txid,
      image: name,
      sha256: await sha256(image),
      imageBytes: image.length,
      filesApplied: ids.length,
      pagesApplied,
      bytesDownloaded,
    };
    const dispose = async () => {
      // Cleanup is retryable on startup. Never report a committed sync as failed
      // just because an unreferenced staging file could not be removed.
      try {
        await this.store.prune(this.cursor()?.image);
      } catch {
        /* recovery retries */
      }
    };
    try {
      if (ids.length) await this.store.write(name, image);
    } catch (e) {
      await dispose();
      throw e;
    }
    return {
      snapshot,
      commit: () =>
        this.db.run(
          "INSERT OR REPLACE INTO _bls_ltx_cursor(id,body) VALUES(1,?)",
          [JSON.stringify(cursor)],
        ),
      dispose,
    };
  }
}
