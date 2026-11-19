# Incremental SQLite page export

Unreleased after 0.1.2. The optional pager exports a fixed-schema SQLike database to SQLite pages and can publish an LTX file in the same IndexedDB transaction. It works with catalog-selected AOT and binary runtimes on JS and Wasm GC. The MoonBit source emitter exposes the same portable pager functions.

SQL execution still uses SQLike's in-memory row store. This exporter does not provide a SQLite VFS, lazy SQL reads from IndexedDB, WAL recovery, or a bound on total database memory.

## Build and open

Enable `sqlitePages` when [building a catalog-selected runtime](catalog-build.md). Keep the compiler and catalog data outside the runtime bundle. For example, at build time:

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { buildCatalog } from './scripts/aot-compiler.ts';
import { buildSqlikeRuntime } from './scripts/build-sqlike-runtime.ts';
import { defineSqlike, primaryKeyIndex, sqlitePages } from './src/sqlike-features.ts';

const source = {
  schema: ['CREATE TABLE notes(id INTEGER PRIMARY KEY, title TEXT)'],
  queries: [{ name: 'rename', sql: 'UPDATE notes SET title=?2 WHERE id=?1' }],
};
const { artifact } = buildCatalog(source);
await mkdir('generated', { recursive: true });
await writeFile('generated/program.json', artifact);
await buildSqlikeRuntime(
  defineSqlike({ mode: 'aot', features: [primaryKeyIndex, sqlitePages] }),
  { catalog: source, outDir: 'generated/pager-runtime' },
);
```

The browser imports the generated runtime and the separate host entry:

```ts
import * as runtime from './generated/pager-runtime/runtime.js';
import { SqlitePagerClient, IndexedDbSqlitePageStore } from '@mizchi/sqlike/pager';

const artifact = await (await fetch('./generated/program.json')).text();
// Recover the application's logical SQLike image here when reopening.
const db = runtime.aot_open(artifact, recoveredImage ?? '');
const store = await IndexedDbSqlitePageStore.open('notes-pages');
const pager = await SqlitePagerClient.open(
  runtime, store, p => runtime.aot_pager_prepare(db, p),
  { cachePages: 8 },
);
await pager.flush();
// Execute named writes, then flush again at an application checkpoint.
```

`recoveredImage` is the application's previously saved logical SQLike image. This API exports the supplied connection; it does not reconstruct that connection from the page store. Keep SQLike's existing logical persistence, and attach the exporter to the recovered authoritative source. A different program or an older source serial is rejected. All source writes and checkpoints should be serialized by the application.

`info.changedRows` counts collected candidate updates and can stop early when the task falls back. `flush()` returns `created`, `head`, `info`, page writes, actual provider reads and clean-cache bytes. The engine waits for requested pages asynchronously. It advances its baseline only after the provider commits. A rejected or uncertain publication requires reopening the client; a durable file whose ACK was lost remains available in the store.

## Atomic LTX outbox

Add the independent Litestream codec through `prepareCommit`:

```ts
import * as ltxRuntime from '@mizchi/litestream/engine';
import { createPageLtxEncoder } from '@mizchi/litestream/ltx/core';

const encoder = createPageLtxEncoder(ltxRuntime, store);
const pager = await SqlitePagerClient.open(
  runtime, store, p => runtime.aot_pager_prepare(db, p),
  { cachePages: 8, prepareCommit: encoder.prepareCommit },
);
await pager.flush();
const head = await store.head();
for (const name of head?.files ?? []) {
  const file = await store.readFile(head!.generation, name);
  // Upload through the application's existing LTX transport and receipt policy.
}
```

Pages, changed CRC records, the LTX file and its next checksum state publish through one generation CAS and one strict IndexedDB transaction. The hook creates a candidate without advancing state. A late ACK or concurrent writer cannot acknowledge a different candidate. The binary codec reads only CRCs for changed pages; it does not parse and save the whole checksum catalog on each update. Calling `createPageLtxEncoder(runtime)` without storage retains the legacy synchronous JSON route.

Files remain in the outbox until a verified remote ACK. Use `await pager.pruneFiles(names)` to remove acknowledged names through the same publication queue while retaining the engine baseline and clean cache. A maximum of 128 files bounds the outbox. The low-level API leaves transport and receipt verification to the application; the durable adapter below connects the existing uploader.

## Existing durable checkpoint adapter

The repository's `AotDatabase` adapter now accepts an optional atomic page provider. It uses the repository's prebuilt AOT runtime, and exposes the same `execute()`, `checkpoint()`, `pending()` and `acknowledge()` methods:

```ts
import { AotDatabase } from './adapters/aot-database.ts';
import { syncAotLtx } from './src/aot-upload.ts';

