import { MoonImageStore } from "./moon-image-store.ts";
let store: MoonImageStore;
let serial = Promise.resolve();
self.onmessage = (
  event: MessageEvent<
    | { method: "open"; name: string }
    | {
        method: "commit";
        expected: number;
        image: string;
        delta?: boolean;
        signal: SharedArrayBuffer;
      }
  >,
) => {
  const request = event.data;
  serial = serial.then(async () => {
    if (request.method === "open") {
      try {
        store = await MoonImageStore.open(request.name);
        self.postMessage({
          ...(await store.read()),
          checkpointRequired: store.checkpointNeeded(),
        });
      } catch (e) {
        self.postMessage({ error: e instanceof Error ? e.message : String(e) });
      }
    } else {
      const header = new Int32Array(request.signal, 0, 2);
      const bytes = new Uint8Array(request.signal, 8);
      let response: {
        generation?: number;
        error?: string;
        checkpointRequired?: boolean;
      };
      let status: number;
      try {
        response = {
          generation: await (request.delta
            ? store.commitDelta(request.expected, { text: request.image })
            : store.commit(request.expected, request.image)),
          checkpointRequired: store.checkpointNeeded(),
        };
        status = 1;
      } catch (e) {
        response = {
          error: (e instanceof Error ? e.message : String(e)).slice(0, 500),
        };
        status = 2;
      }
      const result = new TextEncoder().encode(JSON.stringify(response));
      bytes.set(result);
      Atomics.store(header, 1, result.length);
      Atomics.store(header, 0, status);
      Atomics.notify(header, 0);
    }
  });
};
