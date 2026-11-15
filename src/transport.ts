import type { Ack, Snapshot } from "./contract.ts";
import type { Transport } from "./client.ts";
import { MAX_FRAME } from "./protocol.ts";
import type { SyncEngine } from "./engine.ts";
import { failure, SyncFailure, wireError } from "./errors.ts";
import { MAX_RESPONSE, remoteIssue, responseJSON, timedRequest } from "./http.ts";
import { sha256 } from "@noble/hashes/sha2.js";

export class HttpTransport implements Transport {
  constructor(private endpoint: string, private physicalReplica = false, private timeoutMs = 10000) {}
  private async request<T>(path: string, body?: Uint8Array): Promise<T> {
    return timedRequest(`${this.endpoint}/${path}`, body ? { method: "POST", body: body.slice().buffer, headers: { "Content-Type": "application/octet-stream" } } : undefined, async response => {
      const result = await responseJSON(response);
      if (!response.ok) throw new SyncFailure(remoteIssue(result, response.status));
      return result as T;
    }, undefined, this.timeoutMs);
  }
  push(bytes: Uint8Array): Promise<Ack> { return this.request("push", bytes); }
  snapshot(): Promise<Snapshot> { return this.request(this.physicalReplica ? "replica" : "snapshot"); }
}

/** BPR1: magic(4), kind(1), request UUID(36 ASCII), opaque payload. */
function rpc(kind: number, id: string, body: Uint8Array = new Uint8Array()): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(41 + body.length);
  bytes.set(new TextEncoder().encode("BPR1")); bytes[4] = kind;
  bytes.set(new TextEncoder().encode(id), 5); bytes.set(body, 41); return bytes;
}
function readRpc(bytes: Uint8Array): { kind: number; id: string; body: Uint8Array } {
  if (bytes.length < 41 || bytes.length > MAX_FRAME + 64 || new TextDecoder().decode(bytes.subarray(0, 4)) !== "BPR1") throw new Error("invalid relay frame");
  return { kind: bytes[4]!, id: new TextDecoder().decode(bytes.subarray(5, 41)), body: bytes.subarray(41) };
}
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

