import type * as runtime from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
export type RowOperation = "clone" | "update" | "delete";
export interface RowFixture {
  artifact: string;
  image: string;
  bindings: Record<"point" | "update" | "delete", string>;
  expected: Record<"before" | "update" | "delete" | "cold", string>;
}
declare global {
  interface Window {
    rowStore: {
      run(kind: RowOperation, iterations: number): number;
      verify(): Promise<string[]>;
      hold(count: number): Promise<void>;
      verifyHeld(): Promise<void>;
      clear(): void;
    };
  }
}
export async function setup({ fixture: f, index, wasm }: { fixture: RowFixture; index: number; wasm: boolean }) {
  type Core = typeof runtime;
  const r: Core = wasm
    ? (await WebAssembly.instantiate(await (await fetch(`/${index}`)).arrayBuffer(), {}, { builtins: ["js-string"], importedStringConstants: "_" })).instance.exports as unknown as Core
    : await import(`/${index}`) as Core;
  const parse = (text: string) => { const v = JSON.parse(text); if (v.error) throw Error(v.error); return v; };
  const base = r.aot_open(f.artifact, f.image);
  parse(r.aot_info(base));
  parse(r.aot_execute(base, "point", f.bindings.point)); // Warm the base PK index.
  const bindings = f.bindings, expected = f.expected;
  let last: ReturnType<Core["aot_open"]> | undefined;
  let lastKind: RowOperation = "clone";
  let held: ReturnType<Core["aot_open"]>[] = [];
  const call = (kind: "clone" | "update" | "delete") => {
    const db = r.aot_clone(base);
    if (kind !== "clone") parse(r.aot_execute(db, kind, bindings[kind]));
    last = db;
    lastKind = kind;
    return db;
  };
  const digest = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), v => v.toString(16).padStart(2, "0")).join("");
  const scan = (db: ReturnType<Core["aot_open"]>, name = "scan") => JSON.stringify(parse(r.aot_execute(db, name, "[]")).rows);
  window.rowStore = {
    run(kind: "clone" | "update" | "delete", iterations: number) {
      const start = performance.now();
      for (let i = 0; i < iterations; i++) call(kind);
      return performance.now() - start;
    },
    async verify() {
      // Read the candidate produced by the timed loop, keeping allocations
      // observable to the JIT as well as checking the timed mutation.
      if (last) {
        const wanted = lastKind === "clone" ? expected.before : expected[lastKind];
        if (await digest(scan(last)) !== wanted) throw Error("timed candidate mismatch");
      }
      const images: string[] = [];
      for (const kind of ["clone", "update", "delete"] as const) {
        const db = call(kind), wanted = kind === "clone" ? expected.before : expected[kind];
        if (await digest(scan(db)) !== wanted || await digest(scan(db, "cold")) !== expected.cold)
          throw Error(`candidate mismatch: ${kind}`);
        const image = r.aot_export_sqlite(db); parse(r.sqlite_info(image));
        images.push(r.sqlite_data_base64(image));
      }
      if (await digest(scan(base)) !== expected.before) throw Error("base mutated");
      last = undefined;
      return images;
    },
    async hold(count: number) {
      for (let i = 0; i < count; i++) { held.push(call("update")); await new Promise(resolve => setTimeout(resolve, 0)); }
    },
    async verifyHeld() {
      for (const db of held) if (await digest(scan(db)) !== expected.update) throw Error("retained version mutated");
    },
    clear() { last = undefined; held = []; },
  };
}
