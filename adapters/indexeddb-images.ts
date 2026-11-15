import type {
  ReplicaImageStore,
  ReplicaImageStoreFactory,
} from "../src/persistence-contract.ts";
const LIMIT = 64 * 1024 * 1024;
function valid(name: string): void {
  if (!/^image-[0-9a-f-]{36}\.sqlite$/.test(name))
    throw Error("invalid replica image name");
}
/** Replica candidates are immutable by convention and published separately by
 * the cursor transaction. Old OPFS candidates may be copied through a lazy,
 * injected fallback, without requiring filesystem APIs for new databases. */
export class IndexedDbImages implements ReplicaImageStore {
  private constructor(
    private db: IDBDatabase,
    private namespace: string,
    private legacy?: ReplicaImageStoreFactory,
  ) {}
  static async open(
    name: string,
    legacy?: ReplicaImageStoreFactory,
  ): Promise<IndexedDbImages> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(name))
      throw Error("invalid replica image namespace");
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(`browser-litestream-image-cache-${name}`, 1);
      let blocked = false;
      req.onupgradeneeded = () => req.result.createObjectStore("files");
      req.onerror = () => reject(req.error);
      req.onblocked = () => {
        blocked = true;
        reject(Error("replica image upgrade blocked"));
      };
      req.onsuccess = () => {
        if (blocked) {
          req.result.close();
          return;
        }
        req.result.onversionchange = () => req.result.close();
        resolve(new IndexedDbImages(req.result, name, legacy));
      };
    });
  }
  async read(name: string): Promise<Uint8Array> {
    valid(name);
    const data = await new Promise<unknown>((resolve, reject) => {
      const tx = this.db.transaction("files", "readonly"),
        req = tx.objectStore("files").get(name);
      tx.oncomplete = () => resolve(req.result);
      tx.onabort = () =>
        reject(tx.error ?? Error("replica image read aborted"));
    });
    if (data === undefined && this.legacy) {
      const migrated = await (await this.legacy(this.namespace)).read(name);
      await this.write(name, migrated);
      return migrated;
    }
    if (!(data instanceof Uint8Array) || data.length > LIMIT)
      throw Error("missing or invalid replica image");
    return data;
  }
  write(name: string, data: Uint8Array): Promise<void> {
    valid(name);
    if (data.length > LIMIT)
      return Promise.reject(Error("replica image exceeds 64 MiB"));
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction("files", "readwrite", {
        durability: "strict",
      });
      if (tx.durability !== "strict") {
        tx.abort();
        reject(Error("strict IndexedDB durability is required"));
        return;
      }
      let failure: unknown;
      tx.oncomplete = () => resolve();
      tx.onabort = () =>
        reject(failure ?? tx.error ?? Error("replica image write aborted"));
      try {
        // put() captures the value synchronously. Avoid cloning a larger backing
        // buffer when a caller hands us a subarray of another image.
        tx.objectStore("files").put(
          data.byteLength === data.buffer.byteLength ? data : data.slice(),
          name,
        );
      } catch (e) {
        failure = e;
        tx.abort();
      }
    });
  }
  prune(keep?: string): Promise<void> {
    if (keep !== undefined) valid(keep);
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction("files", "readwrite", {
        durability: "strict",
      });
      if (tx.durability !== "strict") {
        tx.abort();
        reject(Error("strict IndexedDB durability is required"));
        return;
      }
      const store = tx.objectStore("files"),
        req = store.openKeyCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (c) {
          if (c.key !== keep) store.delete(c.key);
          c.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () =>
        reject(tx.error ?? Error("replica image prune aborted"));
    });
  }
  close(): void {
    this.db.close();
  }
}
