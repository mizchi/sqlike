import type {
  DefinedRuntime,
  DefinedExecution,
  DefinedDatabaseFactory,
} from "../src/defined-database-contract.ts";
import type { DefinedCatalog } from "../src/defined-contract.ts";
import type { Value, ResultCell } from "../src/contract.ts";
import type {
  ImageStore,
  ImageStoreFactory,
} from "../src/persistence-contract.ts";
import {
  aotBindings,
  aotValue,
  sha256,
  toBase64,
  fromBase64,
} from "../src/aot-values.ts";
export type {
  DefinedRuntime,
  DefinedExecution,
} from "../src/defined-database-contract.ts";
interface Info {
  schemaId: string;
  programId: string;
  serial: number;
  schemaVersion: number;
  queryCount: number;
  autocommit: boolean;
}
interface Plan {
  parameters: number;
  names: string[];
  readonly: boolean;
}
interface Saved {
  format: "sqlike-defined-store@1";
  schemaId: string;
  image: string;
}
interface Journal {
  format: "sqlike-defined-journal@1";
  schemaId: string;
  base: number;
  serial: number;
  blob: 0;
}
const decode = <T>(text: string): T => {
  const value = JSON.parse(text) as T & { error?: string; code?: string };
  if (value.error)
    throw Object.assign(Error(value.error), { code: value.code });
  return value;
};
/** Bind a runtime once, without importing a default engine. */
export function createDefinedDatabase(
  defaultRuntime: DefinedRuntime,
): DefinedDatabaseFactory {
  /** Fixed-schema, named-statement execution. Persistent publication uses the
   * existing strict ImageStore/CAS boundary; core images contain no schema. */
  class DefinedDatabase {
    private queue: Promise<void> = Promise.resolve();
    private closed = false;
    private poisoned = false;
    private plans = new Map<string, Plan>();
    private generation = 0;
    private durableSerial: number;
    private constructor(
      private handle: ReturnType<DefinedRuntime["defined_open"]>,
      private catalog: DefinedCatalog,
      private runtime: DefinedRuntime,
      private store?: ImageStore,
    ) {
      this.durableSerial = this.info().serial;
    }
    static async memory(
      catalog: DefinedCatalog,
      options: { image?: Uint8Array; runtime?: DefinedRuntime } = {},
    ): Promise<DefinedDatabase> {
      const input = {
        schema: catalog.schema.slice(),
        statements: catalog.statements.slice(),
        manifest: structuredClone(catalog.manifest),
      };
      const image = options.image?.slice();
      if (image !== undefined && image.length === 0)
        throw Error("invalid binary snapshot header");
      if (
        input.manifest.format !== "sqlike-defined-build@1" ||
        (await sha256(input.schema)) !== input.manifest.schemaSHA256 ||
        (await sha256(input.statements)) !== input.manifest.statementsSHA256
      )
        throw Error("defined artifact hash mismatch");
      const runtime = options.runtime ?? defaultRuntime;
      const handle = runtime.defined_open(
        input.schema,
        input.statements,
        image ?? new Uint8Array(),
      );
      const info = decode<Info>(runtime.defined_info(handle));
      if (
        info.schemaId !== input.manifest.schemaId ||
        info.programId !== input.manifest.programId
      )
        throw Error("defined artifact identity mismatch");
      decode(runtime.defined_ack_delta(handle, info.serial));
      return new DefinedDatabase(handle, input, runtime);
    }
    static async open(
      name: string,
      catalog: DefinedCatalog,
      provider?: ImageStoreFactory,
    ): Promise<DefinedDatabase> {
      if (!/^[A-Za-z0-9_-]{1,56}$/.test(name))
        throw Error("invalid defined database name");
      const store = await (
        provider ?? (await import("./moon-image-store.ts")).MoonImageStore.open
      )(`defined-${name}`);
      return this.withStore(catalog, store);
    }
    static async withStore(
      catalog: DefinedCatalog,
      store: ImageStore,
    ): Promise<DefinedDatabase> {
      try {
        const current = await store.read();
        let image: Uint8Array | undefined;
        if (current.image !== undefined) {
          const saved = JSON.parse(current.image) as Saved;
          if (
            saved.format !== "sqlike-defined-store@1" ||
            saved.schemaId !== catalog.manifest.schemaId ||
            typeof saved.image !== "string"
          )
            throw Error("defined saved schema mismatch");
          image = fromBase64(saved.image);
        } else if (current.deltas?.length)
          throw Error("defined journal has no snapshot");
        const db = await this.memory(catalog, { image });
        db.store = store;
        db.generation = current.generation;
        for (const delta of current.deltas ?? []) {
          const j = JSON.parse(delta.text) as Journal;
          const before = db.info();
          if (
            j.format !== "sqlike-defined-journal@1" ||
            j.schemaId !== before.schemaId ||
            j.blob !== 0 ||
            delta.blobs?.length !== 1 ||
            !(delta.blobs[0] instanceof Uint8Array) ||
            j.base !== before.serial ||
            !Number.isSafeInteger(j.serial)
          )
            throw Error("invalid defined journal");
          decode(db.runtime.defined_apply_delta(db.handle, delta.blobs[0]));
          if (db.info().serial !== j.serial)
            throw Error("defined journal serial mismatch");
          db.durableSerial = j.serial;
        }
        if (current.image === undefined) await db.persist(db.handle, true);
        return db;
      } catch (error) {
        store.close();
        throw error;
      }
    }
    private info(handle = this.handle): Info {
      return decode<Info>(this.runtime.defined_info(handle));
    }
    private serial<T>(body: () => Promise<T> | T): Promise<T> {
      const task = this.queue.then(() => {
        if (this.closed) throw Error("defined database is closed");
        if (this.poisoned)
          throw Error("defined commit outcome requires reopen");
        return body();
      });
      // The caller receives the outcome; scheduling must not retain result buffers.
      this.queue = task.then(
        () => {},
        () => {},
      );
      return task;
    }
    private plan(name: string): Plan {
      let plan = this.plans.get(name);
      if (!plan) {
        plan = decode<Plan>(this.runtime.defined_query_info(this.handle, name));
        this.plans.set(name, plan);
      }
      return plan;
    }
    private snapshotOf(handle = this.handle): Uint8Array {
      const result = this.runtime.defined_snapshot(handle);
      decode(this.runtime.binary_info(result));
      return this.runtime.binary_data(result).slice();
    }
    private async persist(
      handle: ReturnType<DefinedRuntime["defined_open"]>,
      force = false,
    ): Promise<void> {
      if (!this.store) {
        this.durableSerial = this.info(handle).serial;
        decode(this.runtime.defined_ack_delta(handle, this.durableSerial));
        this.handle = handle;
        return;
      }
      const result = this.runtime.defined_delta(
        handle,
        force || !this.generation || !!this.store.checkpointNeeded?.(),
      );
      const meta = decode<{ full: boolean; serial: number }>(
        this.runtime.binary_info(result),
      );
      const bytes = this.runtime.binary_data(result).slice();
      let publishing = false;
      try {
        let generation: number;
        publishing = true;
        if (!meta.full && this.store.commitDelta) {
          const j: Journal = {
            format: "sqlike-defined-journal@1",
            schemaId: this.catalog.manifest.schemaId,
            base: this.durableSerial,
            serial: meta.serial,
            blob: 0,
          };
          generation = await this.store.commitDelta(this.generation, {
            text: JSON.stringify(j),
            blobs: [bytes],
          });
        } else {
          const image = meta.full ? bytes : this.snapshotOf(handle);
          const saved: Saved = {
            format: "sqlike-defined-store@1",
            schemaId: this.catalog.manifest.schemaId,
            image: toBase64(image),
          };
          generation = await this.store.commit(
            this.generation,
            JSON.stringify(saved),
          );
        }
        if (generation !== this.generation + 1)
          throw Error("uncertain defined commit generation");
        this.generation = generation;
        this.durableSerial = meta.serial;
        decode(this.runtime.defined_ack_delta(handle, meta.serial));
        this.handle = handle;
      } catch (error) {
        if (publishing) this.poisoned = true;
        throw error;
      }
    }
    execute(name: string, params: Value[] = []): Promise<DefinedExecution> {
      // Capture queued input so mutation by the caller cannot change a command.
      const bound = aotBindings(params),
        count = params.length;
      return this.serial(async () => {
        const plan = this.plan(name);
        if (count !== plan.parameters)
          throw Error("SQL binding count mismatch");
        const candidate = plan.readonly
          ? this.handle
          : this.runtime.defined_clone(this.handle);
        decode(this.runtime.defined_set_clock(candidate, String(Date.now())));
        let result: {
          names: string[];
          rows: ResultCell[][];
          readonly: boolean;
          changes: number;
        };
        try {
          result = decode(this.runtime.defined_execute(candidate, name, bound));
        } catch (error) {
          if (!plan.readonly)
            decode(
              this.runtime.defined_copy_connection_state(
                this.handle,
                candidate,
              ),
            );
          throw error;
        }
        const output = {
          ...result,
          rows: result.rows.map((row) => row.map(aotValue)),
        };
        if (!plan.readonly) {
          if (!this.info(candidate).autocommit) this.handle = candidate;
          else await this.persist(candidate);
        }
        return output;
      });
    }
    prepare(name: string): DefinedStatement {
      this.plan(name);
      return new DefinedStatement(this, name);
    }
    inspect(name: string, params: Value[] = []): Promise<DefinedExecution> {
      if (!this.plan(name).readonly)
        return Promise.reject(Error("inspect requires a read-only statement"));
      return this.execute(name, params);
    }
    snapshot(): Promise<Uint8Array> {
      return this.serial(() => this.snapshotOf());
    }
    close(): Promise<void> {
      return this.queue.then(() => {
        if (this.closed) return;
        if (!this.info().autocommit)
          throw Error("cannot close an active transaction");
        this.closed = true;
        this.store?.close();
      });
    }
  }
  return DefinedDatabase;
}
export class DefinedStatement {
  constructor(
    private database: {
      execute(name: string, params: Value[]): Promise<DefinedExecution>;
    },
    private name: string,
  ) {}
  execute(params: Value[] = []) {
    return this.database.execute(this.name, params);
  }
  async all(params: Value[] = []): Promise<Value[][]> {
    return (await this.execute(params)).rows;
  }
  async get(params: Value[] = []): Promise<Value[] | undefined> {
    return (await this.all(params))[0];
  }
}
