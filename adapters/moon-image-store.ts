/** Opaque deterministic edits; binary checkpoint/LTX attachments avoid base64
 * in IndexedDB. SQL semantics belong to the engine, not IDB key comparison. */
import type {
  ImageStore,
  ImageDelta,
  PersistedImage as MoonImage,
} from "../src/persistence-contract.ts";
export type {
  ImageDelta,
  PersistedImage as MoonImage,
} from "../src/persistence-contract.ts";
interface Root {
  format: 2;
  generation: number;
  checkpoint: number;
  bytes: number;
}
interface Legacy {
  format: 1;
  generation: number;
  image: string;
}
const MAX_BYTES = 64 * 1024 * 1024;
function root(value: unknown): Root | Legacy | undefined {
  if (value === undefined) return;
  const r = value as {
    format?: 1 | 2;
    generation: number;
    checkpoint: number;
    bytes: number;
    image?: string;
  };
  if (!Number.isSafeInteger(r.generation) || r.generation < 1)
    throw Error("invalid Moon database generation");
  if (r.format === 1 && typeof r.image === "string") return r as Legacy;
  if (
    r.format === 2 &&
    Number.isSafeInteger(r.checkpoint) &&
    r.checkpoint >= 1 &&
    r.checkpoint <= r.generation &&
    r.generation - r.checkpoint <= 256 &&
    Number.isSafeInteger(r.bytes) &&
    r.bytes >= 0 &&
    r.bytes <= MAX_BYTES
  )
    return r as Root;
  throw Error("invalid Moon database image");
}
export function imageDeltaBytes(delta: ImageDelta): number {
  if (
    !delta ||
    typeof delta.text !== "string" ||
    (delta.blobs !== undefined && !Array.isArray(delta.blobs))
  )
    throw Error("invalid image delta");
  let bytes = new TextEncoder().encode(delta.text).byteLength;
  for (const blob of delta.blobs ?? []) {
    if (!(blob instanceof Uint8Array)) throw Error("invalid image delta blob");
    bytes += blob.byteLength;
  }
  if (bytes > MAX_BYTES) throw Error("Moon delta exceeds 64 MiB");
  return bytes;
}
export class MoonImageStore implements ImageStore {
  private count = 0;
  private bytes = 0;
  private constructor(private db: IDBDatabase) {}
  static async open(name: string): Promise<MoonImageStore> {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name))
      throw Error("invalid Moon database name");
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(`browser-litestream-moonbit-${name}`, 2);
      let rejected = false;
      request.onupgradeneeded = () => {
        for (const store of ["image", "delta"])
          if (!request.result.objectStoreNames.contains(store))
            request.result.createObjectStore(store);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => {
        rejected = true;
        reject(Error("Moon database upgrade blocked"));
      };
      request.onsuccess = () => {
        if (rejected) {
          request.result.close();
          return;
        }
        request.result.onversionchange = () => request.result.close();
        resolve(new MoonImageStore(request.result));
      };
    });
  }
  checkpointNeeded(): boolean {
    return this.count >= 128 || this.bytes >= 4 * 1024 * 1024;
  }
  read(): Promise<MoonImage> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(["image", "delta"], "readonly");
      let value: MoonImage = { generation: 0 },
        count = 0,
        bytes = 0,
        error: unknown;
      const fail = (e: unknown) => {
        error = e;
        tx.abort();
      };
      const images = tx.objectStore("image"),
        request = images.get("root");
      request.onsuccess = () => {
        try {
          const r = root(request.result);
          if (!r) return;
          value.generation = r.generation;
          if (r.format === 1) {
            value.image = r.image;
            return;
          }
          count = r.generation - r.checkpoint;
          bytes = r.bytes;
          const snapshot = images.get("snapshot");
          snapshot.onsuccess = () => {
            if (typeof snapshot.result !== "string") {
              fail(Error("missing Moon checkpoint"));
              return;
            }
            value.image = snapshot.result;
          };
          if (count) {
            const log = tx
              .objectStore("delta")
              .getAll(IDBKeyRange.bound(r.checkpoint + 1, r.generation));
            log.onsuccess = () => {
              try {
                if (log.result.length !== count) throw Error("Moon delta gap");
                let total = 0;
                value.deltas = log.result.map((entry, i) => {
                  if (entry.generation !== r.checkpoint + i + 1)
                    throw Error("Moon delta generation mismatch");
                  total += imageDeltaBytes(entry.data);
                  return entry.data as ImageDelta;
                });
                if (total !== bytes) throw Error("Moon delta length mismatch");
              } catch (e) {
                fail(e);
              }
            };
          }
        } catch (e) {
          fail(e);
        }
      };
      tx.oncomplete = () => {
        this.count = count;
        this.bytes = bytes;
        resolve(value);
      };
      tx.onabort = () =>
        reject(error ?? tx.error ?? Error("Moon image read aborted"));
    });
  }
  commit(expected: number, image: string): Promise<number> {
    if (
      typeof image !== "string" ||
      new TextEncoder().encode(image).length > MAX_BYTES
    )
      return Promise.reject(Error("Moon image exceeds 64 MiB"));
    return this.write(expected, image);
  }
  commitDelta(expected: number, delta: ImageDelta): Promise<number> {
    try {
      imageDeltaBytes(delta);
      // Freeze the submitted batch before the asynchronous generation read.
      const data: ImageDelta = {
        text: delta.text,
        ...(delta.blobs ? { blobs: delta.blobs.map((b) => b.slice()) } : {}),
      };
      return this.write(expected, undefined, data);
    } catch (e) {
      return Promise.reject(e);
    }
  }
  private write(
    expected: number,
    image?: string,
    delta?: ImageDelta,
  ): Promise<number> {
    if (
      !Number.isSafeInteger(expected) ||
      expected < 0 ||
      expected === Number.MAX_SAFE_INTEGER
    )
      return Promise.reject(Error("Moon image generation overflow"));
    const added = delta ? imageDeltaBytes(delta) : 0;
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(["image", "delta"], "readwrite", {
        durability: "strict",
      });
      if (tx.durability !== "strict") {
        tx.abort();
        reject(Error("strict IndexedDB durability is required"));
        return;
      }
      let error: unknown,
        count = 0,
        bytes = 0;
      const images = tx.objectStore("image"),
        log = tx.objectStore("delta"),
        request = images.get("root");
      request.onsuccess = () => {
        try {
          const current = root(request.result);
          if ((current?.generation ?? 0) !== expected)
            throw Error(
              "Moon database changed in another connection; reload required",
            );
          let checkpoint: number;
          if (image !== undefined) {
            checkpoint = expected + 1;
            log.clear();
            images.put(image, "snapshot");
          } else {
            if (!current || !delta)
              throw Error("Moon delta requires a checkpoint");
            checkpoint =
              current.format === 1 ? current.generation : current.checkpoint;
            count = expected + 1 - checkpoint;
            bytes = (current.format === 1 ? 0 : current.bytes) + added;
            if (count > 256 || bytes > MAX_BYTES)
              throw Error("Moon checkpoint required");
            if (current.format === 1) images.put(current.image, "snapshot");
            log.put({ generation: expected + 1, data: delta }, expected + 1);
          }
          images.put(
            {
              format: 2,
              generation: expected + 1,
              checkpoint,
              bytes,
            } satisfies Root,
            "root",
          );
        } catch (e) {
          error = e;
          tx.abort();
        }
      };
      tx.oncomplete = () => {
        this.count = count;
        this.bytes = bytes;
        resolve(expected + 1);
      };
      tx.onabort = () =>
        reject(error ?? tx.error ?? Error("Moon image commit aborted"));
    });
  }
  close(): void {
    this.db.close();
  }
}
