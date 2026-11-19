import { SQLITE_PAGE_FILE_LIMIT } from "../src/sqlite-pager-contract.ts";
import * as runtime from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import type { ResultCell, Value } from "../src/contract.ts";
import {
  aotBindings,
  aotValue,
  fromBase64,
  sha256,
} from "../src/aot-values.ts";
import type {
  ImageStore,
  ImageStoreFactory,
} from "../src/persistence-contract.ts";
import {
  uploadEndpoint,
  validUploadBinding,
  type AotUploadBinding,
  type AotLtxSyncSource,
} from "../src/aot-upload-contract.ts";
import {
  aotJournal,
  applyAotJournal,
  type SavedState,
  type PendingFile,
} from "./aot-journal.ts";
import {
  isAotPageImageStore,
  type AotDatabaseOptions,
  type AotPageImageStore,
  type AotCheckpoint,
} from "../src/aot-checkpoint-contract.ts";
import type {
  SqlitePageCommit,
  SqlitePageHead,
} from "../src/sqlite-pager-contract.ts";
import type { SqlitePagerClient } from "../src/sqlite-pager.ts";

export type AotImageStore = ImageStore;
export type { AotCheckpoint } from "../src/aot-checkpoint-contract.ts";
interface CoreInfo {
  error?: string;
  programId: string;
  serial: number;
  schemaVersion: number;
  queryCount: number;
  autocommit: boolean;
}
interface QueryInfo {
  error?: string;
  parameters: number;
  names: string[];
  readonly: boolean;
}
export interface AotExecution {
  names: string[];
  rows: Value[][];
  readonly: boolean;
  changes: number;
}
const MAX_TXID = 0xffffffffffffffffn;
function txid(value: unknown): bigint {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    BigInt(value) > MAX_TXID
  )
    throw Error("invalid saved TXID");
  return BigInt(value);
}
function result<T extends { error?: string }>(value: string): T {
  const decoded = JSON.parse(value) as T;
  if (decoded.error)
    throw Object.assign(Error(decoded.error), {
      code: (decoded as { code?: string }).code,
    });
  return decoded;
}
function filename(file: Pick<PendingFile, "minTXID" | "maxTXID">) {
  return `${BigInt(file.minTXID).toString(16).padStart(16, "0")}-${BigInt(file.maxTXID).toString(16).padStart(16, "0")}.ltx`;
}

/** Async host publication surrounds a synchronous, parser-free MoonBit core.
 * Writes run on a private clone and become visible only after strict IDB commit. */
