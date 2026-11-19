import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cpus } from "node:os";
import { NodeDatabase } from "../adapters/node-database.ts";
import { aotBindings, aotValue } from "../src/aot-values.ts";
import { engineSourcePaths, sourceHashes, fileHash } from "./measurement-manifest.ts";
import type { Value } from "../src/contract.ts";
type Runtime = typeof import("../_build/js/release/build/mizchi/sqlike/full/full.js");
const args=process.argv.slice(2);
for(const arg of args)assert.match(arg,/^(--before-dir=.+|--output=.+)$/);
const before=args.find(a=>a.startsWith("--before-dir="))?.slice(13);
const output=args.find(a=>a.startsWith("--output="))?.slice(9)??"measurements/generated-columns-speed-current.json";
const files = [...(before?[["before/js",`${before}/sqlike.js`],["before/wasm",`${before}/sqlike.wasm`]]:[]),
  ["js","_build/js/release/build/mizchi/sqlike/full/full.js"],
  ["wasm","_build/wasm-gc/release/build/mizchi/sqlike/full/full.wasm"]] as const;
const runtimes: {engine:string;api:Runtime}[] = [];
for(const [engine,path] of files) {
  const api = path.endsWith(".wasm") ? (await WebAssembly.instantiate(readFileSync(path),{},
    {builtins:["js-string"],importedStringConstants:"_"})).instance.exports
    : await import(pathToFileURL(resolve(path)).href);
  runtimes.push({engine,api:api as unknown as Runtime});
}
const checked=(text:string)=>{const value=JSON.parse(text);if(value.error)throw Error(value.error);return value;};
function measure(run:()=>Value[][],expected:Value[][]) {
  assert.deepEqual(run(),expected);
  const samples=[];
  for(let sample=0;sample<3;sample++) {
    let iterations=0,last:Value[][]=[];const start=performance.now();
    do {last=run();iterations++;}while(performance.now()-start<20 && iterations<1000);
    const elapsedMs=performance.now()-start;assert.deepEqual(last,expected);
    samples.push({iterations,elapsedMs,microseconds:elapsedMs*1000/iterations});
  }
  return {samples,medianMicroseconds:samples.map(s=>s.microseconds).sort((a,b)=>a-b)[1]!};
}
const results=[],fixtures=[];
for(const rows of [5000,100000])for(const generated of [false,true]) {
  const schema=`CREATE TABLE t(id INTEGER PRIMARY KEY,n INT${generated?",v INT AS(n*2)":""})`;
  const native=new NodeDatabase(":memory:");
  try {
    native.raw.exec(schema);native.transaction(()=>{const add=native.raw.prepare("INSERT INTO t VALUES(?,?)");for(let i=1;i<=rows;i++)add.run(i,i);});
    const image=Buffer.from(native.raw.serialize()).toString("base64");
    fixtures.push({rows,generated,schema,sqliteBytes:native.raw.serialize().byteLength});
    const value=generated?"v":"n*2";
    const queries=[{name:"point",sql:`SELECT ${value} FROM t WHERE id=?`,params:[BigInt(rows/2)]},
      {name:"aggregate",sql:`SELECT sum(${value}),count(*) FROM t`,params:[]},
      {name:"update",sql:"UPDATE t SET n=? WHERE id=?",params:[7n,BigInt(rows/2)]}];
    const handles=runtimes.map(({engine,api})=>{const db=api.database_open();checked(api.database_import_sqlite_base64(db,image));return{engine,api,db};});
    for(const query of queries) {
      const stmt=native.raw.prepare(query.sql);stmt.setReadBigInts(true);stmt.setReturnArrays(true);
      const run=()=>stmt.all(...query.params) as unknown as Value[][];
      const expected=run();
      results.push({rows,generated,query:query.name,engine:"sqlite/prepared",...measure(run,expected)});
      for(const {engine,api,db} of handles) {
        const prepared=api.database_prepare(db,query.sql),encoded=aotBindings(query.params);
        const execute=():Value[][]=>checked(api.database_prepared_exec(prepared,encoded,false,true)).rows.map((row:any[])=>row.map(aotValue));
        results.push({rows,generated,query:query.name,engine,...measure(execute,expected)});
        if(query.name==="update")assert.deepEqual(checked(api.database_query_values(db,`SELECT ${value} FROM t WHERE id=${rows/2}`,"[]")).rows
          .map((row:any[])=>row.map(aotValue)),[[14n]]);
      }
    }
    (globalThis as {gc?:()=>void}).gc?.();
  }finally{native.close();}
}
writeFileSync(output,JSON.stringify({
  format:"sqlike-generated-columns-speed@1",measuredAt:new Date().toISOString(),node:process.version,cpu:cpus()[0]?.model,
  scope:"Node in-memory prepared SQL; base expression n*2 versus cached VIRTUAL v; point read, whole-table aggregate and repeated same-value point update; three samples targeting 20 ms, maximum 1000 iterations; setup/import/preparation/verification excluded; no persistence or RPC; VIRTUAL caches are warm",
  fixtures,results,artifacts:Object.fromEntries(files.map(([,path])=>[path,fileHash(path)])),
  sources:sourceHashes([...engineSourcePaths(),"scripts/bench-generated-columns.ts"]),
},null,2)+"\n");
console.table(results.map(({rows,generated,query,engine,medianMicroseconds})=>({rows,generated,query,engine,microseconds:medianMicroseconds.toFixed(2)})));
