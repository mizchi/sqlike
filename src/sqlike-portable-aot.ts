import { aotBindings, aotValue } from "./aot-values.ts";
import type { Value, ResultCell } from "./contract.ts";
import {
  openNativeCompiled,
  type NativeAotRuntime,
  type NativeCompiledOptions,
  type NativeExecution,
} from "./sqlike-native-runtime.ts";
export interface PortableAotRuntime<Database = unknown, Query = unknown> {
  aot_open(program: string, image: string): Database;
  aot_info(db: Database): string;
  aot_query_info(db: Database, name: string): string;
  aot_execute(db: Database, name: string, bindings: string): string;
  aot_prepare_values(db: Database, name: string): Query;
  aot_prepared_execute(query: Query, bindings: string): string;
  aot_finalize_values(query: Query): string;
  aot_restore(db: Database, image: string): string;
  aot_dump(db: Database): string;
  aot_clone(db: Database): Database;
  aot_copy_connection_state(target: Database, source: Database): string;
  aot_set_clock(db: Database, milliseconds: string): string;
}
/** Portable string/opaque-handle ABI shared by JS and Wasm GC. Host API has the
 * same ownership/lifetime contract as native JS; per-call Cell JSON remains. */
export function openPortableCompiled<D, Q>(
  runtime: PortableAotRuntime<D, Q>,
  program: string,
  image = "",
  options: NativeCompiledOptions = {},
) {
  aotWasm(runtime as unknown as WebAssembly.Exports);
  const decode = (text: string): NativeExecution => {
    const r = JSON.parse(text);
    if (r.error) throw Object.assign(Error(r.error), { code: r.code });
    return {
      ...r,
      rows: (r.rows as ResultCell[][]).map((row) => row.map(aotValue)),
    };
  };
  const native: NativeAotRuntime<D, Q> = {
    open: runtime.aot_open,
    info: runtime.aot_info,
    query_info: runtime.aot_query_info,
    prepare: runtime.aot_prepare_values,
    finalize: runtime.aot_finalize_values,
    values_typed: (q, params: readonly Value[]) =>
      decode(runtime.aot_prepared_execute(q, aotBindings([...params]))).rows,
    execute_typed: (db, name, params: readonly Value[]) =>
      decode(runtime.aot_execute(db, name, aotBindings([...params]))),
    restore: runtime.aot_restore,
    snapshot: runtime.aot_dump,
    clone: runtime.aot_clone,
    copy_connection_state: runtime.aot_copy_connection_state,
    set_clock: runtime.aot_set_clock,
  };
  return openNativeCompiled(native, program, image, options);
}
export function aotWasm(exports: WebAssembly.Exports): PortableAotRuntime {
  const names = [
    "aot_open",
    "aot_info",
    "aot_query_info",
    "aot_execute",
    "aot_prepare_values",
    "aot_prepared_execute",
    "aot_finalize_values",
    "aot_restore",
    "aot_dump",
    "aot_clone",
    "aot_copy_connection_state",
    "aot_set_clock",
  ] as const;
  const result = Object.fromEntries(
    names.map((name) => {
      const fn = exports[name];
      if (typeof fn !== "function")
        throw Error(`missing portable AOT export ${name}`);
      return [name, fn];
    }),
  );
  return result as unknown as PortableAotRuntime;
}
