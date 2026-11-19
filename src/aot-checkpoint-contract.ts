import type {
  ImageDelta,
  ImageStore,
  ImageSnapshot,
  ImageCheckpoint,
} from "./persistence-contract.ts";
import type {
  SqlitePageCommit,
  SqlitePageHead,
  SqlitePageStore,
} from "./sqlite-pager-contract.ts";

export interface AotCheckpoint {
  created: boolean;
  head: string;
  /** Logical SQL is durable; retry after ACKs make room in the outbox. */
  deferred?: { reason: "outbox-full"; pending: number; limit: number };
  sha256?: string;
  pages?: {
    snapshot: boolean;
    written: number;
    reads: number;
    cacheBytes: number;
    fallback?: string;
  };
}

export type AotLogicalPublication =
  | { image: string; delta?: never; snapshot?: never; checkpoint?: never }
  | { delta: ImageDelta; image?: never; snapshot?: never; checkpoint?: never }
  | {
      snapshot: ImageSnapshot;
      image?: never;
      delta?: never;
      checkpoint?: never;
    }
  | {
      checkpoint: ImageCheckpoint;
      image?: never;
      delta?: never;
      snapshot?: never;
    };
/** Both generation checks and all writes belong to one durable transaction.
 * The page cursor advances only at a checkpoint or acknowledged-file pruning. */
export interface AotPageImageStore extends ImageStore {
  readonly pages: Pick<
    SqlitePageStore,
    "head" | "readPage" | "readChecksums"
  > & {
    readFile(generation: number, name: string): Promise<Uint8Array>;
  };
  commitWithPages(
    expected: number,
    logical: AotLogicalPublication,
    pageGeneration: number,
    pages: SqlitePageCommit,
  ): Promise<{ generation: number; head: SqlitePageHead }>;
}
export interface AotDatabaseOptions {
  /** Opt in to an atomic logical/page provider; snapshot-only providers reject. */
  sqlitePages?: boolean;
  cachePages?: number;
  /** Pending LTX count before checkpoint deferral; 1..128, default 128. */
  outboxLimit?: number;
}
export function isAotPageImageStore(
  store: ImageStore,
): store is AotPageImageStore {
  return (
    "pages" in store &&
    "commitWithPages" in store &&
    typeof store.commitWithPages === "function"
  );
}
