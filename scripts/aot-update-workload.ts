import type * as Aot from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import type * as Defined from "../_build/js/release/build/mizchi/sqlike/defined/defined.js";
import type { ResultCell } from "../src/contract.ts";
import { definedWasm } from "../adapters/defined-wasm.ts";

export interface UpdateFixture {
  artifact: string;
  schema: number[];
  statements: number[];
  seeds: string[];
  operations: { name: string; bindings: string[]; rejects?: boolean }[];
}
export interface UpdateEngine {
  name: string;
  url: string;
  wasm: boolean;
  defined: boolean;
}
export async function installUpdates(f: UpdateFixture, engines: UpdateEngine[]) {
  const check = (text: string) => {
    const result = JSON.parse(text);
    if (result.error) throw Error(result.error);
    return result;
  };
  const drivers: {
    name: string;
    run(name: string, iterations: number): number;
    verify(): {
      rows: ResultCell[][];
      operations: {
        name: string;
        calls: number;
        last: number;
        lastRows: ResultCell[][] | undefined;
      }[];
    };
  }[] = [];
  for (const engine of engines) {
    const raw = engine.wasm
      ? (
          await WebAssembly.instantiate(
            await (await fetch(engine.url)).arrayBuffer(),
            {},
            {
              builtins: ["js-string"],
              importedStringConstants: "_",
            },
          )
        ).instance.exports
      : await import(/* @vite-ignore */ engine.url);
    const a = raw as typeof Aot;
    const d = (engine.wasm ? definedWasm(raw) : raw) as typeof Defined;
    const db = engine.defined
      ? d.defined_open(Uint8Array.from(f.schema), Uint8Array.from(f.statements), new Uint8Array())
      : a.aot_open(f.artifact, "");
    check(engine.defined ? d.defined_info(db) : a.aot_info(db));
    const execute = (name: string, bindings = "[]") =>
      engine.defined ? d.defined_execute(db, name, bindings) : a.aot_execute(db, name, bindings);
    for (const seed of f.seeds) check(execute("seed", seed));
    // Warm primary and secondary indexes. Setup, load and first-read cost are excluded.
    check(execute("scan"));
    check(execute("range"));
    const operations = f.operations.map((operation) => ({
      ...operation,
      calls: 0,
      last: 0,
      lastRows: undefined as ResultCell[][] | undefined,
    }));
    drivers.push({
      name: engine.name,
      run(name: string, iterations: number) {
        const operation = operations.find((o) => o.name === name)!;
        let lastRows: ResultCell[][] | undefined;
        const start = performance.now();
        for (let i = 0; i < iterations; i++) {
          const result = JSON.parse(
            execute(name, operation.bindings[(operation.calls + i) % operation.bindings.length]),
          );
          if (!!result.error !== !!operation.rejects)
            throw Error(`${name}: unexpected ${JSON.stringify(result)}`);
          lastRows = result.rows;
        }
        const milliseconds = performance.now() - start;
        operation.calls += iterations;
        operation.last = (operation.calls - 1) % operation.bindings.length;
        operation.lastRows = lastRows;
        return milliseconds;
      },
      verify() {
        const rows = check(execute("scan")).rows as ResultCell[][];
        return {
          rows,
          operations: operations.map(({ name, calls, last, lastRows }) => ({
            name,
            calls,
            last,
            lastRows,
          })),
        };
      },
    });
  }
  return {
    run: (engine: string, name: string, iterations: number) =>
      drivers.find((d) => d.name === engine)!.run(name, iterations),
    verify: () => drivers.map((d) => ({ engine: d.name, ...d.verify() })),
  };
}
