declare module "*experimental-aot-typed/experimental-aot-typed.js" {
  export interface NativeAotDatabase { readonly __nativeAotDatabase: unique symbol }
  export interface NativeAotQuery { readonly __nativeAotQuery: unique symbol }
  export type NativeCell = bigint | number | string | null | Uint8Array;
  export interface NativeExecution { names: string[]; rows: NativeCell[][]; readonly: boolean; changes: number }
  export function open(program: string, image: string): NativeAotDatabase;
  export function info(db: NativeAotDatabase): string;
  export function query_info(db: NativeAotDatabase, name: string): string;
  export function execute(db: NativeAotDatabase, name: string, bindings: string): string;
  export function prepare(db: NativeAotDatabase, name: string): NativeAotQuery;
  export function values(query: NativeAotQuery, bindings: string): NativeCell[][];
  export function values_typed(query: NativeAotQuery, bindings: readonly NativeCell[]): NativeCell[][];
  export function execute_typed(db: NativeAotDatabase, name: string, bindings: readonly NativeCell[]): NativeExecution;
  export function copy_connection_state(target: NativeAotDatabase, source: NativeAotDatabase): string;
  export function finalize(query: NativeAotQuery): string;
  export function restore(db: NativeAotDatabase, image: string): string;
  export function snapshot(db: NativeAotDatabase): string;
  export function set_clock(db: NativeAotDatabase, millis: string): string;
  export function clone(db: NativeAotDatabase): NativeAotDatabase;
}
