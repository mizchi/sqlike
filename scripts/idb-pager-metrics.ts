/** A reproducible submission-size estimate, not IndexedDB disk allocation:
 * UTF8 JSON with binary values replaced by null, plus their view byte lengths. */
export function idbValueBytes(value: unknown) {
  let binary = 0;
  function metadata(v: unknown): unknown {
    if (v instanceof ArrayBuffer) {
      binary += v.byteLength;
      return null;
    }
    if (ArrayBuffer.isView(v)) {
      binary += v.byteLength;
      return null;
    }
    if (Array.isArray(v)) return v.map(metadata);
    if (v && typeof v === "object") {
      if (
        Object.getPrototypeOf(v) !== Object.prototype &&
        Object.getPrototypeOf(v) !== null
      )
        throw Error("unsupported IDB measurement value");
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k, metadata(x)]),
      );
    }
    if (
      typeof v === "bigint" ||
      typeof v === "function" ||
      typeof v === "symbol"
    )
      throw Error("unsupported IDB measurement value");
    return v;
  }
  const encoded = JSON.stringify(metadata(value));
  const bytes =
    encoded === undefined ? 0 : new TextEncoder().encode(encoded).byteLength;
  return { metadata: bytes, binary, total: bytes + binary };
}
export type Operation = "put" | "add" | "get" | "getAll" | "delete" | "clear";
export interface IdBRequestValue {
  operation: Operation;
  store: string;
  key?: unknown;
  value?: unknown;
}
const volume = () => ({ metadata: 0, binary: 0, keys: 0, total: 0 });
const storeStats = () => ({
  writes: volume(),
  reads: volume(),
  puts: 0,
  gets: 0,
  deletes: 0,
  clears: 0,
});
export function summarizeIdbRequests(requests: readonly IdBRequestValue[]) {
  const writes = volume(),
    reads = volume(),
    byStore: Record<string, ReturnType<typeof storeStats>> = {};
  for (const r of requests) {
    const s = (byStore[r.store] ??= storeStats());
    if (r.operation === "delete") {
      s.deletes++;
      continue;
    }
    if (r.operation === "clear") {
      s.clears++;
      continue;
    }
    const write = r.operation === "put" || r.operation === "add";
    const totals = write ? writes : reads,
      entry = write ? s.writes : s.reads;
    if (write) s.puts++;
    else s.gets++;
    const value = idbValueBytes(r.value),
      keys = idbValueBytes(r.key).total;
    for (const counter of [totals, entry]) {
      counter.metadata += value.metadata;
      counter.binary += value.binary;
      counter.keys += keys;
      counter.total += value.total + keys;
    }
  }
  return { writes, reads, byStore };
}
/** Captures references only in a separate I/O probe. Encoding runs after the
 * operation, so neither timing samples nor memory probes retain these values. */
export function observeIdbRequests() {
  const records: IdBRequestValue[] = [];
  const prototype = IDBObjectStore.prototype as unknown as Record<
    Operation,
    (...args: unknown[]) => IDBRequest<unknown>
  >;
  const originals = new Map<
    Operation,
    (...args: unknown[]) => IDBRequest<unknown>
  >();
  for (const operation of [
    "put",
    "add",
    "get",
    "getAll",
    "delete",
    "clear",
  ] as const) {
    const original = prototype[operation];
    originals.set(operation, original);
    prototype[operation] = function (this: IDBObjectStore, ...args: unknown[]) {
      const request = Reflect.apply(
        original,
        this,
        args,
      ) as IDBRequest<unknown>;
      const record: IdBRequestValue = { operation, store: this.name };
      if (operation === "put" || operation === "add") {
        record.value = args[0];
        record.key = args[1];
      } else if (operation === "get" || operation === "getAll") {
        // Range bounds are query metadata, never value payload bytes.
        const key = args[0];
        record.key =
          key instanceof IDBKeyRange
            ? {
                lower: key.lower,
                upper: key.upper,
                lowerOpen: key.lowerOpen,
                upperOpen: key.upperOpen,
              }
            : key;
        request.addEventListener(
          "success",
          () => {
            record.value = request.result;
          },
          { once: true },
        );
      }
      records.push(record);
      return request;
    };
  }
  return {
    stop() {
      for (const [name, fn] of originals) prototype[name] = fn;
      return summarizeIdbRequests(records);
    },
  };
}
