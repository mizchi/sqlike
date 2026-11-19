import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as binary from "../../_build/js/release/build/mizchi/sqlike/defined/defined.js";
import { buildDefinedCatalog } from "../../scripts/defined-compiler.ts";
import { createDefinedDatabase } from "../../adapters/defined-database-core.ts";
import { definedWasm } from "../../adapters/defined-wasm.ts";
import { NodeDatabase } from "../../adapters/node-database.ts";
import { nativeValues } from "./native-values.ts";
import { sqlikePaths } from "./sqlike-paths.ts";
import type { Value } from "../../src/contract.ts";

export async function sixPaths(schema: string[], queries: {name:string;sql:string;write?:boolean}[]) {
  const paths = (await sqlikePaths(schema,queries)).map(p=>({
    execute: async (name:string,params:Value[]=[])=>p.exec(name,params),
    close: async ()=>{},
  }));
  const source = buildDefinedCatalog({schema,queries:queries.map(({name,sql})=>({name,sql}))});
  const wasm = (await WebAssembly.instantiate(readFileSync("_build/wasm-gc/release/build/mizchi/sqlike/defined/defined.wasm"),{},
    {builtins:["js-string"],importedStringConstants:"_"})).instance.exports;
  for (const raw of [binary,definedWasm(wasm)]) {
    const db = await createDefinedDatabase(raw).memory(source);
    paths.push({execute:async (name:string,params:Value[]=[]) => (await db.execute(name,params)).rows,
      close:async()=>{await db.close();}});
  }
  return paths;
}

export async function compareSixQueries(queries:string[],schema:string[]=[],seed:string[]=[]) {
  const steps = [...seed,...queries].map((sql,i)=>({name:`q${i}`,sql,write:/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)}));
  const paths = await sixPaths(schema,steps);
  const native = new NodeDatabase(":memory:");
  try {
    schema.forEach(sql=>native.raw.exec(sql));
    for (const step of steps) {
      const expected = nativeValues(native,step.sql);
      for (const [i,path] of paths.entries()) assert.deepEqual(await path.execute(step.name),expected,`${i}: ${step.sql}`);
    }
  } finally {native.close();await Promise.all(paths.map(p=>p.close()));}
}
