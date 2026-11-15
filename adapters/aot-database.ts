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
} from "../src/aot-upload-contract.ts";
import {
  aotJournal,
  applyAotJournal,
  type SavedState,
  type PendingFile,
} from "./aot-journal.ts";

export type AotImageStore = ImageStore;
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
export interface AotCheckpoint {
  created: boolean;
  head: string;
  sha256?: string;
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
export class AotDatabase {
  private queue: Promise<unknown> = Promise.resolve();
  private plans = new Map<string, QueryInfo>();
  private requiresReload = false;
  private closed = false;
  private constructor(
    private handle: ReturnType<typeof runtime.aot_open>,
    private store: AotImageStore,
    private generation: number,
    private saved: SavedState,
    private artifactHash: string,
  ) {}
  static async open(
    name: string,
    artifact: string,
    artifactHash: string,
    provider?: ImageStoreFactory,
  ): Promise<AotDatabase> {
    if (!/^[A-Za-z0-9_-]{1,60}$/.test(name))
      throw Error("invalid AOT database name");
    return this.withStore(
      artifact,
      artifactHash,
      await (
        provider ?? (await import("./moon-image-store.ts")).MoonImageStore.open
      )(`aot-${name}`),
    );
  }
  static async withStore(
    artifact: string,
    artifactHash: string,
    store: AotImageStore,
  ): Promise<AotDatabase> {
    try {
      if ((await sha256(artifact)) !== artifactHash)
        throw Error("compiled artifact hash mismatch");
      const current = await store.read();
      let saved: SavedState | undefined;
      const replay: string[] = [];
      if (current.image !== undefined) {
        saved = JSON.parse(current.image) as SavedState;
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
          (head === 0n) !== (saved.base === "") ||
          (await sha256(fromBase64(saved.base))) !== saved.baseHash
        )
          throw Error("saved SQLite base hash mismatch");
        let cursor = acked;
        for (const file of saved.pending) {
          const min = txid(file.minTXID),
            max = txid(file.maxTXID),
            bytes = fromBase64(file.data);
          if (
            min !== cursor + 1n ||
            max !== min ||
            !Number.isSafeInteger(file.size) ||
            bytes.length !== file.size ||
            (await sha256(bytes)) !== file.sha256
          )
            throw Error("saved LTX outbox gap or hash mismatch");
          cursor = max;
        }
        if (cursor !== head)
          throw Error("saved LTX outbox does not reach checkpoint head");
      }
      const handle = runtime.aot_open(artifact, saved?.image ?? "");
      result<CoreInfo>(runtime.aot_info(handle));
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
        image: runtime.aot_dump(handle),
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
    this.queue = task.catch(() => {});
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
  ): Promise<void> {
    try {
      let generation: number;
      const full = core
        ? result<{ error?: string; data: { full: boolean } }>(core).data.full
        : false;
      if (
        this.generation &&
        this.store.commitDelta &&
        !this.store.checkpointNeeded?.() &&
        !full
      ) {
        generation = await this.store.commitDelta(
          this.generation,
          aotJournal(this.saved, saved, core),
        );
      } else {
        const image = runtime.aot_dump(handle);
        result(image);
        saved = { ...saved, image };
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
      this.saved = this.store.commitDelta ? { ...saved, image: "" } : saved;
      this.handle = handle;
    } catch (error) {
      this.requiresReload = true;
      throw error;
    }
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
    return this.serial(() =>
      this.saved.pending.map((file) => ({
        name: filename(file),
        minTXID: file.minTXID,
        maxTXID: file.maxTXID,
        sha256: file.sha256,
        data: fromBase64(file.data),
      })),
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
      const id = txid(head),
        acked = txid(this.saved.acked);
      if (id <= acked) return;
      const file = this.saved.pending.find((file) => file.maxTXID === head);
      if (!file || file.sha256 !== hash)
        throw Error("LTX acknowledgement file hash mismatch");
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
    this.store.close();
  }
}
