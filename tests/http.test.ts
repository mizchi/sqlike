import { test } from "node:test";
import assert from "node:assert/strict";
import { timedRequest, responseBytes } from "../src/http.ts";

test("HTTP requests have a bounded timeout, including requests that never return headers", async () => {
  const fetcher: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
  await assert.rejects(timedRequest("https://example.invalid", undefined, response => response.text(), fetcher, 5), error => !!error && typeof error === "object" && "issue" in error && (error as { issue: { code: string } }).issue.code === "timeout");
});

test("oversized streams are cancelled before they can exceed the receive budget", async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(32)); }, cancel() { cancelled = true; } });
  await assert.rejects(responseBytes(new Response(body), 16), /exceeds/);
  assert.equal(cancelled, true);
});

test("a stalled response body cannot hold the client lock forever", async () => {
  const fetcher: typeof fetch = async () => new Response(new ReadableStream());
  await assert.rejects(timedRequest("https://example.invalid", undefined, response => responseBytes(response), fetcher, 5), /timed out/);
});
