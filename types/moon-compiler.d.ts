declare module "*compiler/compiler.js" {
  export function compile_program(request: string): string;
  export function program_runtime_requirements(artifact: string): string;
  export interface BinaryCatalog {
    readonly __binaryCatalog: unique symbol;
  }
  export function pack_program_binary(artifact: string): BinaryCatalog;
  export function binary_catalog_schema(catalog: BinaryCatalog): Uint8Array;
  export function binary_catalog_statements(catalog: BinaryCatalog): Uint8Array;
  export function binary_catalog_storage(catalog: BinaryCatalog): Uint8Array;
  export function binary_catalog_info(catalog: BinaryCatalog): string;
}