export class PeerTransport implements Transport {
  private socket?: WebSocket;
  private opening?: Promise<WebSocket>;
  private requests = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private assemblies = new Map<string, { data: Uint8Array; received: number; hash: Uint8Array; kind: number }>();
  constructor(private endpoint: string, private timeoutMs = 10000) {}
  private connect(): Promise<WebSocket> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve(this.socket);
    if (this.opening) return this.opening;
    this.opening = new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(this.endpoint); ws.binaryType = "arraybuffer";
      let opened = false;
      const timer = setTimeout(() => { reject(new Error("relay connection timeout")); ws.close(); }, this.timeoutMs);
      ws.onopen = () => { opened = true; clearTimeout(timer); this.socket = ws; resolve(ws); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error("relay connection failed")); };
      ws.onclose = () => {
        clearTimeout(timer);
        if (!opened) reject(new Error("relay connection closed"));
        if (this.socket !== ws) return;
        this.socket = undefined;
        for (const p of this.requests.values()) { clearTimeout(p.timer); p.reject(new Error("relay disconnected")); }
        this.requests.clear(); this.assemblies.clear();
      };
      ws.onmessage = event => {
        try {
          let { kind, id, body } = readRpc(new Uint8Array(event.data));
          const pending = this.requests.get(id); if (!pending) return;
          if (kind === 6) {
            try {
              if (body.length < 41) throw new Error("truncated relay chunk");
              const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
              const total = view.getUint32(0); const offset = view.getUint32(4); const originalKind = body[8]!;
              if (total < 1 || total > MAX_RESPONSE || ![3, 4].includes(originalKind)) throw new Error("invalid relay chunk size or kind");
              let assembly = this.assemblies.get(id);
              if (!assembly) { assembly = { data: new Uint8Array(total), received: 0, hash: body.slice(9, 41), kind: originalKind }; this.assemblies.set(id, assembly); }
              const chunk = body.subarray(41);
              if (!chunk.length || offset !== assembly.received || assembly.data.length !== total || assembly.kind !== originalKind || assembly.hash.some((b, i) => b !== body[9 + i]) || chunk.length > total - offset) throw new Error("relay chunk sequence mismatch");
              assembly.data.set(chunk, offset); assembly.received += chunk.length;
              if (assembly.received < total) return;
              if (sha256(assembly.data).some((b, i) => b !== assembly!.hash[i])) throw new Error("relay response checksum mismatch");
              body = assembly.data; kind = assembly.kind; this.assemblies.delete(id);
            } catch (error) {
              clearTimeout(pending.timer); this.requests.delete(id); this.assemblies.delete(id);
              pending.reject(failure("relay-chunk", String(error), "integrity")); return;
            }
          }
          let value: unknown;
          try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body)); }
          catch { clearTimeout(pending.timer); this.requests.delete(id); this.assemblies.delete(id); pending.reject(failure("relay-json", "invalid relay response JSON", "integrity")); return; }
          clearTimeout(pending.timer); this.requests.delete(id);
          if (kind === 255) pending.reject(new SyncFailure(remoteIssue(value, 409)));
          else if (kind === 3 || kind === 4) pending.resolve(value);
          else pending.reject(failure("relay-kind", "unexpected relay response", "integrity"));
        } catch {
          for (const pending of this.requests.values()) { clearTimeout(pending.timer); pending.reject(failure("relay-frame", "invalid relay frame", "integrity")); }
          this.requests.clear(); this.assemblies.clear(); ws.close(1002, "invalid frame");
        }
      };
    }).finally(() => { this.opening = undefined; });
    return this.opening!;
  }
  private async request<T>(kind: number, body?: Uint8Array): Promise<T> {
    const ws = await this.connect(); const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(id); this.assemblies.delete(id); reject(new SyncFailure({ kind: "transport", code: "host-timeout", message: "relay host timeout", disposition: "defer", retryable: true })); }, this.timeoutMs);
      this.requests.set(id, { resolve: value => resolve(value as T), reject, timer });
      try { ws.send(rpc(kind, id, body).buffer); }
      catch (error) { clearTimeout(timer); this.requests.delete(id); reject(error); }
    });
  }
  push(bytes: Uint8Array): Promise<Ack> { return this.request(1, bytes); }
  snapshot(): Promise<Snapshot> { return this.request(2); }
}

export async function hostPeer(endpoint: string, engine: SyncEngine): Promise<WebSocket> {
  const url = new URL(endpoint); url.searchParams.set("role", "host");
  const ws = new WebSocket(url); ws.binaryType = "arraybuffer";
  ws.onmessage = event => {
    let id: string;
    try {
      const message = readRpc(new Uint8Array(event.data)); id = message.id;
      if (message.kind !== 1 && message.kind !== 2) return;
      try {
        const result = message.kind === 1 ? engine.push(message.body) : engine.snapshot();
        const data = jsonBytes(result);
        if (data.length > MAX_RESPONSE) throw failure("relay-size", "relay response exceeds 64 MiB", "resource");
        if (data.length <= 65536) ws.send(rpc(message.kind + 2, id, data).buffer);
        else {
          const hash = sha256(data);
          for (let offset = 0; offset < data.length; offset += 65536) {
            const chunk = data.subarray(offset, offset + 65536); const payload = new Uint8Array(41 + chunk.length);
            const view = new DataView(payload.buffer); view.setUint32(0, data.length); view.setUint32(4, offset); payload[8] = message.kind + 2;
            payload.set(hash, 9); payload.set(chunk, 41); ws.send(rpc(6, id, payload).buffer);
          }
        }
      } catch (e) { ws.send(rpc(255, id, jsonBytes(wireError(e).body)).buffer); }
    } catch { /* Reject malformed frames without changing the database. */ }
  };
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error("relay host connection timeout")); ws.close(); }, 10000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("relay host connection failed (one host per room)")); };
  });
  return ws;
}
