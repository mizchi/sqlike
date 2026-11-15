import type { AotDatabase } from "../adapters/aot-database.ts";
import { sha256 } from "./aot-values.ts";
import { responseBytes, timedRequest } from "./http.ts";
import {
  ltxFilename,
  parseLtxUpload,
  verifyLtxAck,
} from "./aot-upload-contract.ts";

export async function uploadAotLtx(
  db: Pick<AotDatabase, "bindUpload" | "pending" | "acknowledge">,
  endpoint: string,
  request: typeof fetch = (...args) => fetch(...args),
) {
  // Persist the destination and owner before attempting a network request.
  const binding = await db.bindUpload(endpoint),
    files = await db.pending();
  let uploaded = 0;
  for (const file of files) {
    if ((await sha256(file.data)) !== file.sha256)
      throw Error("pending LTX hash mismatch");
    const meta = parseLtxUpload({
      format: "aot-ltx-upload@1",
      historyId: binding.historyId,
      artifactSHA256: binding.artifactSHA256,
      baseTXID: String(BigInt(file.minTXID) - 1n),
      minTXID: file.minTXID,
      maxTXID: file.maxTXID,
      sha256: file.sha256,
      size: file.data.length,
    });
    await timedRequest(
      `${binding.endpoint}/${ltxFilename(file.minTXID, file.maxTXID)}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          Authorization: `Bearer ${binding.token}`,
          "X-Aot-Ltx": JSON.stringify(meta),
        },
        body: Uint8Array.from(file.data),
      },
      async (response) => {
        const body = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            await responseBytes(response, 4096),
          ),
        );
        if (!response.ok)
          throw Error(
            `LTX upload HTTP ${response.status}: ${(body as { error?: string }).error ?? "rejected"}`,
          );
        verifyLtxAck(body, meta);
      },
      request,
    );
    await db.acknowledge(file.maxTXID, file.sha256);
    uploaded++;
  }
  return { uploaded };
}
