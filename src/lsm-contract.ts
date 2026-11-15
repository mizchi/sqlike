/** Experimental ordered rowid KV. Values are opaque after-images, not SQL.
 * Keys use signed int64 numeric order; null is a deletion, empty bytes a value. */
export interface KvEdit {
  key: bigint;
  value: Uint8Array | null;
}
export interface KvRange {
  gte?: bigint;
  lt?: bigint;
}
export interface KvSnapshot {
  get(key: bigint): Promise<Uint8Array | undefined>;
  scan(range?: KvRange): AsyncIterable<[bigint, Uint8Array]>;
  close(): void;
}
export interface OrderedKv extends KvSnapshot {
  writeBatch(edits: readonly KvEdit[]): Promise<void>;
  snapshot(): KvSnapshot;
}

/** Infrastructure contract. Manifests and block formats belong to the engine.
 * Captures input synchronously, immutable block IDs, atomic generation CAS and
 * strict durable completion. Staged blocks are invisible until root publication.
 * This experiment retains retired/orphan blocks, keeping pinned readers safe
 * across connections; physical garbage collection is intentionally not exposed. */
export interface LsmHead {
  generation: number;
  manifest?: string;
  wal: Uint8Array[];
}
export interface LsmPublication {
  manifest?: string;
  append?: Uint8Array;
  resetWal?: boolean;
}
export interface LsmStorage {
  readHead(): Promise<LsmHead>;
  readBlock(id: string): Promise<Uint8Array>;
  stageBlock(id: string, data: Uint8Array): Promise<void>;
  publish(expected: number, change: LsmPublication): Promise<number>;
  close(): void;
}
