import * as runtime from "../../generated/npm-runtimes/aot/runtime.js";
import { openPortableCompiled } from "../../src/sqlike-portable-aot.ts";
import type { NativeCompiledOptions } from "../../src/sqlike-native-runtime.ts";
export type {
  NativeCompiledConnection,
  NativeCompiledStatement,
  NativeCompiledOptions,
  NativeExecution,
} from "../../src/sqlike-native-runtime.ts";
export type { Value } from "../../src/contract.ts";
/** Fixed-schema, named SQL queries; JS-native bindings and positional results. */
export function openAotDatabase(
  artifact: string,
  image = "",
  options?: NativeCompiledOptions,
) {
  return openPortableCompiled(runtime, artifact, image, options);
}
