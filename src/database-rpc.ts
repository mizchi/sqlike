import type { ResultCell, Value } from "./contract.ts";
import { failure, SyncFailure } from "./errors.ts";
import { MAX_RESPONSE } from "./http.ts";
import { unpack } from "./protocol.ts";

/** SQL and bound values sent from the sync-engine Worker to the async driver's owner. */
export type DatabaseCommand = { sql: string; params: Value[] };
export interface DatabaseReply {
  rows?: Record<string, ResultCell>[];
  error?: string;
  code?: string;
  resource?: boolean;
}
export const RPC_HEADER = 8;
export function replyToDatabase(
  buffer: SharedArrayBuffer,
  reply: DatabaseReply,
): void {
  const header = new Int32Array(buffer, 0, 2);
  let bytes = new TextEncoder().encode(JSON.stringify(reply));
  if (bytes.length > buffer.byteLength - RPC_HEADER)
    bytes = new TextEncoder().encode(
      JSON.stringify({
        error: "database result exceeds the bridge limit",
        resource: true,
      }),
    );
  new Uint8Array(buffer, RPC_HEADER, bytes.length).set(bytes);
  Atomics.store(header, 1, bytes.length);
  Atomics.store(header, 0, 1);
  Atomics.notify(header, 0);
}

/** A timed-out call poisons the connection: its transaction outcome is unknown. */
export class DatabaseBridge {
  private stopped = false;
  private header: Int32Array;
  constructor(
    private buffer: SharedArrayBuffer,
    private send: (command: DatabaseCommand) => void,
    private stop: () => void,
    private timeoutMs = 10000,
  ) {
    if (
      buffer.byteLength < RPC_HEADER + 128 ||
      buffer.byteLength > RPC_HEADER + MAX_RESPONSE
    )
      throw new Error("invalid database bridge size");
    this.header = new Int32Array(buffer, 0, 2);
  }
  all(sql: string, params: Value[] = []): Record<string, Value>[] {
    if (this.stopped)
      throw failure(
        "storage-closed",
        "database connection is unavailable; reload before continuing",
        "transport",
      );
    Atomics.store(this.header, 0, 0);
    try {
      this.send({ sql, params });
    } catch (error) {
      this.close();
      throw error;
    }
    if (Atomics.wait(this.header, 0, 0, this.timeoutMs) === "timed-out") {
      this.close();
      throw new SyncFailure({
        kind: "transport",
        code: "storage-timeout",
        message:
          "database request timed out; reload to recover its transaction outcome",
        disposition: "defer",
        retryable: false,
      });
    }
    const length = Atomics.load(this.header, 1);
    if (
      Atomics.load(this.header, 0) !== 1 ||
      length < 0 ||
      length > this.buffer.byteLength - RPC_HEADER
    ) {
      this.close();
      throw failure("storage-reply", "invalid database reply", "integrity");
    }
    let reply: DatabaseReply;
    try {
      reply = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          new Uint8Array(this.buffer, RPC_HEADER, length).slice(),
        ),
      );
    } catch {
      this.close();
      throw failure(
        "storage-reply",
        "invalid database reply JSON",
        "integrity",
      );
    }
    if (reply.error) {
      if (reply.resource)
        throw failure("storage-size", reply.error, "resource");
      if (
        ["SQLITE_ERROR", "SQLITE_MISMATCH", "SQLITE_RANGE"].includes(
          reply.code ?? "",
        )
      )
        throw failure("unsupported-sql", reply.error, "application", "reject");
      throw new Error(reply.error);
    }
    if (!Array.isArray(reply.rows)) {
      this.close();
      throw failure("storage-reply", "missing database rows", "integrity");
    }
    return reply.rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([name, cell]) => [name, unpack(cell)]),
      ),
    );
  }
  close(): void {
    if (!this.stopped) {
      this.stopped = true;
      this.stop();
    }
  }
}
