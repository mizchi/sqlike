import type { Pending, Snapshot } from "../src/contract.ts";

/** Storage-only experiment. SQL/frame validity remains the caller's contract. */
export interface IndexedReplica {
  snapshot: Snapshot;
  outbox: Pending[];
}
export interface VersionedReplica {
  generation: number;
  state: IndexedReplica | null;
}
interface RecordValue {
  format: 1;
  generation: number;
  state: IndexedReplica;
}
export class ReplicaVersionError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`replica version conflict: expected ${expected}, got ${actual}`);
    this.name = "ReplicaVersionError";
  }
}
function stored(value: unknown): RecordValue | undefined {
  if (value === undefined) return undefined;
  const record = value as RecordValue;
  if (
    !record ||
    record.format !== 1 ||
    !Number.isSafeInteger(record.generation) ||
    record.generation < 1 ||
    !record.state?.snapshot ||
    !Array.isArray(record.state.outbox)
  )
    throw new Error("invalid IndexedDB replica envelope");
  return record;
}
/** One root value makes data/outbox atomic; this is not an indexed SQL engine. */
export class IndexedReplicaStore {
  private constructor(private database: IDBDatabase) {}
  static async open(name: string): Promise<IndexedReplicaStore> {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name))
      throw new Error("invalid replica name");
    return new Promise((resolve, reject) => {
      let blocked = false;
      const request = indexedDB.open(`browser-litestream-indexeddb-${name}`, 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("replica");
      request.onerror = () =>
        reject(request.error ?? new Error("IndexedDB open failed"));
      request.onblocked = () => {
        blocked = true;
        reject(new Error("IndexedDB upgrade is blocked by another connection"));
      };
      request.onsuccess = () => {
        const database = request.result;
        if (blocked) {
          database.close();
          return;
        }
        database.onversionchange = () => database.close();
        resolve(new IndexedReplicaStore(database));
      };
    });
  }
  read(): Promise<VersionedReplica> {
    return new Promise((resolve, reject) => {
      const transaction = this.database.transaction("replica", "readonly");
      let record: RecordValue | undefined;
      let failure: unknown;
      const request = transaction.objectStore("replica").get("root");
      request.onsuccess = () => {
        try {
          record = stored(request.result);
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      transaction.onabort = () =>
        reject(
          failure ?? transaction.error ?? new Error("IndexedDB read aborted"),
        );
      transaction.oncomplete = () =>
        resolve(
          record
            ? { generation: record.generation, state: record.state }
            : { generation: 0, state: null },
        );
    });
  }
  async commit(
    expected: number,
    state: IndexedReplica,
  ): Promise<VersionedReplica> {
    if (
      !Number.isSafeInteger(expected) ||
      expected < 0 ||
      expected === Number.MAX_SAFE_INTEGER
    )
      throw new Error("invalid replica generation");
    const snapshot = structuredClone(state);
    return new Promise((resolve, reject) => {
      const transaction = this.database.transaction("replica", "readwrite", {
        durability: "strict",
      });
      let failure: unknown;
      transaction.onabort = () =>
        reject(
          failure ?? transaction.error ?? new Error("IndexedDB commit aborted"),
        );
      transaction.oncomplete = () =>
        resolve({ generation: expected + 1, state: snapshot });
      if (transaction.durability !== "strict") {
        failure = new Error("strict IndexedDB durability is unavailable");
        transaction.abort();
        return;
      }
      const store = transaction.objectStore("replica");
      const request = store.get("root");
      request.onsuccess = () => {
        // Keep every request inside this active request callback. Never await
        // network/timers while assuming an IndexedDB transaction stays open.
        try {
          const actual = stored(request.result)?.generation ?? 0;
          if (actual !== expected)
            throw new ReplicaVersionError(expected, actual);
          const record: RecordValue = {
            format: 1,
            generation: expected + 1,
            state: snapshot,
          };
          stored(record);
          store.put(record, "root");
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
    });
  }
  close(): void {
    this.database.close();
  }
}
