import { captureImageCheckpoint } from "./image-checkpoint.ts";
import {
  MoonImageStore,
  imageDeltaBytes,
  captureImageSnapshot,
} from "./moon-image-store.ts";
import { IndexedDbSqlitePageStore } from "./sqlite-page-store.ts";
import type {
  AotLogicalPublication,
  AotPageImageStore,
} from "../src/aot-checkpoint-contract.ts";
import type { SqlitePageCommit } from "../src/sqlite-pager-contract.ts";

/** Co-locates the existing logical journal with SQLite pages and the LTX outbox. */
export class IndexedDbAotPageStore
  extends MoonImageStore
  implements AotPageImageStore
{
  readonly pages: AotPageImageStore["pages"];
  private readonly pageProvider: IndexedDbSqlitePageStore;
  private constructor(db: IDBDatabase) {
    super(db);
    this.pageProvider = IndexedDbSqlitePageStore.attach(db, {
      head: "sqlite-head",
      pages: "sqlite-pages",
      files: "sqlite-files",
      checksums: "sqlite-checksums",
    });
    this.pages = {
      head: () => this.pageProvider.head(),
      readPage: (generation, page) =>
        this.pageProvider.readPage(generation, page),
      readFile: (generation, name) =>
        this.pageProvider.readFile(generation, name),
      readChecksums: (generation, pages) =>
        this.pageProvider.readChecksums!(generation, pages),
    };
  }
  static override async open(name: string): Promise<IndexedDbAotPageStore> {
    return new IndexedDbAotPageStore(await IndexedDbAotPageStore.connect(name));
  }
  async commitWithPages(
    expected: number,
    logical: AotLogicalPublication,
    pageGeneration: number,
    value: SqlitePageCommit,
  ) {
    // Capture the journal before page hashing yields, including Node Buffer inputs.
    const image = logical.image;
    const checkpoint = logical.checkpoint
      ? captureImageCheckpoint(logical.checkpoint)
      : undefined;
    const snapshot = logical.snapshot
      ? captureImageSnapshot(logical.snapshot)
      : undefined;
    if (
      image !== undefined &&
      new TextEncoder().encode(image).length > 64 * 1024 * 1024
    )
      throw Error("Moon image exceeds 64 MiB");
    const delta = logical.delta
      ? {
          text: logical.delta.text,
          ...(logical.delta.blobs
            ? { blobs: logical.delta.blobs.map((b) => Uint8Array.from(b)) }
            : {}),
        }
      : undefined;
    if (delta) imageDeltaBytes(delta);
    if (
      Number(image !== undefined) +
        Number(!!delta) +
        Number(!!snapshot) +
        Number(!!checkpoint) !==
      1
    )
      throw Error("exactly one logical publication is required");
    const [pages, prepared] = await Promise.all([
      this.pageProvider.prepareCommit(pageGeneration, value),
      checkpoint ? this.prepareCheckpoint(expected, checkpoint) : undefined,
    ]);
    const generation = await this.write(
      expected,
      image,
      delta,
      pages,
      snapshot,
      prepared,
    );
    return { generation, head: pages.head() };
  }
}
