import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cpus } from "node:os";
import { NodeDatabase } from "../adapters/node-database.ts";
import { aotBindings, aotValue } from "../src/aot-values.ts";
import { engineSourcePaths, sourceHashes, fileHash } from "./measurement-manifest.ts";
import type { Value } from "../src/contract.ts";
type Runtime=typeof import("../_build/js/release/build/mizchi/sqlike/full/full.js");
const args=process.argv.slice(2);
for(const arg of args)assert.match(arg,/^(--before-dir=.+|--output=.+)$/);
const before=args.find(a=>a.startsWith("--before-dir="))?.slice(13);
const output=args.find(a=>a.startsWith("--output="))?.slice(9)??"measurements/json-table-speed-current.json";
const files=[...(before?[["before/js",`${before}/sqlike.js`],["before/wasm",`${before}/sqlike.wasm`]]:[]),
  ["js","_build/js/release/build/mizchi/sqlike/full/full.js"],
  ["wasm","_build/wasm-gc/release/build/mizchi/sqlike/full/full.wasm"]] as const;
const runtimes:{engine:string;api:Runtime}[]=[];
for(const [engine,path] of files) {
  const api=path.endsWith(".wasm")?(await WebAssembly.instantiate(readFileSync(path),{},
    {builtins:["js-string"],importedStringConstants:"_"})).instance.exports:await import(pathToFileURL(resolve(path)).href);
  runtimes.push({engine,api:api as unknown as Runtime});
}
const checked=(text:string)=>{const result=JSON.parse(text);if(result.error)throw Error(result.error);return result;};
function measure(run:()=>Value[][],expected:Value[][]) {
  assert.deepEqual(run(),expected);
  const samples=Array.from({length:3},()=>{const start=performance.now();const actual=run();
    const milliseconds=performance.now()-start;assert.deepEqual(actual,expected);return milliseconds;});
  return{samples,medianMilliseconds:[...samples].sort((a,b)=>a-b)[1]!};
}
const results=[],fixtures=[];
for(const outputRows of [5000,100000])for(const fn of ["json_each","json_tree"]) {
  const elements=fn==="json_tree"?outputRows-1:outputRows;
  const input=JSON.stringify(Array.from({length:elements},(_,i)=>i));
  const sql=`SELECT sum(atom),count(*) FROM ${fn}(?)`;
  fixtures.push({outputRows,fn,elements,inputBytes:Buffer.byteLength(input),sql});
  const native=new NodeDatabase(":memory:");
  try {
    const statement=native.raw.prepare(sql);statement.setReadBigInts(true);statement.setReturnArrays(true);
    const run=()=>statement.all(input) as unknown as Value[][];
    const expected=run();assert.deepEqual(expected,[[BigInt(elements)*(BigInt(elements)-1n)/2n,BigInt(outputRows)]]);
    results.push({outputRows,fn,engine:"sqlite/prepared",...measure(run,expected)});
    for(const {engine,api} of runtimes) {
      const db=api.database_open(),query=api.database_prepare(db,sql),encoded=aotBindings([input]);
      const execute=():Value[][]=>checked(api.database_prepared_exec(query,encoded,true,true)).rows.map((row:any[])=>row.map(aotValue));
      results.push({outputRows,fn,engine,...measure(execute,expected)});
      (globalThis as {gc?:()=>void}).gc?.();
    }
  }finally{native.close();}
}
writeFileSync(output,JSON.stringify({
  format:"sqlike-json-table-speed@1",measuredAt:new Date().toISOString(),node:process.version,cpu:cpus()[0]?.model,
  scope:"Node in-memory prepared SQL; flat integer JSON arrays; 5000/100000 expanded rows; SUM(atom)+COUNT returns one result row; JSON parse/expansion/aggregate and host bindings/results included; setup/preparation excluded; warmup then three single-statement samples; no persistence/RPC or memory measurement; json_tree output includes its root",
  fixtures,results,artifacts:Object.fromEntries(files.map(([,path])=>[path,fileHash(path)])),
  sources:sourceHashes([...engineSourcePaths(),"scripts/bench-json-table.ts"]),
},null,2)+"\n");
console.table(results.map(({outputRows,fn,engine,medianMilliseconds})=>({outputRows,fn,engine,milliseconds:medianMilliseconds.toFixed(2)})));
