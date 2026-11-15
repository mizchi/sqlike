import { applyLtx } from "./ltx.ts";
import { sha256 } from "./aot-values.ts";
import { responseBytes } from "./http.ts";
import {
  AotUploadError,
  hashString,
  ltxFilename,
  parseLtxUpload,
  type AotLtxStore,
  type AotLtxUpload,
  type AotLtxAck,
} from "./aot-upload-contract.ts";

export class AotLtxGateway {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private store: AotLtxStore) {}
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.queue.then(fn);
    this.queue = task.catch(() => {});
    return task;
  }
  async accept(
    input: AotLtxUpload,
    token: string,
    inputBytes: Uint8Array,
  ): Promise<AotLtxAck> {
    const file = parseLtxUpload(input),
      bytes = Uint8Array.from(inputBytes);
    return this.serial(async () => {
      if (!hashString(token))
        throw new AotUploadError(401, "owner", "LTX publisher token required");
      if (bytes.length !== file.size || (await sha256(bytes)) !== file.sha256)
        throw new AotUploadError(
          400,
          "hash",
          "LTX upload size or SHA-256 mismatch",
        );
      const state = await this.store.state(),
        ownerHash = await sha256(token);
      if (
        state &&
        (state.ownerHash !== ownerHash ||
          state.historyId !== file.historyId ||
          state.artifactSHA256 !== file.artifactSHA256)
      )
        throw new AotUploadError(
          409,
          "owner",
          "LTX history is owned by a different publisher or Program",
        );
      const previous = await this.store.receipt(file.maxTXID);
      if (previous) {
        if (JSON.stringify(previous.upload) !== JSON.stringify(file))
          throw new AotUploadError(
            409,
            "fork",
            "different LTX bytes already accepted at this TXID",
          );
        const stored = await this.store.file(
          ltxFilename(file.minTXID, file.maxTXID),
        );
        if (
          stored.length !== file.size ||
          (await sha256(stored)) !== file.sha256
        )
          throw new AotUploadError(
            409,
            "storage",
            "accepted LTX file is missing or corrupt",
          );
        // Also wait for unconfirmed writes when retrying an uncertain commit.
        await this.store.confirm();
        return previous.ack;
      }
      if (file.baseTXID !== (state?.head ?? "0"))
        throw new AotUploadError(
          409,
          "base",
          "LTX base TXID does not match the gateway head",
        );
      const base = state ? await this.store.image() : new Uint8Array();
      if (state && (await sha256(base)) !== state.imageSHA256)
        throw new AotUploadError(
          409,
          "storage",
          "stored LTX base hash mismatch",
        );
      let applied;
      try {
        applied = applyLtx(base, file.baseTXID, bytes, 3);
      } catch (error) {
        throw new AotUploadError(
          400,
          "ltx",
          `invalid LTX chain: ${(error as Error).message}`,
        );
      }
      if (
        applied.info.minTXID !== file.minTXID ||
        applied.info.maxTXID !== file.maxTXID
      )
        throw new AotUploadError(
          400,
          "header",
          "LTX header and upload TXID differ",
        );
      const imageSHA256 = await sha256(applied.data);
      const ack: AotLtxAck = {
        format: "aot-ltx-ack@1",
        historyId: file.historyId,
        artifactSHA256: file.artifactSHA256,
        minTXID: file.minTXID,
        maxTXID: file.maxTXID,
        sha256: file.sha256,
        imageSHA256,
      };
      await this.store.commit(
        state?.head,
        {
          historyId: file.historyId,
          artifactSHA256: file.artifactSHA256,
          ownerHash,
          head: file.maxTXID,
          imageSHA256,
        },
        { upload: file, ack },
        bytes,
        applied.data,
      );
      return ack;
    });
  }
  catalog() {
    return this.serial(async () => {
      const state = await this.store.state();
      return {
        format: "aot-ltx-gateway@1",
        head: state?.head ?? "0",
        ...(state
          ? {
              historyId: state.historyId,
              artifactSHA256: state.artifactSHA256,
              imageSHA256: state.imageSHA256,
            }
          : {}),
        files: (await this.store.files()).map((f) => ({
          ...f.upload,
          imageSHA256: f.ack.imageSHA256,
          name: ltxFilename(f.upload.minTXID, f.upload.maxTXID),
        })),
      };
    });
  }
  file(name: string) {
    return this.serial(async () => {
      if (!/^[0-9a-f]{16}-[0-9a-f]{16}\.ltx$/.test(name))
        throw new AotUploadError(400, "name", "invalid LTX filename");
      const receipt = await this.store.receipt(
        String(BigInt(`0x${name.slice(17, 33)}`)),
      );
      if (
        !receipt ||
        name !== ltxFilename(receipt.upload.minTXID, receipt.upload.maxTXID)
      )
        throw new AotUploadError(404, "missing", "LTX file not found");
      const bytes = await this.store.file(name);
      if (
        bytes.length !== receipt.upload.size ||
        (await sha256(bytes)) !== receipt.upload.sha256
      )
        throw new AotUploadError(
          409,
          "storage",
          "stored LTX file hash mismatch",
        );
      return bytes;
    });
  }
}

/** Shared HTTP handler for the Node relay and the DO storage gateway. */
export async function aotLtxResponse(
  gateway: AotLtxGateway,
  request: Request,
): Promise<Response> {
  try {
    const path = new URL(request.url).pathname;
    const match =
      /^\/(?:aot-ltx|do-aot-ltx)\/[A-Za-z0-9_-]{1,64}(?:\/([0-9a-f]{16}-[0-9a-f]{16}\.ltx))?$/.exec(
        path,
      );
    if (!match)
      throw new AotUploadError(404, "path", "LTX gateway path not found");
    const name = match[1];
    if (request.method === "GET" && !name)
      return Response.json(await gateway.catalog(), {
        headers: { "Cache-Control": "no-store" },
      });
    if (request.method === "GET" && name)
      return new Response(Uint8Array.from(await gateway.file(name)), {
        headers: {
          "Content-Type": "application/octet-stream",
          "Cache-Control": "no-store",
        },
      });
    if (request.method !== "PUT" || !name)
      throw new AotUploadError(
        405,
        "method",
        "LTX gateway requires GET or PUT",
      );
    const header = request.headers.get("X-Aot-Ltx") ?? "";
    if (header.length > 2048)
      throw new AotUploadError(400, "metadata", "LTX metadata too large");
    const file = parseLtxUpload(JSON.parse(header));
    if (name !== ltxFilename(file.minTXID, file.maxTXID))
      throw new AotUploadError(400, "name", "LTX filename and TXID differ");
    const token =
      request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
    if (!hashString(token))
      throw new AotUploadError(401, "owner", "LTX publisher token required");
    if (request.headers.get("Content-Type") !== "application/octet-stream")
      throw new AotUploadError(415, "type", "binary LTX body required");
    const length = request.headers.get("Content-Length");
    if (length !== null && Number(length) !== file.size)
      throw new AotUploadError(400, "size", "LTX Content-Length mismatch");
    let bytes;
    try {
      bytes = await responseBytes(new Response(request.body), file.size);
    } catch {
      throw new AotUploadError(
        413,
        "size",
        "LTX body exceeds the declared size or is truncated",
      );
    }
    return Response.json(await gateway.accept(file, token, bytes), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const e = error as Error;
    return Response.json(
      {
        error: e.message,
        code: error instanceof AotUploadError ? error.code : "gateway",
      },
      {
        status:
          error instanceof AotUploadError
            ? error.status
            : error instanceof SyntaxError
              ? 400
              : 500,
      },
    );
  }
}
