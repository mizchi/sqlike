/** Connection-owned SQL-text LRU. The payload budget counts UTF-16 SQL bytes;
 * opaque engine AST/metadata and Map overhead are additional allocations. */
export function createSqlStatementCache<Handle>(
  options: { capacity: number; maxSqlBytes?: number } | undefined,
  prepare: (sql: string) => Handle,
) {
  if (options !== undefined && (options === null || typeof options !== "object" || Array.isArray(options)))
    throw Error("invalid SQL statement cache bounds");
  const capacity = options === undefined ? 0 : options.capacity;
  const maxSqlBytes = options?.maxSqlBytes === undefined ? 65536 : options.maxSqlBytes;
  if (!Number.isSafeInteger(capacity) || capacity < 0 || capacity > 256 ||
      !Number.isSafeInteger(maxSqlBytes) || maxSqlBytes < 1 || maxSqlBytes > 4194304)
    throw Error("invalid SQL statement cache bounds");
  if (!capacity) return undefined;
  const entries = new Map<string, { sql: string; handle: Handle; bytes: number }>();
  let retainedSqlBytes = 0;
  return {
    get(sql: string) {
      const bytes = sql.length * 2;
      if (bytes > maxSqlBytes) return undefined;
      let entry = entries.get(sql);
      if (entry) {
        entries.delete(sql);
      } else {
        const handle = prepare(sql);
        while (entries.size >= capacity || retainedSqlBytes + bytes > maxSqlBytes) {
          const key = entries.keys().next().value!;
          retainedSqlBytes -= entries.get(key)!.bytes;
          entries.delete(key);
        }
        entry = { sql, handle, bytes };
        retainedSqlBytes += bytes;
      }
      entries.set(entry.sql, entry);
      return entry;
    },
    clear() { entries.clear(); retainedSqlBytes = 0; },
  };
}
