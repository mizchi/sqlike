import { OfflineClient, statement } from "./client.ts";
import { SyncEngine } from "./engine.ts";
import { hostPeer, HttpTransport, PeerTransport } from "./transport.ts";
import { packResult, sqlAllowed } from "./protocol.ts";
import type { Mode, Statement, Value } from "./contract.ts";
import { OpfsImages } from "../adapters/opfs-images.ts";
import { IndexedDbImages } from "../adapters/indexeddb-images.ts";
import { LtxTransport } from "./ltx-transport.ts";
import { applicationPolicies, clientOptions } from "./application.ts";
import type { ClientResolution, ExecuteOptions } from "./safety-contract.ts";
import { openBrowserDatabase } from "../adapters/browser-database.ts";
import type { BrowserDatabase } from "./backend-contract.ts";
import {
  requireCapability,
  defaultBrowserEngine,
  parseBrowserEngine,
  type BrowserEngine,
} from "./browser-engine.ts";

type Command = { id: number; method: string; args: unknown[] };
let client: OfflineClient;
let host: WebSocket | undefined;
let serial = Promise.resolve();
let browserDatabase: BrowserDatabase;
async function dispatch(method: string, args: unknown[]): Promise<unknown> {
  if (method === "init") {
    const options = args[0] as {
      name: string;
      endpoint: string;
      engine?: BrowserEngine;
      host?: boolean;
      physicalReplica?: boolean;
      directLtx?: boolean;
    };
    const engine = parseBrowserEngine(options.engine ?? defaultBrowserEngine);
    if (options.directLtx) requireCapability(engine, "sqliteImageRead");
    const db = await openBrowserDatabase(engine, options.name);
    browserDatabase = db;
    if (options.host) {
      host = await hostPeer(
        options.endpoint,
        new SyncEngine(db, true, { policies: applicationPolicies }),
      );
      return { hosting: true };
    }
    let transport;
    if (options.directLtx) {
      if (!db.snapshotOf)
        throw new Error("database has no SQLite image reader");
      const direct = new LtxTransport(
        options.endpoint,
        db,
        engine === "sqlike"
          ? await IndexedDbImages.open(`moonbit-${options.name}`, (name) =>
              OpfsImages.open(name),
            )
          : await OpfsImages.open(options.name),
        (image) => db.snapshotOf!(image),
      );
      await direct.recover();
      transport = direct;
    } else
      transport = options.endpoint.startsWith("ws")
        ? new PeerTransport(options.endpoint)
        : new HttpTransport(options.endpoint, options.physicalReplica);
    client = new OfflineClient(db, transport, clientOptions);
    return client.state();
  }
  if (method === "execute")
    return client.execute(
      args[0] as Statement[],
      args[1] as Mode,
      args[2] as ExecuteOptions,
    );
  if (method === "sync") {
    await client.sync();
    return client.state();
  }
  if (method === "discard") {
    await client.discardPending();
    return client.state();
  }
  if (method === "state") return client.state();
  if (method === "resolve") {
    await client.resolvePending(args[0] as ClientResolution);
    return client.state();
  }
  if (method === "resolutions") return client.resolutions();
  if (method === "receipts") return client.receipts();
  if (method === "query") {
    const sql = args[0] as string;
    if (!sqlAllowed(sql)) throw new Error("SQL policy rejected query");
    return browserDatabase
      .query(sql, args[1] as Value[])
      .map((r) =>
        Object.fromEntries(
          Object.entries(r).map(([key, value]) => [key, packResult(value)]),
        ),
      );
  }
  throw new Error(`unknown method: ${method}`);
}
self.onmessage = (event: MessageEvent<Command>) => {
  const { id, method, args } = event.data;
  serial = serial.then(async () => {
    try {
      self.postMessage({ id, result: await dispatch(method, args) });
    } catch (e) {
      self.postMessage({
        id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });
};
