import {
  captureImageCheckpoint,
  checkpointManifest,
  prepareImageCheckpoint,
  verifyCheckpoint,
  partKey,
  type CheckpointManifest,
  type PreparedCheckpoint,
} from "./image-checkpoint.ts";
/** Opaque deterministic edits; binary checkpoint/LTX attachments avoid base64
 * in IndexedDB. SQL semantics belong to the engine, not IDB key comparison. */
import type {
  ImageStore,
  ImageSnapshot,
  ImageCheckpoint,
  ImageDelta,
  PersistedImage as MoonImage,
} from "../src/persistence-contract.ts";
export type {
  ImageDelta,
  PersistedImage as MoonImage,
} from "../src/persistence-contract.ts";
export interface ImageStoreTransaction {
  stores: string[];
  apply(tx: IDBTransaction, fail: (error: unknown) => void): void;
}
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
export function captureImageSnapshot(value: ImageSnapshot): ImageSnapshot {
  if (
    !value ||
    typeof value.text !== "string" ||
    !Array.isArray(value.chunks) ||
    value.chunks.length > 100000
  )
    throw Error("invalid Moon chunk snapshot");
  let bytes = new TextEncoder().encode(value.text).length;
  for (const chunk of value.chunks) {
    if (!(chunk instanceof Uint8Array))
      throw Error("invalid Moon snapshot chunk");
    bytes += chunk.byteLength;
  }
  if (bytes > MAX_BYTES) throw Error("Moon snapshot exceeds 64 MiB");
  return {
    text: value.text,
    chunks: value.chunks.map((c) => Uint8Array.from(c)),
  };
}
export class MoonImageStore implements ImageStore {
  private count = 0;
  private bytes = 0;
  protected constructor(protected db: IDBDatabase) {}
  static async open(name: string): Promise<MoonImageStore> {
    return new MoonImageStore(await MoonImageStore.connect(name));
  }
  protected static async connect(name: string): Promise<IDBDatabase> {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name))
      throw Error("invalid Moon database name");
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(`browser-litestream-moonbit-${name}`, 4);
      let rejected = false;
      request.onupgradeneeded = () => {
        for (const store of [
          "image",
          "delta",
          "sqlite-head",
          "sqlite-pages",
          "sqlite-files",
          "sqlite-checksums",
        ])
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
        resolve(request.result);
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
      let verification:
        | { manifest: CheckpointManifest; chunks: Uint8Array[] }
        | undefined;
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
            try {
              if (typeof snapshot.result === "string") {
                value.image = snapshot.result;
                return;
              }
              if (snapshot.result?.format === "moon-snapshot-parts@2") {
                const manifest = checkpointManifest(
                  snapshot.result,
                  r.checkpoint,
                );
                const range = IDBKeyRange.bound(
                  ["part", 0, 0],
                  ["part", Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
                );
                const data = images.getAll(range),
                  names = images.getAllKeys(range);
                let values: Uint8Array[] | undefined,
                  keys: IDBValidKey[] | undefined;
                const assign = () => {
                  if (!values || !keys) return;
                  try {
                    if (
                      values.length !== manifest.refs.length ||
                      keys.length !== values.length
                    )
                      throw Error("Moon checkpoint part gap/orphan");
                    const byKey = new Map(
                      keys.map((k, i) => [JSON.stringify(k), values![i]!]),
                    );
                    const chunks = manifest.refs.map(
                      (ref) => byKey.get(JSON.stringify(partKey(ref)))!,
                    );
                    verification = { manifest, chunks };
                    value.snapshot = { text: manifest.text, chunks };
                  } catch (e) {
                    fail(e);
                  }
                };
                data.onsuccess = () => {
                  values = data.result;
                  assign();
                };
                names.onsuccess = () => {
                  keys = names.result;
                  assign();
                };
                return;
              }
              const manifest = snapshot.result;
              if (
                !manifest ||
                manifest.format !== "moon-snapshot-chunks@1" ||
                typeof manifest.text !== "string" ||
                !Number.isSafeInteger(manifest.count) ||
                manifest.count < 0 ||
                manifest.count > 100000 ||
                !Number.isSafeInteger(manifest.bytes) ||
                manifest.bytes < 0 ||
                manifest.bytes > MAX_BYTES
              )
                throw Error("missing or invalid Moon checkpoint");
              const assign = (chunks: Uint8Array[]) => {
                if (
                  chunks.length !== manifest.count ||
                  chunks.some((c) => !(c instanceof Uint8Array)) ||
                  new TextEncoder().encode(manifest.text).length +
                    chunks.reduce((n, c) => n + c.byteLength, 0) !==
                    manifest.bytes
                )
                  throw Error("Moon snapshot chunk count/length mismatch");
                value.snapshot = { text: manifest.text, chunks };
              };
              if (!manifest.count) assign([]);
              else {
                const chunks = images.getAll(
                  IDBKeyRange.bound(
                    ["chunk", 0],
                    ["chunk", manifest.count - 1],
                  ),
                );
                chunks.onsuccess = () => {
                  try {
                    assign(chunks.result);
                  } catch (e) {
                    fail(e);
                  }
                };
              }
            } catch (e) {
              fail(e);
            }
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
        const checked = verification
          ? verifyCheckpoint(verification.manifest, verification.chunks)
          : Promise.resolve();
        checked.then(() => {
          this.count = count;
          this.bytes = bytes;
          resolve(value);
        }, reject);
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
  commitCheckpoint(
    expected: number,
    checkpoint: ImageCheckpoint,
  ): Promise<number> {
    try {
      const captured = captureImageCheckpoint(checkpoint);
      return this.prepareCheckpoint(expected, captured).then((prepared) =>
        this.write(
          expected,
          undefined,
          undefined,
          undefined,
          undefined,
          prepared,
        ),
      );
    } catch (e) {
      return Promise.reject(e);
    }
  }
  protected async prepareCheckpoint(
    expected: number,
    captured: ImageCheckpoint,
  ): Promise<PreparedCheckpoint> {
    const previous = await new Promise<{
      manifest?: CheckpointManifest;
      checkpoint?: number;
    }>((resolve, reject) => {
      const tx = this.db.transaction("image", "readonly"),
        images = tx.objectStore("image"),
        get = images.get("root");
      let result: { manifest?: CheckpointManifest; checkpoint?: number } = {},
        error: unknown;
      const fail = (e: unknown) => {
        error = e;
        tx.abort();
      };
      get.onsuccess = () => {
        try {
          const current = root(get.result);
          if ((current?.generation ?? 0) !== expected)
            throw Error("Moon database changed; reload required");
          if (!current || current.format === 1) return;
          result.checkpoint = current.checkpoint;
          const snapshot = images.get("snapshot");
          snapshot.onsuccess = () => {
            try {
              if (snapshot.result?.format === "moon-snapshot-parts@2")
                result.manifest = checkpointManifest(
                  snapshot.result,
                  current.checkpoint,
                );
            } catch (e) {
              fail(e);
            }
          };
        } catch (e) {
          fail(e);
        }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () =>
        reject(
          error ?? tx.error ?? Error("Moon checkpoint preparation aborted"),
        );
    });
    return prepareImageCheckpoint(
      expected,
      captured,
      previous.manifest,
      previous.checkpoint,
    );
  }
  commitSnapshot(expected: number, snapshot: ImageSnapshot): Promise<number> {
    try {
      return this.write(
        expected,
        undefined,
        undefined,
        undefined,
        captureImageSnapshot(snapshot),
      );
    } catch (e) {
      return Promise.reject(e);
    }
  }
  commitDelta(expected: number, delta: ImageDelta): Promise<number> {
    try {
      imageDeltaBytes(delta);
      // Freeze the submitted batch before the asynchronous generation read.
      const data: ImageDelta = {
        text: delta.text,
        ...(delta.blobs
          ? { blobs: delta.blobs.map((b) => Uint8Array.from(b)) }
          : {}),
      };
      return this.write(expected, undefined, data);
    } catch (e) {
      return Promise.reject(e);
    }
  }
  protected write(
    expected: number,
    image?: string,
    delta?: ImageDelta,
    participant?: ImageStoreTransaction,
    snapshot?: ImageSnapshot,
    checkpointParts?: PreparedCheckpoint,
  ): Promise<number> {
    if (
      !Number.isSafeInteger(expected) ||
      expected < 0 ||
      expected === Number.MAX_SAFE_INTEGER
    )
      return Promise.reject(Error("Moon image generation overflow"));
    const added = delta ? imageDeltaBytes(delta) : 0;
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(
        ["image", "delta", ...(participant?.stores ?? [])],
        "readwrite",
        {
          durability: "strict",
        },
      );
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
          if (
            image !== undefined ||
            snapshot !== undefined ||
            checkpointParts !== undefined
          ) {
            checkpoint = expected + 1;
            log.clear();
            if (checkpointParts) {
              if (
                checkpointParts.base !== undefined &&
                (current?.format !== 2 ||
                  current.checkpoint !== checkpointParts.base)
              )
                throw Error("Moon checkpoint base changed; reload required");
              if (checkpointParts.reset) images.clear();
              for (const ref of checkpointParts.removes)
                images.delete(partKey(ref));
              for (const entry of checkpointParts.puts)
                images.put(entry.data, partKey(entry.ref));
              images.put(checkpointParts.manifest, "snapshot");
            } else {
              images.clear();
              if (snapshot) {
                images.put(
                  {
                    format: "moon-snapshot-chunks@1",
                    text: snapshot.text,
                    count: snapshot.chunks.length,
                    bytes:
                      new TextEncoder().encode(snapshot.text).length +
                      snapshot.chunks.reduce((n, c) => n + c.byteLength, 0),
                  },
                  "snapshot",
                );
                for (let i = 0; i < snapshot.chunks.length; i++)
                  images.put(snapshot.chunks[i], ["chunk", i]);
              } else images.put(image, "snapshot");
            }
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
      const fail = (e: unknown) => {
        error = e;
        try {
          tx.abort();
        } catch {}
      };
      try {
        participant?.apply(tx, fail);
      } catch (e) {
        fail(e);
      }
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
