import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { PeerTransport } from "../src/transport.ts";

for (const scenario of ["json", "offset", "checksum"]) {
  test(`malformed relay ${scenario} rejects the request without hanging`, async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    server.on("connection", (socket) =>
      socket.on("message", (request) => {
        const bytes = Buffer.from(request as Buffer);
        const payload =
          scenario === "json" ? Buffer.from("{") : Buffer.alloc(45);
        if (scenario !== "json") {
          payload.writeUInt32BE(4, 0);
          payload.writeUInt32BE(scenario === "offset" ? 1 : 0, 4);
          payload[8] = 4;
          payload.write("null", 41);
        }
        const response = Buffer.alloc(41 + payload.length);
        response.write("BPR1");
        response[4] = scenario === "json" ? 4 : 6;
        bytes.copy(response, 5, 5, 41);
        payload.copy(response, 41);
        socket.send(response);
      }),
    );
    try {
      const address = server.address() as { port: number };
      // Startup is not the timing assertion: under the parallel SQL suite a
      // 100ms handshake can expire before the malformed response is inspected.
      const peer = new PeerTransport(`ws://127.0.0.1:${address.port}`, 2000);
      await assert.rejects(peer.snapshot(), /invalid|mismatch/i);
    } finally {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
