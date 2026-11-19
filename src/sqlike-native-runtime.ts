import type { Value } from "./contract.ts";

export interface NativeExecution {
  names: string[];
  rows: Value[][];
  readonly: boolean;
  changes: number;
}
/** JS-only native ABI. The injected runtime owns every opaque handle. */
export interface NativeAotRuntime<Database = unknown, Query = unknown> {
  open(program: string, image: string): Database;
  info(db: Database): string;
  query_info(db: Database, name: string): string;
  execute_typed(db: Database, name: string, params: readonly Value[]): NativeExecution;
  prepare(db: Database, name: string): Query;
  values_typed(query: Query, params: readonly Value[]): Value[][];
  finalize(query: Query): string;
  restore(db: Database, image: string): string;
  snapshot(db: Database): string;
  set_clock(db: Database, milliseconds: string): string;
  clone(db: Database): Database;
  copy_connection_state(target: Database, source: Database): string;
}
export interface NativeCompiledOptions {
  /** Named SELECT cache only; explicit prepare() handles have caller-owned lifetimes. Default 64, maximum 256. */
  statementCacheCapacity?: number;
  clock?: () => number;
}
export interface NativeCompiledStatement {
  readonly names: readonly string[];
  values(params?: readonly Value[]): Value[][];
  get(params?: readonly Value[]): Value[] | undefined;
  finalize(): void;
}
export interface NativeCompiledConnection {
  prepare(name: string): NativeCompiledStatement;
  values(name: string, params?: readonly Value[]): Value[][];
  execute(name: string, params?: readonly Value[]): NativeExecution;
  dump(): string;
  restore(image: string): void;
  transaction<T>(body: () => T): T;
  close(): void;
}
export function openNativeCompiled<Database, Query>(
  runtime: NativeAotRuntime<Database, Query>, artifact: string, image = "", options: NativeCompiledOptions = {},
): NativeCompiledConnection {
  const capacity = options.statementCacheCapacity ?? 64;
  if (!Number.isInteger(capacity) || capacity < 0 || capacity > 256)
    throw Error("statementCacheCapacity must be an integer from 0 to 256");
  const checked = <T>(text: string): T => {
    const result = JSON.parse(text);
    if (result.error) throw Object.assign(Error(result.error), { code: result.code });
    return result as T;
  };
  let db: Database | undefined = runtime.open(artifact, image), closed = false, active = false;
  const alive = () => { if (closed) throw Error("Sqlike connection is closed"); };
  const current = (): Database => { alive(); return db!; };
  checked(runtime.info(current()));
  const tick = () => {
    alive();
    const now = (options.clock ?? Date.now)();
    if (!Number.isFinite(now)) throw Error("clock must return finite milliseconds");
    checked(runtime.set_clock(current(), String(now)));
  };
  type OwnedStatement = NativeCompiledStatement & { invalidate(): void };
  const statements = new Set<OwnedStatement>();
  const cache = new Map<string, OwnedStatement>();
  const prepare = (name: string): OwnedStatement => {
    alive();
    const info = checked<{ names: string[]; readonly: boolean }>(runtime.query_info(current(), name));
    if (!info.readonly) throw Error("native prepared values accept SELECT only");
    let query: Query | undefined = runtime.prepare(current(), name), finalized = false;
    const release = () => {
      if (query !== undefined) {
        const owned = query; query = undefined;
        checked(runtime.finalize(owned));
      }
    };
    const statement: OwnedStatement = {
      names: Object.freeze([...info.names]),
      values(params = []) {
        alive();
        if (finalized) throw Error("statement is finalized");
        tick();
        query ??= runtime.prepare(current(), name);
        return runtime.values_typed(query, params);
      },
      get(params = []) { return statement.values(params)[0]; },
      invalidate: release,
      finalize() {
        if (finalized) return;
        finalized = true;
        try { release(); }
        finally { statements.delete(statement); }
      },
    };
    statements.add(statement);
    return statement;
  };
  const invalidate = () => { for (const statement of statements) statement.invalidate(); };
  return {
    prepare,
    values(name, params = []) {
      alive();
      if (capacity === 0) {
        const statement = prepare(name);
        try { return statement.values(params); }
        finally { statement.finalize(); }
      }
      let statement = cache.get(name);
      if (statement) cache.delete(name);
      else statement = prepare(name);
      cache.set(name, statement);
      if (cache.size > capacity) {
        const [name, oldest] = cache.entries().next().value!;
        cache.delete(name); oldest.finalize();
      }
      return statement.values(params);
    },
    execute(name, params = []) {
      tick();
      return runtime.execute_typed(current(), name, params);
    },
    dump() { return runtime.snapshot(current()); },
    restore(image) { checked(runtime.restore(current(), image)); },
    transaction<T>(body: () => T): T {
      alive();
      if (active) throw Error("nested Sqlike transaction");
      if (body.constructor.name === "AsyncFunction") throw Error("transaction must be synchronous");
      const before = runtime.clone(current()); checked(runtime.info(before));
      active = true;
      try {
        const result = body();
        if (result && typeof (result as { then?: unknown }).then === "function")
          throw Error("transaction must be synchronous");
        checked(runtime.info(current()));
        return result;
      } catch (error) {
        checked(runtime.copy_connection_state(before, current()));
        invalidate();
        db = before;
        throw error;
      } finally { active = false; }
    },
    close() {
      if (closed) return;
      if (active) throw Error("cannot close an active transaction");
      for (const statement of statements) statement.finalize();
      cache.clear(); closed = true; db = undefined;
    },
  };
}
