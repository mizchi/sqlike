import { sha256 } from "../src/aot-values.ts";
import { decodeDrizzleConstant, encodeDrizzlePlaceholder } from "../src/drizzle-defined-values.ts";
import type { CompiledDrizzleCatalog, DrizzleParameter } from "../src/drizzle-defined-contract.ts";
import type { DefinedDatabaseFactory } from "../src/defined-database-contract.ts";
import type { ImageStore, ImageStoreFactory } from "../src/persistence-contract.ts";

/** Opens this exact catalog; binding plans cannot be attached to a different DB. */
export async function openDrizzlePrepared(
  factory: DefinedDatabaseFactory,
  input: CompiledDrizzleCatalog,
  {
    image,
    store,
    name,
    provider,
  }: {
    image?: Uint8Array;
    store?: ImageStore;
    name?: string;
    provider?: ImageStoreFactory;
  } = {},
) {
  if (Number(image !== undefined) + Number(store !== undefined) + Number(name !== undefined) > 1)
    throw Error("Drizzle prepared image, store and name are mutually exclusive");
  if (provider && !name) throw Error("Drizzle prepared provider requires a database name");
  if (name !== undefined && (typeof name !== "string" || !name))
    throw Error("invalid Drizzle database name");
  const bundle = structuredClone(input);
  const { sha256: digest, ...payload } = bundle.bindings;
  if (
    payload.format !== "sqlike-drizzle-bindings@1" ||
    payload.schemaId !== bundle.catalog.manifest.schemaId ||
    payload.programId !== bundle.catalog.manifest.programId ||
    (await sha256(JSON.stringify(payload))) !== digest
  )
    throw Error("Drizzle binding plan checksum/identity mismatch");
  const plans = new Map<string, readonly DrizzleParameter[]>();
  for (const q of payload.queries) {
    const manifest = bundle.catalog.manifest.queries.find((x) => x.name === q.name);
    if (plans.has(q.name) || !manifest || manifest.parameters !== q.parameters.length)
      throw Error("invalid Drizzle query binding plan");
    for (const p of q.parameters) {
      if (p.kind === "constant") decodeDrizzleConstant(p.value);
      else if (
        p.kind !== "placeholder" ||
        typeof p.name !== "string" ||
        !p.name ||
        !["value", "boolean", "timestamp", "timestamp_ms", "json"].includes(p.codec)
      )
        throw Error("invalid Drizzle placeholder binding plan");
    }
    plans.set(q.name, q.parameters);
  }
  if (plans.size !== bundle.catalog.manifest.queries.length)
    throw Error("missing Drizzle query binding plan");
  const db =
    name !== undefined
      ? await factory.open(name, bundle.catalog, provider)
      : store
        ? await factory.withStore(bundle.catalog, store)
        : await factory.memory(bundle.catalog, { image });
  function prepare(name: string) {
    const parameters = plans.get(name);
    if (!parameters) throw Error(`unknown Drizzle compiled query: ${name}`);
    const placeholders = new Set(
      parameters.filter((p) => p.kind === "placeholder").map((p) => p.name),
    );
    const stmt = db.prepare(name);
    function bind(values: Record<string, unknown> = {}) {
      for (const key of Object.keys(values))
        if (!placeholders.has(key)) throw Error(`unknown Drizzle placeholder: ${key}`);
      return parameters!.map((p) => {
        if (p.kind === "constant") return decodeDrizzleConstant(p.value);
        if (!Object.hasOwn(values, p.name)) throw Error(`missing Drizzle placeholder: ${p.name}`);
        return encodeDrizzlePlaceholder(p.codec, values[p.name]);
      });
    }
    return {
      async execute(values?: Record<string, unknown>) {
        return stmt.execute(bind(values));
      },
      async all(values?: Record<string, unknown>) {
        return stmt.all(bind(values));
      },
      async get(values?: Record<string, unknown>) {
        return stmt.get(bind(values));
      },
    };
  }
  return {
    prepare,
    async execute(name: string, values?: Record<string, unknown>) {
      return prepare(name).execute(values);
    },
    snapshot: () => db.snapshot(),
    close: () => db.close(),
  };
}
