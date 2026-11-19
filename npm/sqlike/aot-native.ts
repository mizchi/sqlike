import * as runtime from "../../generated/npm-runtimes/aot-native/runtime.js";
import { openNativeCompiled } from "../../src/sqlike-native-runtime.ts";
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
  return openNativeCompiled(runtime, artifact, image, options);
}
