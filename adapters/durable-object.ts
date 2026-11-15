import { DurableObject } from "cloudflare:workers";
import { DODatabase } from "./do-database.ts";
import type { SyncEngine } from "../src/engine.ts";
import { wireError } from "../src/errors.ts";
import { SqlAotLtxStore } from "./aot-ltx-store.ts";
import type { AotLtxGateway } from "../src/aot-ltx-gateway.ts";

const MAX_FRAME = 1048576 + 271;

interface Env {
  SYNC_ROOMS: DurableObjectNamespace<SyncRoom>;
  PEER_RELAYS: DurableObjectNamespace<PeerRelay>;
  AOT_LTX_ROOMS: DurableObjectNamespace<AotLtxRoom>;
}

/** Stores a browser-owned physical history as BLOBs; never imports pages into
 * the Durable Object's own SQLite database or the SQL authority's SyncRoom. */
export class AotLtxRoom extends DurableObject<Env> {
  private gateway!: AotLtxGateway;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const { AotLtxGateway } = await import("../src/aot-ltx-gateway.ts");
      this.gateway = new AotLtxGateway(
        new SqlAotLtxStore(new DODatabase(ctx.storage), () =>
          ctx.storage.sync(),
        ),
      );
    });
  }
  async fetch(request: Request): Promise<Response> {
    const { aotLtxResponse } = await import("../src/aot-ltx-gateway.ts");
    return aotLtxResponse(this.gateway, request);
  }
}

export class SyncRoom extends DurableObject<Env> {
  private engine!: SyncEngine;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // MoonBit initializes a randomized map hash seed. Workers forbid randomness
    // at module scope, so load the generated core inside the DO request context.
    ctx.blockConcurrencyWhile(async () => {
      const { SyncEngine } = await import("../src/engine.ts");
      const { applicationPolicies } = await import("../src/application.ts");
      this.engine = new SyncEngine(new DODatabase(ctx.storage), true, {
        policies: applicationPolicies,
      });
    });
  }
  async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path.endsWith("/snapshot"))
        return Response.json(this.engine.snapshot());
      if (request.method === "POST" && path.endsWith("/push")) {
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (bytes.length > MAX_FRAME)
          return new Response("frame too large", { status: 413 });
        return Response.json(this.engine.push(bytes));
      }
      return new Response("not found", { status: 404 });
    } catch (e) {
      const error = wireError(e);
      return Response.json(error.body, { status: error.status });
    }
  }
}

/** Opaque binary relay. The selected browser peer owns the SQLite authority. */
export class PeerRelay extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket")
      return new Response("websocket required", { status: 426 });
    const host = new URL(request.url).searchParams.get("role") === "host";
    if (host && this.ctx.getWebSockets("host").length)
      return new Response("room already has a host", { status: 409 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [host ? "host" : "client"]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  webSocketMessage(sender: WebSocket, message: ArrayBuffer | string): void {
    if (typeof message === "string" || message.byteLength > MAX_FRAME + 64) {
      sender.close(1009, "binary frame required");
      return;
    }
    const hosts = this.ctx.getWebSockets("host");
    const targets = hosts.includes(sender)
      ? this.ctx.getWebSockets("client")
      : hosts;
    for (const peer of targets) peer.send(message);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS")
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "http://127.0.0.1:14173",
          "Access-Control-Allow-Headers":
            "Content-Type,Authorization,X-Aot-Ltx",
          "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
        },
      });
    const match =
      /^\/(api|relay|aot-ltx)\/([a-zA-Z0-9_-]{1,64})(?:\/.*)?$/.exec(
        url.pathname,
      );
    if (!match) return new Response("not found", { status: 404 });
    const response =
      match[1] === "aot-ltx"
        ? await env.AOT_LTX_ROOMS.get(
            env.AOT_LTX_ROOMS.idFromName(match[2]!),
          ).fetch(request)
        : match[1] === "api"
          ? await env.SYNC_ROOMS.get(
              env.SYNC_ROOMS.idFromName(match[2]!),
            ).fetch(request)
          : await env.PEER_RELAYS.get(
              env.PEER_RELAYS.idFromName(match[2]!),
            ).fetch(request);
    if (response.status === 101) return response;
    const headers = new Headers(response.headers);
    headers.set("Access-Control-Allow-Origin", "http://127.0.0.1:14173");
    return new Response(response.body, { status: response.status, headers });
  },
};
