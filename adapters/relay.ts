import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { WebSocketServer, WebSocket } from "ws";
import { NodeDatabase } from "./node-database.ts";
import { SyncEngine } from "../src/engine.ts";
import { MAX_FRAME } from "../src/protocol.ts";
import { LitestreamReplica } from "./litestream.ts";
import { wireError } from "../src/errors.ts";
import { applicationPolicies } from "../src/application.ts";
import { SqlAotLtxStore } from "./aot-ltx-store.ts";
import { AotLtxGateway, aotLtxResponse } from "../src/aot-ltx-gateway.ts";
import { Readable } from "node:stream";

const port = Number(process.env.PORT ?? 19878);
const directory = process.env.DATA_DIR ?? "data";
mkdirSync(directory, { recursive: true });
const rooms = new Map<
  string,
  { db: NodeDatabase; engine: SyncEngine; replica?: LitestreamReplica }
>();
const gateways = new Map<
  string,
  { db: NodeDatabase; gateway: AotLtxGateway }
>();
const sockets = new Map<WebSocket, { room: string; host: boolean }>();
const server = createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1:14173");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type,Authorization,X-Aot-Ltx",
  );
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  if (request.method === "OPTIONS") {
    response.writeHead(204).end();
    return;
  }
  try {
    const url = new URL(request.url!, `http://127.0.0.1:${port}`);
    const upload = /^\/aot-ltx\/([A-Za-z0-9_-]{1,64})(?:\/.*)?$/.exec(
      url.pathname,
    );
    if (upload) {
      const room = upload[1]!;
      if (!gateways.has(room)) {
        mkdirSync(`${directory}/aot-ltx`, { recursive: true });
        const db = new NodeDatabase(`${directory}/aot-ltx/${room}.sqlite`);
        db.run("PRAGMA synchronous=FULL");
        gateways.set(room, {
          db,
          gateway: new AotLtxGateway(new SqlAotLtxStore(db)),
        });
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (value !== undefined)
          headers.set(key, Array.isArray(value) ? value.join(",") : value);
      }
      const init: RequestInit & { duplex?: string } = {
        method: request.method,
        headers,
      };
      if (request.method !== "GET" && request.method !== "HEAD") {
        init.body = Readable.toWeb(request) as ReadableStream<Uint8Array>;
        init.duplex = "half";
      }
      const result = await aotLtxResponse(
        gateways.get(room)!.gateway,
        new Request(url, init),
      );
      for (const [key, value] of result.headers) response.setHeader(key, value);
      response
        .writeHead(result.status)
        .end(Buffer.from(await result.arrayBuffer()));
      return;
    }
    const match =
      /^\/api\/([a-zA-Z0-9_-]{1,64})\/(snapshot|replica|push|ltx)(?:\/([0-9]\/[0-9a-f]{16}-[0-9a-f]{16}\.ltx))?$/.exec(
        url.pathname,
      );
    if (!match) {
      response.writeHead(404).end();
      return;
    }
    const room = match[1]!;
    if (!rooms.has(room)) {
      const path = `${directory}/${room}.sqlite`;
      const db = new NodeDatabase(path);
      if (process.env.LITESTREAM_BIN) {
        // Create Litestream's documented metadata before publishing a schema stamp.
        db.run(
          "CREATE TABLE IF NOT EXISTS _litestream_seq(id INTEGER PRIMARY KEY,seq INTEGER)",
        );
        db.run("CREATE TABLE IF NOT EXISTS _litestream_lock(id INTEGER)");
      }
      const engine = new SyncEngine(db, true, {
        policies: applicationPolicies,
      });
      const replica = process.env.LITESTREAM_BIN
        ? new LitestreamReplica(
            process.env.LITESTREAM_BIN,
            path,
            `${directory}/replicas/${room}`,
          )
        : undefined;
      rooms.set(room, { db, engine, replica });
    }
    const engine = rooms.get(room)!.engine;
    let result: unknown;
    if (request.method === "GET" && match[2] === "snapshot")
      result = engine.snapshot();
    else if (request.method === "GET" && match[2] === "ltx") {
      const replica = rooms.get(room)!.replica;
      if (!replica) {
        response
          .writeHead(501)
          .end(
            JSON.stringify({
              error: "set LITESTREAM_BIN to enable LTX replication",
            }),
          );
        return;
      }
      if (match[3]) {
        const bytes = await replica.file(match[3]);
        response
          .writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Length": bytes.length,
            "Cache-Control": "no-store",
          })
          .end(bytes);
        return;
      }
      engine.schema();
      result = await replica.catalog(engine.revision());
      response.setHeader("Cache-Control", "no-store");
    } else if (request.method === "GET" && match[2] === "replica") {
      const replica = rooms.get(room)!.replica;
      if (!replica) {
        response
          .writeHead(501)
          .end(
            JSON.stringify({
              error: "set LITESTREAM_BIN to enable the real replica",
            }),
          );
        return;
      }
      engine.schema();
      result = await replica.snapshot(engine.revision());
    } else if (request.method === "POST" && match[2] === "push") {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_FRAME) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      result = engine.push(Buffer.concat(chunks));
    } else {
      response.writeHead(405).end();
      return;
    }
    response
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify(result));
  } catch (e) {
    const error = wireError(e);
    response
      .writeHead(error.status, { "Content-Type": "application/json" })
      .end(JSON.stringify(error.body));
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME + 64 });
server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url!, `http://127.0.0.1:${port}`);
  const match = /^\/relay\/([a-zA-Z0-9_-]{1,64})$/.exec(url.pathname);
  const host = url.searchParams.get("role") === "host";
  if (
    !match ||
    (host && [...sockets.values()].some((p) => p.room === match[1] && p.host))
  ) {
    socket.end("HTTP/1.1 409 Conflict\r\n\r\n");
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    sockets.set(ws, { room: match[1]!, host });
    ws.on("message", (bytes, binary) => {
      if (!binary) {
        ws.close(1003, "binary required");
        return;
      }
      for (const [peer, info] of sockets)
        if (
          peer !== ws &&
          info.room === match[1] &&
          info.host !== host &&
          peer.readyState === WebSocket.OPEN
        )
          peer.send(bytes, { binary: true });
    });
    ws.on("close", () => sockets.delete(ws));
    ws.on("error", () => sockets.delete(ws));
  });
});
server.listen(port, "127.0.0.1", () =>
  console.log(`SQLite authority + opaque peer relay: http://127.0.0.1:${port}`),
);
function shutdown() {
  for (const ws of sockets.keys()) ws.terminate();
  wss.close();
  server.close(async () => {
    for (const { db, replica } of rooms.values()) {
      await replica?.close();
      db.close();
    }
    for (const { db } of gateways.values()) db.close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
