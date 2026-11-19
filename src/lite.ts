import type {
  AotDatabase,
  AotExecution,
  AotCheckpoint,
} from "../adapters/aot-database.ts";
import type { Value } from "./contract.ts";
type State = Awaited<ReturnType<AotDatabase["inspect"]>>;
type Pending = Awaited<ReturnType<AotDatabase["pending"]>>;
const started = performance.now(),
  client = new URLSearchParams(location.search).get("client") ?? "notes";
let worker: Worker | undefined,
  counter = 0;
const calls = new Map<
  number,
  {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timeout: ReturnType<typeof setTimeout>;
  }
>();
function call<T>(method: string, ...args: unknown[]): Promise<T> {
  if (!worker) return Promise.reject(Error("database is initializing"));
  return new Promise((resolve, reject) => {
    const id = ++counter,
      timeout = setTimeout(() => {
        calls.delete(id);
        worker?.terminate();
        worker = undefined;
        for (const waiting of calls.values()) {
          clearTimeout(waiting.timeout);
          waiting.reject(Error("database response lost; reload required"));
        }
        calls.clear();
        reject(Error("database response lost; reload required"));
      }, 30000);
    calls.set(id, { resolve: (value) => resolve(value as T), reject, timeout });
    worker!.postMessage({ id, method, args });
  });
}
const api = {
  ready: false,
  startupMs: 0,
  execute: (name: string, params: Value[] = []) =>
    call<AotExecution>("execute", name, params),
  state: () => call<State>("state"),
  checkpoint: () => call<AotCheckpoint>("checkpoint"),
  pending: () => call<Pending>("pending"),
  sync: (endpoint: string) =>
    call<{ uploaded: number; deferred?: AotCheckpoint["deferred"] }>(
      "sync",
      new URL(endpoint, location.origin).href,
    ),
  acknowledge: (head: string, hash: string) =>
    call<void>("acknowledge", head, hash),
  exportSQLite: () => call<Uint8Array>("exportSQLite"),
  close: () => call<void>("close"),
};
declare global {
  interface Window {
    liteDemo: typeof api;
  }
}
window.liteDemo = api;
function download(file: Pending[number]) {
  const link = document.createElement("a"),
    url = URL.createObjectURL(
      new Blob([Uint8Array.from(file.data)], {
        type: "application/octet-stream",
      }),
    );
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function render(state: State) {
  const endpoint =
    document.querySelector<HTMLInputElement>("#upload-endpoint")!;
  endpoint.readOnly = !!state.upload;
  if (state.upload) endpoint.value = state.upload.endpoint;
  document.querySelector("#status")!.textContent =
    `保存済み · checkpoint ${state.head} · 未確認 LTX ${state.pending.length} 件` +
    (state.serial !== state.checkpointSerial ? " · 送信待ちの更新あり" : "");
  const body = document.querySelector("#notes")!;
  body.replaceChildren();
  for (const row of state.rows) {
    const tr = document.createElement("tr");
    for (const value of row) {
      const td = document.createElement("td");
      td.textContent = String(value ?? "");
      tr.append(td);
    }
    body.append(tr);
  }
  const pending = document.querySelector("#pending")!;
  pending.replaceChildren();
  for (const file of state.pending) {
    const li = document.createElement("li"),
      button = document.createElement("button");
    button.textContent = `${file.name} をダウンロード`;
    button.onclick = () =>
      void action(async () => {
        const data = (await api.pending()).find(
          (candidate) => candidate.name === file.name,
        );
        if (data) download(data);
      });
    li.append(button);
    pending.append(li);
  }
}
async function action(operation: () => Promise<unknown>) {
  try {
    const result = await operation();
    render(await api.state());
    const deferred = (
      result as { deferred?: AotCheckpoint["deferred"] } | undefined
    )?.deferred;
    if (deferred?.reason === "outbox-full")
      document
        .querySelector("#status")!
        .append(" · ローカル保存済み・次回同期で再試行");
    document.querySelector("#error")!.textContent = "";
  } catch (error) {
    document.querySelector("#error")!.textContent = (error as Error).message;
  }
}
const input = (id: string) =>
  (document.querySelector(`#${id}`) as HTMLInputElement).value;
document.querySelector("#note-form")!.addEventListener("submit", (event) => {
  event.preventDefault();
  void action(() =>
    api.execute("add", [
      BigInt(input("note-id")),
      input("note-title"),
      BigInt(input("note-score")),
    ]),
  );
});
document
  .querySelector("#edit")!
  .addEventListener(
    "click",
    () =>
      void action(() =>
        api.execute("edit", [
          input("note-title"),
          BigInt(input("note-score")),
          BigInt(input("note-id")),
        ]),
      ),
  );
document
  .querySelector("#erase")!
  .addEventListener(
    "click",
    () => void action(() => api.execute("erase", [BigInt(input("note-id"))])),
  );
document
  .querySelector("#checkpoint")!
  .addEventListener("click", () => void action(() => api.checkpoint()));
(document.querySelector("#upload-endpoint") as HTMLInputElement).value =
  new URLSearchParams(location.search).get("upload") ?? `/aot-ltx/${client}`;
document
  .querySelector("#upload")!
  .addEventListener(
    "click",
    () => void action(() => api.sync(input("upload-endpoint"))),
  );
try {
  if ("serviceWorker" in navigator && !import.meta.env.DEV) {
    const registration = await navigator.serviceWorker.register("/lite/sw.js", {
      scope: "/lite/",
    });
    if (!registration.active)
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (registration.active) {
            clearInterval(timer);
            resolve();
          }
        }, 20);
      });
    if (!navigator.serviceWorker.controller)
      await new Promise<void>((resolve) => {
        const check = () => {
          if (navigator.serviceWorker.controller) {
            navigator.serviceWorker.removeEventListener(
              "controllerchange",
              check,
            );
            resolve();
          }
        };
        navigator.serviceWorker.addEventListener("controllerchange", check);
        check();
      });
  }
  worker = new Worker(new URL("./aot-worker.ts", import.meta.url), {
    type: "module",
  });
  worker.onmessage = (event) => {
    const waiting = calls.get(event.data.id);
    if (!waiting) return;
    calls.delete(event.data.id);
    clearTimeout(waiting.timeout);
    if (event.data.error) waiting.reject(Error(event.data.error));
    else waiting.resolve(event.data.result);
  };
  worker.onerror = (event) => {
    worker?.terminate();
    worker = undefined;
    for (const waiting of calls.values()) {
      clearTimeout(waiting.timeout);
      waiting.reject(
        Error(
          event.message || "database worker failed to load; reload required",
        ),
      );
    }
    calls.clear();
  };
  render(await call<State>("init", client));
  api.startupMs = performance.now() - started;
  api.ready = true;
} catch (error) {
  document.querySelector("#status")!.textContent = "初期化失敗";
  document.querySelector("#error")!.textContent = (error as Error).message;
}
