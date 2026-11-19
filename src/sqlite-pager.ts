import type {
  SqlitePageStore,
  SqlitePageHead,
  SqlitePagerRuntime,
  SqlitePagerProgress,
  SqlitePageCommit,
} from "./sqlite-pager-contract.ts";

function checked<T extends { error?: string }>(text: string): T {
  const r = JSON.parse(text) as T;
  if (r.error) throw Error(r.error);
  return r;
}
export interface SqlitePagerOptions {
  cachePages?: number;
  /** Compute opaque outbox/state attachments before the same atomic page commit. */
  prepareCommit?: (
    head: SqlitePageHead | undefined,
    value: SqlitePageCommit,
  ) =>
    | Pick<
        SqlitePageCommit,
        | "metadata"
        | "files"
        | "removeFiles"
        | "checksums"
        | "checksumFormat"
        | "checksumSnapshot"
      >
    | Promise<
        Pick<
          SqlitePageCommit,
          | "metadata"
          | "files"
          | "removeFiles"
          | "checksums"
          | "checksumFormat"
          | "checksumSnapshot"
        >
      >;
}
/** Export a SQLike connection to an independent page store. This is not a VFS:
 * logical rows still reside in SQLike. No SQL parser or engine is imported. */
export class SqlitePagerClient<Pager = unknown, Batch = unknown> {
  private pager: Pager;
  private generation = 0;
  private cache = new Map<number, Uint8Array>();
  private poisoned = false;
  private queue: Promise<void> = Promise.resolve();
  private constructor(
    private runtime: SqlitePagerRuntime<Pager, Batch>,
    private store: SqlitePageStore,
    private prepare: (pager: Pager) => Batch,
    private cacheLimit: number,
    private prepareCommit?: SqlitePagerOptions["prepareCommit"],
  ) {
    this.pager = runtime.sqlite_pager_open();
  }
  static async open<Pager, Batch>(
    runtime: SqlitePagerRuntime<Pager, Batch>,
    store: SqlitePageStore,
    prepare: (pager: Pager) => Batch,
    options: SqlitePagerOptions = {},
  ) {
    const limit = options.cachePages ?? 8;
    if (!Number.isInteger(limit) || limit < 0 || limit > 128)
      throw Error("invalid SQLite pager cache limit");
    const client = new SqlitePagerClient(
      runtime,
      store,
      prepare,
      limit,
      options.prepareCommit,
    );
    client.generation = (await store.head())?.generation ?? 0;
    return client;
  }
  private put(page: number, data: Uint8Array) {
    this.cache.delete(page);
    if (this.cacheLimit) {
      this.cache.set(page, data);
      while (this.cache.size > this.cacheLimit)
        this.cache.delete(this.cache.keys().next().value!);
    }
  }
  flush(): Promise<{
    created: boolean;
    head?: SqlitePageHead;
    info: SqlitePagerProgress;
    commit?: SqlitePageCommit;
    reads: number;
    cacheBytes: number;
  }> {
    const run = this.queue.then(async () => {
      if (this.poisoned)
        throw Error("SQLite pager requires reopen after uncertain publication");
      const before = await this.store.head();
      if ((before?.generation ?? 0) !== this.generation) {
        this.poisoned = true;
        throw Error("stale SQLite page generation");
      }
      const batch = this.prepare(this.pager);
      let info = checked<SqlitePagerProgress>(
        this.runtime.sqlite_pager_info(batch),
      );
      if (
        before &&
        (before.programId !== info.programId || info.serial < before.serial)
      )
        throw Error("SQLite pager source does not match the persisted head");
      let reads = 0;
      while (!info.ready) {
        const page = info.need!;
        let data = this.cache.get(page);
        if (data) {
          this.cache.delete(page);
          this.cache.set(page, data);
        } else {
          data = await this.store.readPage(this.generation, page);
          reads++;
          this.put(page, data);
        }
        info = checked<SqlitePagerProgress>(
          this.runtime.sqlite_pager_supply(batch, page, data),
        );
      }
      if (!info.snapshot && !info.pages.length) {
        checked(this.runtime.sqlite_pager_ack(this.pager, batch));
        return {
          created: false,
          head: await this.store.head(),
          info,
          reads,
          cacheBytes: this.cache.size * info.pageSize,
        };
      }
      const commit: SqlitePageCommit = {
        programId: info.programId,
        pageSize: info.pageSize,
        pageCount: info.pageCount,
        serial: info.serial,
        snapshot: info.snapshot,
        pages: info.pages.map((page, i) => ({
          page,
          data: this.runtime.sqlite_pager_page(batch, i),
        })),
      };
      if (this.prepareCommit)
        Object.assign(commit, await this.prepareCommit(before, commit));
      let head: SqlitePageHead;
      try {
        head = await this.store.commit(this.generation, commit);
        checked(this.runtime.sqlite_pager_ack(this.pager, batch));
      } catch (e) {
        this.poisoned = true;
        throw e;
      }
      this.generation = head.generation;
      if (info.snapshot) this.cache.clear();
      for (const p of commit.pages) this.put(p.page, p.data.slice());
      return {
        created: true,
        head,
        info,
        commit,
        reads,
        cacheBytes: this.cache.size * info.pageSize,
      };
    });
    // The caller owns the result/error; the scheduling tail retains neither.
    this.queue = run.then(
      () => {},
      () => {},
    );
    return run;
  }
  /** Maintenance shares the publication queue and retains the engine baseline. */
  pruneFiles(names: readonly string[]): Promise<SqlitePageHead> {
    const removeFiles = [...names];
    const run = this.queue.then(async () => {
      if (this.poisoned)
        throw Error("SQLite pager requires reopen after uncertain publication");
      const before = await this.store.head();
      if (!before || before.generation !== this.generation) {
        this.poisoned = true;
        throw Error("stale SQLite page generation");
      }
      if (
        new Set(removeFiles).size !== removeFiles.length ||
        removeFiles.some((n) => !before.files?.includes(n))
      )
        throw Error("unknown SQLite outbox file");
      if (!removeFiles.length) return before;
      try {
        const head = await this.store.commit(this.generation, {
          programId: before.programId,
          pageSize: before.pageSize,
          pageCount: before.pageCount,
          serial: before.serial,
          snapshot: false,
          pages: [],
          metadata: before.metadata,
          removeFiles,
        });
        this.generation = head.generation;
        return head;
      } catch (e) {
        this.poisoned = true;
        throw e;
      }
    });
    this.queue = run.then(
      () => {},
      () => {},
    );
    return run;
  }
  close() {
    this.poisoned = true;
    this.cache.clear();
    this.store.close();
  }
}
