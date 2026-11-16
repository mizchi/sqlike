import type { DefinedCatalog } from "./defined-contract.ts";

export type DrizzleParameterCodec = "value" | "boolean" | "timestamp" | "timestamp_ms" | "json";
export type DrizzleConstantCell =
  | { readonly t: "null" }
  | { readonly t: "integer"; readonly v: string }
  | { readonly t: "real"; readonly v: number | "-0" }
  | { readonly t: "text"; readonly v: string }
  | { readonly t: "blob"; readonly v: number[] };
export type DrizzleParameter =
  | { readonly kind: "constant"; readonly value: DrizzleConstantCell }
  | { readonly kind: "placeholder"; readonly name: string; readonly codec: DrizzleParameterCodec };
export interface DrizzleBindingPlan {
  readonly format: "sqlike-drizzle-bindings@1";
  readonly schemaId: string;
  readonly programId: string;
  readonly queries: readonly {
    readonly name: string;
    readonly parameters: readonly DrizzleParameter[];
  }[];
  readonly sha256: string;
}
export interface CompiledDrizzleCatalog {
  readonly catalog: DefinedCatalog;
  readonly bindings: DrizzleBindingPlan;
}
