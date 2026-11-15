import type { Ack, ClientState, Mode, Statement, Value } from "./contract.ts";
import { statement } from "./client.ts";
import type { ClientResolution, ExecuteOptions } from "./safety-contract.ts";
import {
  browserCapabilities,
  defaultSyncMode,
  defaultBrowserEngine,
  parseBrowserEngine,
} from "./browser-engine.ts";

const params = new URLSearchParams(location.search);
const room = params.get("room") ?? "demo";
const backend = params.get("backend") ?? "node";
const engine = parseBrowserEngine(params.get("engine") ?? defaultBrowserEngine);
const isHost = params.get("role") === "host";
const name = params.get("client") ?? (isHost ? `host-${room}` : "local");
if (!/^[a-zA-Z0-9_-]{1,64}$/.test(room) || !/^[a-zA-Z0-9_-]{1,64}$/.test(name))
  throw new Error("invalid room/client name");
const endpoint =
  backend === "do"
    ? `/do-api/${room}`
    : backend === "peer-do"
      ? `${location.origin.replace("http", "ws")}/do-relay/${room}`
      : backend === "peer"
        ? `${location.origin.replace("http", "ws")}/relay/${room}`
        : `/api/${room}`;
let worker: Worker;
let counter = 0;
const calls = new Map<
  number,
  { resolve(value: unknown): void; reject(error: Error): void }
>();
function startWorker(): Worker {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
  });
  worker.onmessage = (event) => {
    const call = calls.get(event.data.id);
    if (!call) return;
    calls.delete(event.data.id);
    if (event.data.error) call.reject(new Error(event.data.error));
    else call.resolve(event.data.result);
  };
  worker.onerror = (event) => {
    for (const call of calls.values()) call.reject(new Error(event.message));
    calls.clear();
  };
  return worker;
}
function call<T>(method: string, ...args: unknown[]): Promise<T> {
  if (!worker) return Promise.reject(new Error("database is initializing"));
  return new Promise((resolve, reject) => {
    const id = ++counter;
    calls.set(id, { resolve: (v) => resolve(v as T), reject });
    worker.postMessage({ id, method, args });
  });
}
const status = document.querySelector<HTMLElement>("#status")!;
const output = document.querySelector<HTMLElement>("#output")!;
function render(state: ClientState): void {
  status.textContent = `revision ${state.revision} · pending ${state.pending.length}${state.pending.some((p) => p.status === "deferred" || p.status === "rejected") ? " · needs resolution" : ""}`;
  output.textContent = JSON.stringify(state, null, 2);
}
async function action(body: () => Promise<unknown>): Promise<void> {
  try {
    await body();
    render(await call<ClientState>("state"));
    document.querySelector("#error")!.textContent = "";
  } catch (e) {
    document.querySelector("#error")!.textContent =
      e instanceof Error ? e.message : String(e);
    if (!isHost) render(await call<ClientState>("state"));
  }
}
const api = {
  ready: false,
  engine,
  capabilities: browserCapabilities[engine],
  async execute(
    sql: string,
    values: Value[] = [],
    mode: Mode = defaultSyncMode(engine),
    options?: ExecuteOptions,
  ) {
    const id = await call<string>(
      "execute",
      [statement(sql, values)],
      mode,
      options,
    );
    render(await call<ClientState>("state"));
    return id;
  },
  async batch(statements: Statement[], mode: Mode, options?: ExecuteOptions) {
    return call<string>("execute", statements, mode, options);
  },
  async sync() {
    const state = await call<ClientState>("sync");
    render(state);
    return state;
  },
  state: () => call<ClientState>("state"),
  query: (sql: string, values: Value[] = []) => call("query", sql, values),
  async discard() {
    const state = await call<ClientState>("discard");
    render(state);
    return state;
  },
  async resolve(decision: ClientResolution) {
    const state = await call<ClientState>("resolve", decision);
    render(state);
    return state;
  },
  resolutions: () => call<unknown[]>("resolutions"),
  receipts: () => call<{ id: string; receipt: Ack }[]>("receipts"),
};
declare global {
  interface Window {
    syncDemo: typeof api;
  }
}
window.syncDemo = api;
document.querySelector("#context")!.textContent =
  `${backend} / ${engine} / ${room} / ${name}${isHost ? " / host" : ""}`;
if (!browserCapabilities[engine].changesetCapture)
  document.querySelector<HTMLSelectElement>("#mode")!.value = "sql";
document
  .querySelector("#execute")!
  .addEventListener(
    "click",
    () =>
      void action(() =>
        api.execute(
          (document.querySelector("#sql") as HTMLTextAreaElement).value,
          [],
          document.querySelector<HTMLSelectElement>("#mode")!.value as Mode,
        ),
      ),
  );
document
  .querySelector("#sync")!
  .addEventListener("click", () => void action(() => api.sync()));
document
  .querySelector("#discard")!
  .addEventListener("click", () => void action(() => api.discard()));

try {
  // Control engine loading from its first request so optional modules can be
  // cached on demand and still survive the first offline reload.
  if ("serviceWorker" in navigator && !import.meta.env.DEV) {
    await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise<void>((resolve) => {
        const changed = () => {
          if (navigator.serviceWorker.controller) {
            navigator.serviceWorker.removeEventListener(
              "controllerchange",
              changed,
            );
            resolve();
          }
        };
        navigator.serviceWorker.addEventListener("controllerchange", changed);
        changed();
      });
  }
  worker = startWorker();
  const state = await call<ClientState>("init", {
    name,
    endpoint,
    engine,
    host: isHost,
    physicalReplica: backend === "litestream",
    directLtx: backend === "ltx",
  });
  if (isHost) {
    status.textContent = "Peer host ready · keep this tab open";
    output.textContent = `このブラウザの ${engine === "sqlike" ? "IndexedDB" : "OPFS"} が正本です。リレーはバイナリを転送します。`;
  } else render(state);
  api.ready = true;
} catch (e) {
  status.textContent = "初期化失敗";
  document.querySelector("#error")!.textContent = String(e);
}