export class AotDatabase implements AotLtxSyncSource {
  private queue: Promise<void> = Promise.resolve();
  private plans = new Map<string, QueryInfo>();
  private requiresReload = false;
  private closed = false;
  private snapshotBaseline?: ReturnType<
    typeof runtime.aot_snapshot_incremental
  >;
  private snapshotGeneration?: number;
  private pager?: SqlitePagerClient<
    ReturnType<typeof runtime.sqlite_pager_open>,
    ReturnType<typeof runtime.aot_pager_prepare>
  >;
  private constructor(
    private handle: ReturnType<typeof runtime.aot_open>,
    private store: AotImageStore,
    private generation: number,
    private saved: SavedState,
    private artifactHash: string,
    private options: AotDatabaseOptions,
  ) {}
  static async open(
    name: string,
    artifact: string,
    artifactHash: string,
    provider?: ImageStoreFactory,
    options: AotDatabaseOptions = {},
  ): Promise<AotDatabase> {
    if (!/^[A-Za-z0-9_-]{1,60}$/.test(name))
      throw Error("invalid AOT database name");
    options = { ...options };
    return this.withStore(
      artifact,
      artifactHash,
      await (
        provider ??
        (options.sqlitePages
          ? (await import("./aot-page-store.ts")).IndexedDbAotPageStore.open
          : (await import("./moon-image-store.ts")).MoonImageStore.open)
      )(`aot-${name}`),
      options,
    );
  }
  static async withStore(
    artifact: string,
    artifactHash: string,
    store: AotImageStore,
    options: AotDatabaseOptions = {},
  ): Promise<AotDatabase> {
    try {
      options = { ...options };
      if (
        options.outboxLimit !== undefined &&
        (!Number.isInteger(options.outboxLimit) ||
          options.outboxLimit < 1 ||
          options.outboxLimit > SQLITE_PAGE_FILE_LIMIT)
      )
        throw Error("invalid AOT outbox limit");
      if (
        options.cachePages !== undefined &&
        (!Number.isInteger(options.cachePages) ||
          options.cachePages < 0 ||
          options.cachePages > 128)
      )
        throw Error("invalid AOT page cache limit");
      if (options.sqlitePages && !isAotPageImageStore(store))
        throw Error("SQLite pager requires an atomic logical/page store");
      if ((await sha256(artifact)) !== artifactHash)
        throw Error("compiled artifact hash mismatch");
      const current = await store.read();
      let saved: SavedState | undefined;
      const replay: string[] = [];
      if (current.image !== undefined && current.snapshot)
        throw Error("ambiguous AOT snapshot representation");
      if (current.image !== undefined || current.snapshot) {
        saved = JSON.parse(
          current.snapshot?.text ?? current.image!,
        ) as SavedState;
        if (
          current.snapshot
            ? saved.image !== "" || typeof saved.logical !== "string"
            : saved.logical !== undefined
        )
          throw Error("invalid AOT chunk snapshot envelope");
        if (
          saved.format !== "moon-aot-store@1" ||
          typeof saved.image !== "string" ||
          typeof saved.programId !== "string" ||
          typeof saved.base !== "string" ||
          typeof saved.baseHash !== "string" ||
          !Number.isSafeInteger(saved.checkpointSerial) ||
          saved.checkpointSerial < -1 ||
          !Array.isArray(saved.pending)
        )
          throw Error("invalid saved AOT state");
        for (const delta of current.deltas ?? []) {
          const applied = applyAotJournal(saved, delta);
          saved = applied.saved;
          if (applied.core) replay.push(applied.core);
        }
        if (
          saved.upload !== undefined &&
          (!validUploadBinding(saved.upload) ||
            saved.upload.artifactSHA256 !== artifactHash)
        )
          throw Error("invalid saved LTX upload binding");
        const head = txid(saved.head),
          acked = txid(saved.acked);
        if (acked > head) throw Error("saved checkpoint order mismatch");
        if (
          saved.pager &&
          (!isAotPageImageStore(store) ||
            saved.pager.format !== "aot-pages@1" ||
            !Number.isSafeInteger(saved.pager.generation) ||
            saved.pager.generation < 1)
        )
          throw Error("saved AOT pages require a compatible atomic store");
        if (
          (!saved.pager && (head === 0n) !== (saved.base === "")) ||
          (saved.pager && saved.base !== "") ||
          (await sha256(fromBase64(saved.base))) !== saved.baseHash
        )
          throw Error("saved SQLite base hash mismatch");
        let cursor = acked;
        for (const file of saved.pending) {
          const min = txid(file.minTXID),
            max = txid(file.maxTXID),
            bytes = saved.pager
              ? await (store as AotPageImageStore).pages.readFile(
                  saved.pager.generation,
                  filename(file),
                )
              : fromBase64(file.data);
          if (
            min !== cursor + 1n ||
            max !== min ||
            !Number.isSafeInteger(file.size) ||
            bytes.length !== file.size ||
            (saved.pager && file.data !== "") ||
            (await sha256(bytes)) !== file.sha256
          )
            throw Error("saved LTX outbox gap or hash mismatch");
          cursor = max;
        }
        if (cursor !== head)
          throw Error("saved LTX outbox does not reach checkpoint head");
        if (saved.pager) {
          const page = await (store as AotPageImageStore).pages.head();
          const cursor = page?.metadata ? JSON.parse(page.metadata) : undefined;
          if (
            !page ||
            page.generation !== saved.pager.generation ||
            page.programId !== saved.programId ||
            page.serial !== saved.checkpointSerial ||
            !page.metadata ||
            cursor?.txid !== saved.head ||
            cursor.pageSize !== page.pageSize ||
            cursor.pageCount !== page.pageCount ||
            (cursor.format === "ltx-page-state@2" &&
              (page.checksumFormat !== "crc64-be@1" ||
                !(store as AotPageImageStore).pages.readChecksums)) ||
            JSON.stringify(page.files ?? []) !==
              JSON.stringify(saved.pending.map(filename).sort())
          )
            throw Error("saved AOT logical/page checkpoint mismatch");
        }
      }
      if (
        !saved?.pager &&
        isAotPageImageStore(store) &&
        (await store.pages.head())
      )
        throw Error("orphan AOT page checkpoint");
      const handle = runtime.aot_open(artifact, saved?.image ?? "");
      result<CoreInfo>(runtime.aot_info(handle));
      if (current.snapshot) {
        const header = result<{ error?: string; parts: number }>(
          saved!.logical!,
        );
        if (header.parts !== current.snapshot.chunks.length)
          throw Error("AOT logical snapshot chunk count mismatch");
        const reader = runtime.aot_snapshot_restore(handle, saved!.logical!);
        for (const chunk of current.snapshot.chunks)
          result(runtime.aot_snapshot_supply(reader, chunk));
        result(runtime.aot_snapshot_finish(reader));
      }
      for (const delta of replay)
        result(runtime.aot_apply_delta(handle, delta));
      const info = result<CoreInfo>(runtime.aot_info(handle));
      if (
        saved &&
        (saved.programId !== info.programId ||
          saved.checkpointSerial > info.serial)
      )
        throw Error("saved AOT program/cursor mismatch");
      const initial: SavedState = saved ?? {
        format: "moon-aot-store@1",
        programId: info.programId,
        image: "",
        head: "0",
        acked: "0",
        checkpointSerial: -1,
        base: "",
        baseHash: await sha256(new Uint8Array()),
        pending: [],
      };
      const db = new AotDatabase(
        handle,
        store,
        current.generation,
        initial,
        artifactHash,
        { ...options, sqlitePages: options.sqlitePages || !!saved?.pager },
      );
      if (!saved) await db.publish(initial, handle);
      else result(runtime.aot_ack_delta(handle, info.serial));
      // The live engine is the read state. Do not retain the full serialized
      // checkpoint between journal commits; a new checkpoint is dumped on demand.
      if (store.commitDelta) db.saved = { ...db.saved, image: "" };
      return db;
    } catch (error) {
      store.close();
      throw error;
    }
  }
  private serial<T>(operation: () => Promise<T> | T): Promise<T> {
    const task = this.queue.then(() => {
      if (this.closed) throw Error("AOT database is closed");
      if (this.requiresReload)
        throw Error("AOT commit outcome requires reload");
      return operation();
    });
    // Return the original outcome to the caller. The scheduling tail retains no
    // result buffers and allows the next operation after either outcome.
    this.queue = task.then(
      () => {},
      () => {},
    );
    return task;
  }
  private plan(name: string): QueryInfo {
    let plan = this.plans.get(name);
    if (!plan) {
      plan = result<QueryInfo>(runtime.aot_query_info(this.handle, name));
      this.plans.set(name, plan);
    }
    return plan;
  }
  private run(
    handle: ReturnType<typeof runtime.aot_open>,
    name: string,
    params: Value[],
  ): AotExecution {
    result(runtime.aot_set_clock(handle, String(Date.now())));
    const info = this.plan(name);
    if (params.length !== info.parameters)
      throw Error("SQL binding count mismatch");
    const response = result<{
      error?: string;
      rows: ResultCell[][];
      names: string[];
      readonly: boolean;
      changes: number;
    }>(runtime.aot_execute(handle, name, aotBindings(params)));
    return { ...response, rows: response.rows.map((row) => row.map(aotValue)) };
  }
  private async publish(
    saved: SavedState,
    handle = this.handle,
    core?: string,
    pages?: {
      expected: number;
      value: SqlitePageCommit;
      forceSnapshot?: boolean;
    },
  ): Promise<SqlitePageHead | undefined> {
    try {
      let generation: number;
      let pageHead: SqlitePageHead | undefined;
      let nextBaseline:
        | ReturnType<typeof runtime.aot_snapshot_incremental>
        | undefined;
      const full =
        pages?.forceSnapshot ||
        (core
          ? result<{ error?: string; data: { full: boolean } }>(core).data.full
          : false);
      if (
        this.generation &&
        this.store.commitDelta &&
        !this.store.checkpointNeeded?.() &&
        !full
      ) {
        const delta = aotJournal(this.saved, saved, core);
        if (pages) {
          const committed = await (
            this.store as AotPageImageStore
          ).commitWithPages(
            this.generation,
            { delta },
            pages.expected,
            pages.value,
          );
          generation = committed.generation;
          pageHead = committed.head;
        } else
          generation = await this.store.commitDelta(this.generation, delta);
      } else if (this.store.commitCheckpoint) {
        const snapshot = runtime.aot_snapshot_incremental(handle);
        const logical = runtime.aot_snapshot_info(snapshot);
        const { parts } = result<{ error?: string; parts: number }>(logical);
        const chunks: (Uint8Array | number)[] = [];
        for (let i = 0; i < parts; i++) {
          const reuse = this.snapshotBaseline
            ? runtime.aot_snapshot_reuse(snapshot, this.snapshotBaseline, i)
            : -1;
          if (reuse >= 0) chunks.push(reuse);
          else {
            const chunk = runtime.aot_snapshot_chunk(snapshot, i);
            result(runtime.sqlite_info(chunk));
            chunks.push(runtime.sqlite_data(chunk));
          }
        }
        saved = { ...saved, image: "", logical };
        const value = {
          text: JSON.stringify(saved),
          chunks,
          base: this.snapshotGeneration,
        };
        if (pages) {
          const committed = await (
            this.store as AotPageImageStore
          ).commitWithPages(
            this.generation,
            { checkpoint: value },
            pages.expected,
            pages.value,
          );
          generation = committed.generation;
          pageHead = committed.head;
        } else
          generation = await this.store.commitCheckpoint(
            this.generation,
            value,
          );
        nextBaseline = snapshot;
      } else if (this.store.commitSnapshot) {
        const snapshot = runtime.aot_snapshot_open(handle);
        const logical = runtime.aot_snapshot_info(snapshot);
        const { parts } = result<{ error?: string; parts: number }>(logical);
        const chunks: Uint8Array[] = [];
        for (let i = 0; i < parts; i++) {
          const chunk = runtime.aot_snapshot_chunk(snapshot, i);
          result(runtime.sqlite_info(chunk));
          chunks.push(runtime.sqlite_data(chunk));
        }
        saved = { ...saved, image: "", logical };
        const value = { text: JSON.stringify(saved), chunks };
        if (pages) {
          const committed = await (
            this.store as AotPageImageStore
          ).commitWithPages(
            this.generation,
            { snapshot: value },
            pages.expected,
            pages.value,
          );
          generation = committed.generation;
          pageHead = committed.head;
        } else
          generation = await this.store.commitSnapshot(this.generation, value);
      } else {
        const image = runtime.aot_dump(handle);
        result(image);
        saved = { ...saved, image, logical: undefined };
        if (pages) {
          const committed = await (
            this.store as AotPageImageStore
          ).commitWithPages(
            this.generation,
            { image: JSON.stringify(saved) },
            pages.expected,
            pages.value,
          );
          generation = committed.generation;
          pageHead = committed.head;
        } else
          generation = await this.store.commit(
            this.generation,
            JSON.stringify(saved),
          );
      }
      if (generation !== this.generation + 1)
        throw Error("uncertain AOT commit generation");
      this.generation = generation;
      result(
        runtime.aot_ack_delta(
          handle,
          result<CoreInfo>(runtime.aot_info(handle)).serial,
        ),
      );
      if (nextBaseline) {
        this.snapshotBaseline = nextBaseline;
        this.snapshotGeneration = generation;
      }
      this.saved = this.store.commitDelta ? { ...saved, image: "" } : saved;
      this.handle = handle;
      return pageHead;
    } catch (error) {
      this.requiresReload = true;
      throw error;
    }
  }
  private async pageClient() {
    if (this.pager) return this.pager;
    if (!isAotPageImageStore(this.store))
      throw Error("SQLite pager requires an atomic logical/page store");
    const store = this.store;
    const [{ SqlitePagerClient }, { createPageLtxEncoder }] = await Promise.all(
      [import("../src/sqlite-pager.ts"), import("../src/ltx-pages-host.ts")],
    );
    const encoder = createPageLtxEncoder(runtime, {
      ...(store.pages.readChecksums
        ? {
            readChecksums: (generation: number, pages: readonly number[]) =>
              store.pages.readChecksums!(generation, pages),
          }
        : {}),
    });
    this.pager = await SqlitePagerClient.open(
      runtime,
      {
        head: () => store.pages.head(),
        readPage: (g, p) => store.pages.readPage(g, p),
        close() {},
        commit: async (expected, batch) => {
          const next = String(txid(this.saved.head) + 1n);
          let saved: SavedState;
          if (batch.files?.length) {
            const file = batch.files.find(
              (f) => f.name === filename({ minTXID: next, maxTXID: next }),
            );
            if (!file) throw Error("missing candidate LTX file");
            saved = {
              ...this.saved,
              base: "",
              baseHash: await sha256(new Uint8Array()),
              head: next,
              checkpointSerial: batch.serial,
              pending: [
                ...this.saved.pending.map((f) => ({ ...f, data: "" })),
                {
                  minTXID: next,
                  maxTXID: next,
                  data: "",
                  size: file.data.length,
                  sha256: await sha256(file.data),
                },
              ],
              pager: { format: "aot-pages@1", generation: expected + 1 },
            };
          } else {
            const removed = this.saved.pending.filter((f) =>
              batch.removeFiles?.includes(filename(f)),
            );
            if (!removed.length || removed.length !== batch.removeFiles?.length)
              throw Error("invalid AOT outbox pruning");
            saved = {
              ...this.saved,
              acked: removed.at(-1)!.maxTXID,
              pending: this.saved.pending.filter(
                (f) => !batch.removeFiles!.includes(filename(f)),
              ),
              pager: { format: "aot-pages@1", generation: expected + 1 },
            };
          }
          // Migration replaces the old inline base/outbox in a logical snapshot.
          const migrating = !this.saved.pager && this.saved.head !== "0";
          const head = await this.publish(saved, this.handle, undefined, {
            expected,
            value: batch,
            forceSnapshot: migrating,
          });
          if (!head || head.generation !== expected + 1)
            throw Error("uncertain AOT page generation");
          return head;
        },
      },
      (p) => runtime.aot_pager_prepare(this.handle, p),
      {
        cachePages: this.options.cachePages,
        prepareCommit: async (head, batch) => {
          let previous = head?.metadata ?? "";
          if (!previous && this.saved.head !== "0") {
            const base = fromBase64(this.saved.base),
              size = (base[16]! << 8) | base[17]!,
              pageSize = size === 1 ? 65536 : size;
            previous = encoder.encode(
              "",
              {
                pageSize,
                pageCount: base.length / pageSize,
                snapshot: true,
                pages: Array.from(
                  { length: base.length / pageSize },
                  (_, i) => ({
                    page: i + 1,
                    data: base.slice(i * pageSize, (i + 1) * pageSize),
                  }),
                ),
              },
              "1",
              this.saved.head,
            ).state;
          }
          const next = String(txid(this.saved.head) + 1n);
          if ((previous ? JSON.parse(previous).txid : "0") !== this.saved.head)
            throw Error("AOT LTX cursor mismatch");
          const file = await encoder.encodeStored(
            head ? { ...head, metadata: previous } : { metadata: previous },
            batch,
            next,
            next,
            String(Date.now()),
          );
          return {
            metadata: file.state,
            checksums: file.checksums,
            checksumFormat: file.checksumFormat,
            checksumSnapshot: file.checksumSnapshot,
            files: [
              ...(!this.saved.pager
                ? this.saved.pending.map((f) => ({
                    name: filename(f),
                    data: fromBase64(f.data),
                  }))
                : []),
              {
                name: filename({ minTXID: next, maxTXID: next }),
                data: file.data,
              },
            ],
          };
        },
      },
    );
    return this.pager;
  }
  execute(name: string, params: Value[] = []): Promise<AotExecution> {
    return this.serial(async () => {
      if (this.plan(name).readonly) return this.run(this.handle, name, params);
      const candidate = runtime.aot_clone(this.handle);
      result<CoreInfo>(runtime.aot_info(candidate));
      let output: AotExecution;
      try {
        output = this.run(candidate, name, params);
      } catch (error) {
        result(runtime.aot_copy_connection_state(this.handle, candidate));
        throw error;
      }
      if (!result<CoreInfo>(runtime.aot_info(candidate)).autocommit) {
        this.handle = candidate;
        return output;
      }
      const core =
        this.store.commitDelta && !this.store.checkpointNeeded?.()
          ? runtime.aot_delta(candidate, false)
          : undefined;
      if (core) result(core);
      await this.publish(this.saved, candidate, core);
      return output;
    });
  }
  private metadata() {
    const info = result<CoreInfo>(runtime.aot_info(this.handle));
    return {
      programId: info.programId,
      serial: info.serial,
      checkpointSerial: this.saved.checkpointSerial,
      head: this.saved.head,
      acked: this.saved.acked,
      ...(this.saved.upload
        ? {
            upload: {
              endpoint: this.saved.upload.endpoint,
              historyId: this.saved.upload.historyId,
            },
          }
        : {}),
      pending: this.saved.pending.map((file) => ({
        name: filename(file),
        minTXID: file.minTXID,
        maxTXID: file.maxTXID,
        size: file.size,
        sha256: file.sha256,
      })),
    };
  }
  inspect(name: string, params: Value[] = []) {
    return this.serial(() => {
      if (!this.plan(name).readonly)
        throw Error("inspect requires a read-only query");
      return { ...this.metadata(), ...this.run(this.handle, name, params) };
    });
  }
  checkpoint(): Promise<AotCheckpoint> {
    return this.serial(async () => {
      const info = result<CoreInfo>(runtime.aot_info(this.handle));
      if (!info.autocommit)
        throw Error("cannot checkpoint an active SQL transaction");
      if (
        this.saved.head !== "0" &&
        this.saved.checkpointSerial === info.serial
      )
        return { created: false, head: this.saved.head };
      const current = txid(this.saved.head);
      if (current === MAX_TXID) throw Error("LTX TXID overflow");
      const limit = this.options.outboxLimit ?? SQLITE_PAGE_FILE_LIMIT;
      if (this.saved.pending.length >= limit)
        return {
          created: false,
          head: this.saved.head,
          deferred: {
            reason: "outbox-full",
            pending: this.saved.pending.length,
            limit,
          },
        };
      if (this.options.sqlitePages) {
        try {
          const out = await (await this.pageClient()).flush();
          const file = this.saved.pending.at(-1);
          return {
            created: out.created,
            head: this.saved.head,
            ...(file ? { sha256: file.sha256 } : {}),
            pages: {
              snapshot: out.info.snapshot,
              written: out.info.pages.length,
              reads: out.reads,
              cacheBytes: out.cacheBytes,
              ...(out.info.fallback ? { fallback: out.info.fallback } : {}),
            },
          };
        } catch (error) {
          this.requiresReload = true;
          throw error;
        }
      }
      const sql = runtime.aot_export_sqlite(this.handle);
      result<{ error?: string }>(runtime.sqlite_info(sql));
      const image = runtime.sqlite_data(sql),
        base = fromBase64(this.saved.base),
        next = String(current + 1n);
      const encoded = runtime.encode_ltx(
        base,
        image,
        next,
        next,
        String(Date.now()),
      );
      result<{ error?: string }>(runtime.ltx_info(encoded));
      const bytes = runtime.ltx_data(encoded),
        hash = await sha256(bytes),
        file: PendingFile = {
          minTXID: next,
          maxTXID: next,
          data: runtime.ltx_data_base64(encoded),
          sha256: hash,
          size: bytes.length,
        };
      await this.publish({
        ...this.saved,
        head: next,
        checkpointSerial: info.serial,
        base: runtime.sqlite_data_base64(sql),
        baseHash: await sha256(image),
        pending: [...this.saved.pending, file],
      });
      return { created: true, head: next, sha256: hash };
    });
  }
  pending() {
    return this.serial(async () =>
      Promise.all(
        this.saved.pending.map(async (file) => ({
          name: filename(file),
          minTXID: file.minTXID,
          maxTXID: file.maxTXID,
          sha256: file.sha256,
          data: this.saved.pager
            ? await (this.store as AotPageImageStore).pages.readFile(
                this.saved.pager.generation,
                filename(file),
              )
            : fromBase64(file.data),
        })),
      ),
    );
  }
  bindUpload(endpoint: string): Promise<AotUploadBinding> {
    return this.serial(async () => {
      const normalized = uploadEndpoint(endpoint);
      if (!result<CoreInfo>(runtime.aot_info(this.handle)).autocommit)
        throw Error("cannot bind LTX upload during an active SQL transaction");
      if (this.saved.upload) {
        if (this.saved.upload.endpoint !== normalized)
          throw Error("LTX upload endpoint is already bound to this history");
        return { ...this.saved.upload };
      }
      if (this.saved.acked !== "0")
        throw Error(
          "cannot bind an already acknowledged LTX history to a new endpoint",
        );
      const upload: AotUploadBinding = {
        endpoint: normalized,
        historyId: crypto.randomUUID(),
        token: Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
          b.toString(16).padStart(2, "0"),
        ).join(""),
        artifactSHA256: this.artifactHash,
      };
      await this.publish({ ...this.saved, upload });
      return { ...upload };
    });
  }
  acknowledge(head: string, hash: string): Promise<void> {
    return this.serial(async () => {
      if (!result<CoreInfo>(runtime.aot_info(this.handle)).autocommit)
        throw Error("cannot acknowledge LTX during an active SQL transaction");
      const id = txid(head),
        acked = txid(this.saved.acked);
      if (id <= acked) return;
      const file = this.saved.pending.find((file) => file.maxTXID === head);
      if (!file || file.sha256 !== hash)
        throw Error("LTX acknowledgement file hash mismatch");
      if (this.saved.pager) {
        try {
          await (
            await this.pageClient()
          ).pruneFiles(
            this.saved.pending
              .filter((f) => txid(f.maxTXID) <= id)
              .map(filename),
          );
        } catch (error) {
          this.requiresReload = true;
          throw error;
        }
        return;
      }
      await this.publish({
        ...this.saved,
        acked: head,
        pending: this.saved.pending.filter((file) => txid(file.maxTXID) > id),
      });
    });
  }
  exportSQLite() {
    return this.serial(() => {
      if (!result<CoreInfo>(runtime.aot_info(this.handle)).autocommit)
        throw Error("cannot export an active SQL transaction");
      const sql = runtime.aot_export_sqlite(this.handle);
      result<{ error?: string }>(runtime.sqlite_info(sql));
      return runtime.sqlite_data(sql);
    });
  }
  async close(): Promise<void> {
    await this.queue;
    this.closed = true;
    this.pager?.close();
    this.store.close();
  }
}
