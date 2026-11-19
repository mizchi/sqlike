/** Infrastructure boundary. Payloads are opaque to storage; SQL/SQLite format,
 * ordering and replay validation belong to the engine/replica above it.
 * All writes use generation CAS, publish atomically, and ACK only after durable
 * commit. Rejected/uncertain writes require reopen before another publication. */
export interface ImageDelta {
  text: string;
  blobs?: Uint8Array[];
}
/** Opaque checkpoint parts, published together in one generation. Owned on read;
 * providers capture caller buffers before asynchronous work. Total limit 64 MiB. */
export interface ImageSnapshot {
  text: string;
  chunks: Uint8Array[];
}
/** Numeric entries reuse an old checkpoint ordinal. base is its logical generation;
 * only new byte buffers are copied. Publication resets the journal atomically. */
export interface ImageCheckpoint {
  text: string;
  chunks: (Uint8Array | number)[];
  base?: number;
}
export interface PersistedImage {
  generation: number;
  image?: string;
  snapshot?: ImageSnapshot;
  deltas?: ImageDelta[];
}
export interface ImageStore {
  read(): Promise<PersistedImage>;
  commit(expected: number, image: string): Promise<number>;
  /** Optional for existing snapshot-only stores. Input is captured at call time. */
  commitCheckpoint?(
    expected: number,
    checkpoint: ImageCheckpoint,
  ): Promise<number>;
  commitSnapshot?(expected: number, snapshot: ImageSnapshot): Promise<number>;
  commitDelta?(expected: number, delta: ImageDelta): Promise<number>;
  checkpointNeeded?(): boolean;
  close(): void;
}
export type ImageStoreFactory = (name: string) => Promise<ImageStore>;
/** A Worker bridge can implement the synchronous SQL facade without exposing
 * IndexedDB transactions or Atomics to the engine. */
export interface SyncImagePersistence {
  readonly initial: PersistedImage;
  /** Drop the initial serialized buffers once the engine has replayed them. */
  releaseInitial?(): void;
  checkpointNeeded(): boolean;
  commit(image: string, delta?: boolean): void;
  close(): void;
}
export type SyncPersistenceFactory = (
  name: string,
) => Promise<SyncImagePersistence>;

/** Immutable replica candidates. Publication is owned by LtxTransport; a cache
 * write must complete before its filename can enter the durable replica cursor. */
export interface ReplicaImageStore {
  read(name: string): Promise<Uint8Array>;
  write(name: string, data: Uint8Array): Promise<void>;
  prune(keep?: string): Promise<void>;
}
export type ReplicaImageStoreFactory = (
  name: string,
) => Promise<ReplicaImageStore>;
