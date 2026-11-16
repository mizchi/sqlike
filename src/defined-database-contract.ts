import type * as runtime from "../_build/js/release/build/mizchi/sqlike/defined/defined.js";
import type { DefinedCatalog } from "./defined-contract.ts";
import type { Value } from "./contract.ts";
import type { ImageStore, ImageStoreFactory } from "./persistence-contract.ts";

export type DefinedRuntime = typeof runtime;
export interface DefinedExecution {
  names: string[];
  rows: Value[][];
  readonly: boolean;
  changes: number;
}
export interface DefinedPreparedStatement {
  execute(params?: Value[]): Promise<DefinedExecution>;
  all(params?: Value[]): Promise<Value[][]>;
  get(params?: Value[]): Promise<Value[] | undefined>;
}
export interface DefinedConnection {
  execute(name: string, params?: Value[]): Promise<DefinedExecution>;
  prepare(name: string): DefinedPreparedStatement;
  inspect(name: string, params?: Value[]): Promise<DefinedExecution>;
  snapshot(): Promise<Uint8Array>;
  close(): Promise<void>;
}
export interface DefinedDatabaseFactory {
  memory(
    catalog: DefinedCatalog,
    options?: { image?: Uint8Array; runtime?: DefinedRuntime },
  ): Promise<DefinedConnection>;
  open(name: string, catalog: DefinedCatalog, provider?: ImageStoreFactory): Promise<DefinedConnection>;
  withStore(catalog: DefinedCatalog, store: ImageStore): Promise<DefinedConnection>;
}
