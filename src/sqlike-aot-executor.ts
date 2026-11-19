import { aotBindings, aotValue } from "./aot-values.ts";
import type { Value, ResultCell } from "./contract.ts";
import type { NativeExecution } from "./sqlike-native-runtime.ts";

export interface AotExecutionRuntime<Database = unknown> {
  aot_open(program: string, image: ""): Database;
  aot_info(db: Database): string;
  aot_set_clock(db: Database, milliseconds: string): string;
  aot_execute(db: Database, name: string, bindings: string): string;
}
export interface AotExecutorOptions {
  clock?: () => number;
}
export interface AotExecutor {
  execute(name: string, params?: readonly Value[]): NativeExecution;
  close(): void;
}
const executionExports = [
  "aot_open",
  "aot_info",
  "aot_set_clock",
  "aot_execute",
] as const;
function validateRuntime(runtime: object) {
  for (const name of executionExports) {
    if (typeof (runtime as Record<string, unknown>)[name] !== "function")
      throw Error(`missing AOT execution export ${name}`);
  }
}
/** Engine-free, execute-only host. SQL statements retain the engine's atomic
 * write/rollback semantics; host transactions and persisted images are absent. */
export function openAotExecutor<D>(
  runtime: AotExecutionRuntime<D>,
  program: string,
  options: AotExecutorOptions = {},
): AotExecutor {
  validateRuntime(runtime);
  const checked = <T>(text: string): T => {
    const result = JSON.parse(text);
    if (result.error)
      throw Object.assign(Error(result.error), { code: result.code });
    return result as T;
  };
  let db: D | undefined = runtime.aot_open(program, ""),
    closed = false;
  checked(runtime.aot_info(db));
  return {
    execute(name, params = []) {
      if (closed) throw Error("Sqlike connection is closed");
      if (!Array.isArray(params)) throw Error("AOT bindings require an array");
      const milliseconds = (options.clock ?? Date.now)();
      if (!Number.isFinite(milliseconds))
        throw Error("clock must return finite milliseconds");
      checked(runtime.aot_set_clock(db!, String(milliseconds)));
      const result = checked<
        Omit<NativeExecution, "rows"> & { rows: ResultCell[][] }
      >(runtime.aot_execute(db!, name, aotBindings([...params])));
      return { ...result, rows: result.rows.map((row) => row.map(aotValue)) };
    },
    close() {
      closed = true;
      db = undefined;
    },
  };
}
export function aotExecutorWasm(
  exports: WebAssembly.Exports,
): AotExecutionRuntime {
  validateRuntime(exports);
  return Object.fromEntries(
    executionExports.map((name) => [name, exports[name]]),
  ) as unknown as AotExecutionRuntime;
}
