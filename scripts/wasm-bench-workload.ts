// Shared unchanged by Node and Chromium. Only the public string/JSON ABI is used.
import type * as AotRuntime from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import type * as SqlRuntime from "../_build/js/release/build/mizchi/sqlike/full/full.js";

export interface BenchEngines {
  js: { aot: typeof AotRuntime; dynamic: typeof SqlRuntime };
  wasm: { aot: typeof AotRuntime; dynamic: typeof SqlRuntime };
}
interface ReadCheck {
  name: string;
  sql: string;
  bindings: string;
  expected: unknown;
  write?: boolean;
}
export interface SpeedInput {
  schema: string;
  artifact: string;
  insertSQL: string;
  seeds: string[];
  warmup: number;
  runs: number;
  queries: (ReadCheck & { iterations: number; check?: ReadCheck })[];
  sqlite: string;
  ltxInput: string;
  ltx: string;
  checkpointIterations: number;
  checkpointWarmup: number;
}
export interface SpeedSample {
  name: string;
  engine: string;
  run: number;
  iterations: number;
  milliseconds: number;
}

export async function runBrowserSpeedBench(input: SpeedInput) {
  const load = async (path: string) =>
    (
      await WebAssembly.instantiate(
        await (await fetch(path)).arrayBuffer(),
        {},
        { builtins: ["js-string"], importedStringConstants: "_" },
      )
    ).instance.exports;
  return runSpeedBench(
    {
      js: {
        aot: await import(/* @vite-ignore */ `${location.origin}/aotJS`),
        dynamic: await import(/* @vite-ignore */ `${location.origin}/sqlJS`),
      },
      wasm: {
        aot: (await load("/aotWasm")) as unknown as typeof AotRuntime,
        dynamic: (await load("/sqlWasm")) as unknown as typeof SqlRuntime,
      },
    },
    input,
  );
}

export function runSpeedBench(engines: BenchEngines, input: SpeedInput) {
  function result<T>(text: string): T {
    const value = JSON.parse(text);
    if (value.error) throw Error(value.error);
    return value;
  }
  function equal(actual: unknown, expected: unknown, label: string) {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw Error(`result mismatch: ${label}`);
  }
  const candidates = Object.entries(engines).flatMap(([backend, runtime]) => {
    const aot = runtime.aot.aot_open(input.artifact, "");
    result(runtime.aot.aot_info(aot));
    const dynamic = runtime.dynamic.database_open();
    result(runtime.dynamic.database_exec(dynamic, input.schema, "[]", false));
    const callAot = (name: string, bindings: string) =>
      result<{ rows: unknown[][] }>(
        runtime.aot.aot_execute(aot, name, bindings),
      ).rows;
    const callDynamic = (sql: string, bindings: string) =>
      result<{ rows: unknown[][] }>(
        runtime.dynamic.database_query_values(dynamic, sql, bindings),
      ).rows;
    for (const bindings of input.seeds) {
      callAot("add", bindings);
      result(
        runtime.dynamic.database_exec(
          dynamic,
          input.insertSQL,
          bindings,
          false,
        ),
      );
    }
    return [
      // Keep export input independent of UPDATE count / header change counter.
      {
        name: `${backend}/aot`,
        call: (q: ReadCheck) => callAot(q.name, q.bindings),
        runtime: runtime.aot,
        aot: runtime.aot.aot_clone(aot),
      },
      {
        name: `${backend}/dynamic`,
        call: (q: ReadCheck) => {
          // query_values is read-only; execute writes through the writable ABI.
          if (q.write) {
            const response = result<{ rows: unknown[] }>(
              runtime.dynamic.database_exec(dynamic, q.sql, q.bindings, false),
            );
            return response.rows;
          }
          return callDynamic(q.sql, q.bindings);
        },
      },
    ];
  });
  const samples: SpeedSample[] = [],
    verified: string[] = [];
  function measure(
    name: string,
    iterations: number,
    warmup: number,
    actions: {
      engine: string;
      call: () => unknown[] | string;
      verify: () => void;
    }[],
  ) {
    for (const action of actions) {
      action.verify();
      verified.push(`${name}/${action.engine}`);
    }
    for (const action of actions)
      for (let i = 0; i < warmup; i++) action.call();
    for (let run = 0; run < input.runs; run++) {
      // Rotate first/last position and alternate direction to reduce order bias.
      const order = actions.map((_, i) => actions[(run + i) % actions.length]!);
      if (run % 2) order.reverse();
      for (const action of order) {
        let observed = 0;
        const start = performance.now();
        for (let i = 0; i < iterations; i++) observed += action.call().length;
        const milliseconds = performance.now() - start;
        if (!Number.isFinite(observed)) throw Error("invalid observation");
        samples.push({
          name,
          engine: action.engine,
          run,
          iterations,
          milliseconds,
        });
      }
    }
    for (const action of actions) action.verify();
  }
  for (const query of input.queries)
    measure(
      query.name,
      query.iterations,
      input.warmup,
      candidates.map((candidate) => ({
        engine: candidate.name,
        call: () => candidate.call(query),
        verify: () => {
          equal(
            candidate.call(query),
            query.expected,
            `${query.name}/${candidate.name}`,
          );
          if (query.check)
            equal(
              candidate.call(query.check),
              query.check.expected,
              `${query.name}/side effect/${candidate.name}`,
            );
        },
      })),
    );

  const portable = candidates.filter(
    (candidate) => candidate.runtime !== undefined,
  );
  for (const name of ["export-sqlite", "encode-ltx", "apply-ltx"] as const)
    measure(
      name,
      input.checkpointIterations,
      input.checkpointWarmup,
      portable.map((candidate) => {
        const engine = candidate.runtime!,
          db = candidate.aot!;
        const call = () => {
          if (name === "export-sqlite") {
            const output = engine.aot_export_sqlite(db);
            result(engine.sqlite_info(output));
            return engine.sqlite_data_base64(output);
          }
          const output =
            name === "encode-ltx"
              ? engine.encode_ltx_base64("", input.ltxInput, "1", "1", "0")
              : engine.apply_ltx_base64("", "0", input.ltx, 3);
          result(engine.ltx_info(output));
          return engine.ltx_data_base64(output);
        };
        return {
          engine: candidate.name.split("/")[0]!,
          call,
          verify: () =>
            equal(
              call(),
              name === "export-sqlite"
                ? input.sqlite
                : name === "encode-ltx"
                  ? input.ltx
                  : input.ltxInput,
              `${name}/${candidate.name}`,
            ),
        };
      }),
    );
  return { samples, verified };
}