const db = await AotDatabase.open(
  'notes', artifact, manifest.artifactSHA256, undefined,
  { sqlitePages: true, cachePages: 8, outboxLimit: 128 },
);
await db.execute('rename', [1n, 'Updated']);
const checkpoint = await db.checkpoint();
if (checkpoint.deferred) {
  // SQL is durably saved locally; the existing pending files remain unchanged.
  console.log(checkpoint.deferred.reason); // 'outbox-full'
}
await syncAotLtx(db, 'https://example.test/aot-ltx/notes');
await db.close();
```

Pass the same option when reopening. The default provider is `IndexedDbAotPageStore`; custom providers implement `AotPageImageStore` and are passed to `withStore(artifact, hash, store, options)`. The provider and contracts are also available from the engine-free `@mizchi/sqlike/pager` entry. `AotDatabase` in this example is the repository adapter; the npm `openAotDatabase()` remains the in-memory connection API.

Ordinary writes retain the existing logical journal. At a checkpoint, the logical checkpoint cursor, SQLite page changes, LTX bytes and checksum metadata commit in **one strict IndexedDB transaction**, with both logical and page generation checks. The logical journal does not duplicate the SQLite image or LTX payload. After remote ACK verification, the acknowledgement cursor and physical removal of the corresponding outbox files also commit together. Pruning preserves a warm pager's baseline. Active SQL transactions cannot checkpoint or acknowledge LTX.

The durable adapter defers changed checkpoints when the pending file count reaches `outboxLimit` (integer 1–128, default 128). It returns `{ created: false, head, deferred: { reason: 'outbox-full', pending, limit } }` before preparing pages or publishing storage. SQL writes and logical compaction continue durably; the existing files, TXID and checkpoint cursor stay unchanged. An already-current checkpoint remains a plain `{ created: false, head }`. This policy also applies to inline histories; legacy histories with more pending files can still open and drain. Storage failures still require recovery as before.

`syncAotLtx()` first uploads a captured set of pending files and verifies their ACKs, checkpoints the latest durable SQL, then uploads another captured set. Each call performs at most two upload passes and one checkpoint. If writes arrive after that checkpoint, call it again to send them. `uploadAotLtx()` retains its upload-only behavior. Neither helper automatically retries network failures. Deferral survives reopening because it is derived from the durable pending list and SQL/checkpoint serials. `inspect()` exposes `serial` and `checkpointSerial` to identify updates awaiting a checkpoint. The limit bounds file count, not SQL size or total memory. [Backpressure and recovery tests](internal/aot-outbox-backpressure.md).

Reopening replays logical changes, verifies the page cursor and pending file hashes, and then reconstructs the connection. A lost local publication ACK requires reopening; a lost upload ACK retains the file for an idempotent retry. The next checkpoint after a cold reopen still uses full generation.

Existing inline SQLite/LTX histories can opt in. The next changed checkpoint seeds checksum metadata from the saved base and atomically moves remaining outbox files into page storage, preserving TXIDs, exact pending bytes and upload ownership. A failed migration leaves the original history intact. Once page-backed, opening through a snapshot-only provider is rejected.

The shared IndexedDB schema upgrades v1/v2/v3 databases to v4, preserving logical snapshots and journals and adding page/CRC stores. Older readers that request a lower database version cannot open the upgraded database. The standalone page store upgrades to v3. Retain the new reader after upgrading.

## Supported incremental changes

- Updates that preserve rowid on a rowid table. A leaf can be repacked when a changed record still fits.
- Unchanged ordinary index keys. Changed keys, expression/partial indexes and WITHOUT ROWID writes use the full exporter.
- Same-length overflow records. The engine verifies the previous payload and only emits changed overflow pages.
- Failed SQL, rollback and savepoints keep the logical state authoritative. Active SQL transactions cannot be checkpointed.

Initial export, cold reopening, insert/delete, rowid changes, sequence changes, page splits, incompatible layout changes and resource-budget overflow use the existing full exporter. An unsupported or corrupt page supplied to an incremental task fails without publishing a candidate.

The clean cache defaults to eight pages, configurable from zero to 128. Dirty page payloads are capped at 4 MiB before falling back. These budgets exclude SQLike's logical rows, retained immutable row roots, encoded before/after records and candidate snapshots. Logical change detection currently scans row-block references. The CRC catalog has one 8-byte value per page, plus record/key/SHA-256 overhead; only changed entries are published during an incremental update. Initial snapshots and legacy migration process the full catalog. The durable AOT adapter uses binary row chunks for periodic logical compaction when the provider supports `commitSnapshot`; snapshot-only providers keep the JSON format. Old JSON checkpoints remain readable. Chunks, journal reset, pages and LTX are published in the same strict transaction. Providers with `commitCheckpoint` reuse immutable parts and encode only changed row blocks after the baseline is established. Initial and cold checkpoints still encode all rows; manifests still cover all blocks. [Differential logical checkpoints](internal/incremental-logical-checkpoint.md). This does not impose a constant total-memory budget. Older readers cannot load the new chunk manifest. [Logical snapshot contract and measurements](internal/logical-snapshot-chunks.md). [CRC format and comparison](internal/ltx-page-checksums.md).

## Other backends

`SqlitePageStore` separates the engine from storage. `MemorySqlitePageStore` is available for Node or tests, and a custom provider can use another filesystem or database if it preserves owned buffers, generation checks and atomic publication of pages, metadata and files.

For binary catalogs, build with `sqlitePages` and include the binary storage layout. Use `defined_pager_prepare(handle, catalog.storage, pager)`. The ordinary binary runtime still omits the exporter unless selected.

For Wasm, adapt the exported functions with `sqlitePagerWasm(instance.exports)`. Its transfer boundary encodes one requested or changed page at a time. `ltxPageWasm()` adapts an independent Wasm LTX codec. AOT and binary definitions remain parser-free.

[Implementation and measurements](internal/incremental-pager.md) · [Public provider and runtime contracts](../src/sqlite-pager-contract.ts)
