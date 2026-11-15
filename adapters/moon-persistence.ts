import type {
  PersistedImage as MoonImage,
  SyncImagePersistence,
} from "../src/persistence-contract.ts";
/** A tiny ACK buffer bridges the synchronous Database transaction contract.
 * IndexedDB's complete/abort events, not a queued put(), decide the outcome. */
export class MoonPersistence implements SyncImagePersistence {
  private generation: number;
  private needsCheckpoint = false;
  private signal = new SharedArrayBuffer(4096);
  private constructor(
    private worker: Worker,
    public initial: MoonImage,
  ) {
    this.generation = initial.generation;
    this.needsCheckpoint =
      (initial as MoonImage & { checkpointRequired?: boolean })
        .checkpointRequired ?? false;
  }
  static async open(name: string): Promise<MoonPersistence> {
    if (typeof SharedArrayBuffer === "undefined")
      throw new Error(
        "MoonBit durable transactions require cross-origin isolation",
      );
    const worker = new Worker(
      new URL("./moon-persistence-worker.ts", import.meta.url),
      { type: "module" },
    );
    try {
      const initial = await new Promise<MoonImage>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Moon persistence initialization timed out")),
          10000,
        );
        worker.onmessage = (
          event: MessageEvent<MoonImage & { error?: string }>,
        ) => {
          clearTimeout(timer);
          event.data.error
            ? reject(new Error(event.data.error))
            : resolve(event.data);
        };
        worker.onerror = (event) => {
          clearTimeout(timer);
          reject(new Error(event.message));
        };
        worker.postMessage({ method: "open", name });
      });
      return new MoonPersistence(worker, initial);
    } catch (e) {
      worker.terminate();
      throw e;
    }
  }
  close(): void {
    this.worker.terminate();
  }
  releaseInitial(): void {
    this.initial = { generation: this.generation };
  }
  checkpointNeeded(): boolean {
    return this.needsCheckpoint;
  }
  commit(image: string, delta = false): void {
    const header = new Int32Array(this.signal, 0, 2);
    Atomics.store(header, 0, 0);
    Atomics.store(header, 1, 0);
    this.worker.postMessage({
      method: "commit",
      image,
      delta,
      expected: this.generation,
      signal: this.signal,
    });
    const deadline = performance.now() + 10000;
    while (Atomics.load(header, 0) === 0) {
      const remaining = deadline - performance.now();
      if (
        remaining <= 0 ||
        Atomics.wait(header, 0, 0, remaining) === "timed-out"
      ) {
        this.worker.terminate();
        throw new Error("Moon persistence outcome is unknown; reload required");
      }
    }
    const length = Atomics.load(header, 1);
    if (length < 1 || length > this.signal.byteLength - 8)
      throw new Error(
        "invalid Moon persistence acknowledgement; reload required",
      );
    const response = JSON.parse(
      new TextDecoder().decode(new Uint8Array(this.signal, 8, length).slice()),
    ) as { generation?: number; error?: string; checkpointRequired?: boolean };
    if (
      Atomics.load(header, 0) !== 1 ||
      response.error ||
      response.generation !== this.generation + 1
    )
      throw new Error(
        response.error ??
          "invalid Moon persistence generation; reload required",
      );
    this.generation = response.generation;
    this.needsCheckpoint = response.checkpointRequired ?? false;
  }
}
