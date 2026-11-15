import type { DefinedRuntime } from "./defined-database-core.ts";
import { toBase64, fromBase64 } from "../src/aot-values.ts";
/** Adapts opaque Wasm GC Bytes through explicit base64 transfer exports.
 * Execution/definition validation stays inside the same MoonBit runtime. */
export function definedWasm(exports: WebAssembly.Exports): DefinedRuntime {
  const core = exports as unknown as DefinedRuntime;
  return {
    ...core,
    defined_open: (schema, statements, image) =>
      core.defined_open_base64(
        toBase64(schema),
        toBase64(statements),
        toBase64(image),
      ),
    binary_data: (result) => fromBase64(core.binary_data_base64(result)),
    defined_restore: (db, image) =>
      core.defined_restore_base64(db, toBase64(image)),
    defined_apply_delta: (db, image) =>
      core.defined_apply_delta_base64(db, toBase64(image)),
  };
}
