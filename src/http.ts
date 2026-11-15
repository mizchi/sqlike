import { SyncFailure } from "./errors.ts";
import type { SyncIssue } from "./safety-contract.ts";

export const MAX_RESPONSE = 64 * 1024 * 1024;
export async function timedRequest<T>(input: string, init: RequestInit | undefined, consume: (response: Response) => Promise<T>, request: typeof fetch = (...args) => fetch(...args), timeoutMs = 10000): Promise<T> {
  const controller = new AbortController();
  let timer!: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SyncFailure({ kind: "transport", code: "timeout", message: "request timed out; the operation may already have committed", disposition: "defer", retryable: true }));
    }, timeoutMs);
  });
  try { return await Promise.race([request(input, { ...init, signal: controller.signal }).then(consume), deadline]); }
  catch (error) {
    if (controller.signal.aborted) throw new SyncFailure({ kind: "transport", code: "timeout", message: "request timed out; the operation may already have committed", disposition: "defer", retryable: true });
    throw error;
  } finally { clearTimeout(timer); }
}
export async function responseBytes(response: Response, max = MAX_RESPONSE): Promise<Uint8Array> {
  if (!response.body) throw new Error("response body is missing");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.length;
      if (size > max) { await reader.cancel(); throw new SyncFailure({ kind: "resource", code: "response-size", message: `response exceeds ${max} bytes`, disposition: "defer", retryable: false }); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
export async function responseJSON(response: Response): Promise<unknown> {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(await responseBytes(response)));
}
export function remoteIssue(value: unknown, status: number): SyncIssue {
  const body = value as { error?: unknown; issue?: SyncIssue } | undefined;
  const issue = body?.issue;
  if (issue && ["ambiguous", "schema", "integrity", "application", "transport", "resource"].includes(issue.kind) && ["defer", "reject"].includes(issue.disposition) && typeof issue.message === "string" && typeof issue.code === "string" && typeof issue.retryable === "boolean") return issue;
  return { kind: status >= 500 ? "transport" : "application", code: `http-${status}`, message: typeof body?.error === "string" ? body.error : `HTTP ${status}`, disposition: "defer", retryable: status >= 500 || status === 404 };
}
