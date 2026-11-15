import type {
  LsmHead,
  LsmPublication,
  LsmStorage,
} from "../src/lsm-contract.ts";

interface Head {
  generation: number;
  walBytes: number;
  walRecords: number;
}
const initial: Head = { generation: 0, walBytes: 0, walRecords: 0 };
function validHead(value: unknown): Head {
  if (value === undefined) return initial;
  const h = value as Head;
  if (
    !h ||
    !Number.isSafeInteger(h.generation) ||
    h.generation < 0 ||
    h.generation > 2147483646 ||
    !Number.isSafeInteger(h.walBytes) ||
    h.walBytes < 0 ||
    h.walBytes > 2 * 1024 * 1024 ||
    !Number.isSafeInteger(h.walRecords) ||
    h.walRecords < 0 ||
    h.walRecords > 128
  )
    throw Error("invalid LSM storage head");
  return h;
}
/** An opaque block/WAL provider: no SQL, key sorting, run merging or engine
 * metadata interpretation. Retired and interrupted-compaction blocks remain
 * until the experimental database is deleted by its owner. */
export class IndexedDbLsmStorage implements LsmStorage {
  private constructor(private db: IDBDatabase) {}
  static async open(name: string): Promise<IndexedDbLsmStorage> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(name))
      throw Error("invalid LSM namespace");
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(`browser-litestream-lsm-${name}`, 1);
      let blocked = false;
      r.onupgradeneeded = () => {
        for (const s of ["head", "manifest", "wal", "blocks"])
          r.result.createObjectStore(s);
      };
      r.onerror = () => reject(r.error);
      r.onblocked = () => {
        blocked = true;
        reject(Error("LSM database upgrade blocked"));
      };
      r.onsuccess = () => {
        if (blocked) {
          r.result.close();
          return;
        }
        r.result.onversionchange = () => r.result.close();
        resolve(new IndexedDbLsmStorage(r.result));
      };
    });
  }
  private transaction<T>(
    stores: string[],
    mode: IDBTransactionMode,
    work: (
      tx: IDBTransaction,
      done: (value: T) => void,
      fail: (e: unknown) => void,
    ) => void,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(
        stores,
        mode,
        mode === "readwrite" ? { durability: "strict" } : undefined,
      );
      let value: T, failure: unknown;
      const fail = (e: unknown) => {
        failure = e;
        tx.abort();
      };
      tx.oncomplete = () => resolve(value);
      tx.onabort = () =>
        reject(failure ?? tx.error ?? Error("LSM storage transaction aborted"));
      if (mode === "readwrite" && tx.durability !== "strict") {
        fail(Error("strict IndexedDB durability required"));
        return;
      }
      try {
        work(
          tx,
          (v) => {
            value = v;
          },
          fail,
        );
      } catch (e) {
        fail(e);
      }
    });
  }
  async readHead(): Promise<LsmHead> {
    const saved = await this.transaction<{
      root: unknown;
      manifest: unknown;
      wal: unknown[];
    }>(["head", "manifest", "wal"], "readonly", (tx, done) => {
      const root = tx.objectStore("head").get("root"),
        image = tx.objectStore("manifest").get("current"),
        wal = tx.objectStore("wal").getAll();
      // Both requests are queued synchronously; complete sees one atomic view.
      wal.onsuccess = () =>
        done({ root: root.result, manifest: image.result, wal: wal.result });
    });
    const h = validHead(saved.root);
    if (
      saved.wal.length !== h.walRecords ||
      !saved.wal.every(
        (v) => v instanceof Uint8Array && v.length <= 1024 * 1024,
      )
    )
      throw Error("invalid LSM WAL records");
    const wal = saved.wal as Uint8Array[];
    if (wal.reduce((n, b) => n + b.length, 0) !== h.walBytes)
      throw Error("LSM WAL byte mismatch");
    if (
      saved.manifest !== undefined &&
      (typeof saved.manifest !== "string" ||
        saved.manifest.length > 16 * 1024 * 1024)
    )
      throw Error("invalid stored manifest");
    return {
      generation: h.generation,
      manifest: saved.manifest as string | undefined,
      wal,
    };
  }
  async readBlock(id: string): Promise<Uint8Array> {
    const value = await this.transaction<unknown>(
      ["blocks"],
      "readonly",
      (tx, done) => {
        const r = tx.objectStore("blocks").get(id);
        r.onsuccess = () => done(r.result);
      },
    );
    if (!(value instanceof Uint8Array) || value.length > 4 * 1024 * 1024)
      throw Error("missing or invalid LSM block");
    return value;
  }
  stageBlock(id: string, bytes: Uint8Array): Promise<void> {
    if (
      !/^[0-9a-f-]{36}$/.test(id) ||
      !(bytes instanceof Uint8Array) ||
      bytes.length > 4 * 1024 * 1024
    )
      return Promise.reject(Error("invalid staged block"));
    // add() captures input synchronously and never overwrites an immutable ID.
    return this.transaction<void>(["blocks"], "readwrite", (tx, done) => {
      tx.objectStore("blocks").add(
        bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice(),
        id,
      );
      done();
    });
  }
  publish(expected: number, change: LsmPublication): Promise<number> {
    if (
      !Number.isSafeInteger(expected) ||
      expected < 0 ||
      expected >= 2147483646 ||
      (change.manifest !== undefined &&
        (typeof change.manifest !== "string" ||
          change.manifest.length > 16 * 1024 * 1024)) ||
      (change.append !== undefined &&
        (!(change.append instanceof Uint8Array) ||
          change.append.length > 1024 * 1024))
    )
      return Promise.reject(Error("invalid LSM publication"));
    const append = change.append?.slice(),
      image = change.manifest,
      reset = !!change.resetWal;
    return this.transaction<number>(
      image === undefined ? ["head", "wal"] : ["head", "manifest", "wal"],
      "readwrite",
      (tx, done, fail) => {
        const store = tx.objectStore("head"),
          request = store.get("root");
        request.onsuccess = () => {
          try {
            const old = validHead(request.result);
            if (old.generation !== expected)
              throw Error("LSM generation conflict; reopen required");
            const next: Head = {
              generation: expected + 1,
              walBytes: (reset ? 0 : old.walBytes) + (append?.length ?? 0),
              walRecords: (reset ? 0 : old.walRecords) + (append ? 1 : 0),
            };
            validHead(next);
            const wal = tx.objectStore("wal");
            if (reset) wal.clear();
            if (append) wal.add(append, next.generation);
            if (image !== undefined)
              tx.objectStore("manifest").put(image, "current");
            store.put(next, "root");
            done(next.generation);
          } catch (e) {
            fail(e);
          }
        };
      },
    );
  }
  /** Outside timed operations: counts physical stored block bytes, including
   * retired/orphan runs. Does not claim filesystem allocation measurements. */
  diagnostics(): Promise<{ storedBlocks: number; storedBlockBytes: number }> {
    return this.transaction(["blocks"], "readonly", (tx, done) => {
      let storedBlocks = 0,
        storedBlockBytes = 0;
      const r = tx.objectStore("blocks").openCursor();
      r.onsuccess = () => {
        const c = r.result;
        if (!c) {
          done({ storedBlocks, storedBlockBytes });
          return;
        }
        storedBlocks++;
        storedBlockBytes += (c.value as Uint8Array).length;
        c.continue();
      };
    });
  }
  close(): void {
    this.db.close();
  }
}
