import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { brotliCompressSync, constants } from "node:zlib";
import { buildSqlikeRuntime } from "./build-sqlike-runtime.ts";
import { defineSqlike } from "../src/sqlike-features.ts";
import { minifyRuntime } from "./oxc-runtime.ts";
import { engineSourcePaths, sourceHashes, fileHash } from "./measurement-manifest.ts";

const out="generated/performance-next-size",before="generated/performance-next-before";
await mkdir(out,{recursive:true});
const artifacts:Record<string,string>={},results=[];
async function size(path:string) {
  const bytes=await readFile(path);artifacts[path]=fileHash(path);
  return {path,minifiedBytes:bytes.byteLength,brotliBytes:brotliCompressSync(bytes,{params:{[constants.BROTLI_PARAM_QUALITY]:11}}).byteLength};
}
for(const [name,old,current] of [
  ["SQL engine",`${before}/sqlike.js`,"_build/js/release/build/mizchi/sqlike/full/full.js"],
  ["native AOT engine",`${before}/aot-native.js`,"_build/js/release/build/mizchi/sqlike/experimental-aot-typed/experimental-aot-typed.js"],
]) {
  if(name==="SQL engine")assert.doesNotMatch(await readFile(current!,"utf8"),/function [^\n]*(aot__native__values|aot__native__execute|typed__bindings|native__result)\(/);
  const pair=[];
  for(const [phase,path] of [["before",old],["after",current]]) {
    const exports=Object.keys(await import(pathToFileURL(resolve(path!)).href)).sort();
    const destination=join(out,`${name!.replaceAll(" ","-")}-${phase}.js`);
    await writeFile(destination,await minifyRuntime(path!,exports));artifacts[path!]=fileHash(path!);
    pair.push({phase,exports,...await size(destination)});
  }
  if(name==="SQL engine")assert.deepEqual(pair[0]!.exports,pair[1]!.exports);
  results.push({name,scope:name==="SQL engine"?"identical exports":"native AOT API grows from JSON bindings to typed bindings/execute plus connection-state copy",pair});
}
for(const mode of ["aot","defined"] as const)for(const enabled of [false,true]) {
  const label=`${mode}/${enabled}`;
  results.push({name:`JSON table profile ${label}`,scope:"identical manual-profile exports; core function groups retained; only jsonTableFunctions toggled",
    pair:[{phase:"before",...await size(`${before}/json-table-profile/${label}/runtime.js`)},
      {phase:"after",...await size(`generated/json-table/${label}/runtime.js`)}]});
}
const catalog=JSON.parse(await readFile("examples/notes/catalog.json","utf8"));
const selected=await buildSqlikeRuntime(defineSqlike({mode:"aot",features:[]}),{outDir:join(out,"notes"),catalog,nativeResults:true});
results.push({name:"notes-selected native AOT",scope:"current catalog-selected engine; standalone, no host adapter/Program",pair:[{phase:"after",...await size(join(selected.directory,"runtime.js"))}]});

const audit=JSON.parse(await readFile("generated/npm/audit.json","utf8"));
const chunks=audit.packages.find((p:{name:string})=>p.name==="@mizchi/sqlike").chunks;
for(const entry of ["index.js","aot.js","aot-core.js"]) {
  const seen=new Set<string>();
  function walk(file:string) {
    if(seen.has(file)||!chunks[file])return;seen.add(file);
    for(const child of chunks[file].imports)walk(chunks[child]?child:posix.normalize(posix.join(posix.dirname(file),child)));
  }
  walk(entry);let minifiedBytes=0,brotliBytes=0;
  for(const file of seen){const s=await size(`npm/sqlike/dist/${file}`);minifiedBytes+=s.minifiedBytes;brotliBytes+=s.brotliBytes;}
  results.push({name:`npm ${entry}`,scope:"current transitive ESM chunk byte sum, independent Brotli quality 11 per asset; no Wasm or Program",pair:[{phase:"after",files:[...seen].sort(),minifiedBytes,brotliBytes}]});
}
await writeFile("measurements/performance-next-size-current.json",JSON.stringify({
  format:"sqlike-performance-next-size@1",measuredAt:new Date().toISOString(),node:process.version,
  scope:"Before artifacts frozen immediately before point projection / streaming JSON / native AOT binding work; Oxc minify and Brotli quality 11; core/node/host comparisons have different export sets as specified per row. No additive feature-size claim.",
  results,artifacts,sources:sourceHashes([...engineSourcePaths(),"scripts/measure-performance-next.ts","scripts/build-sqlike-runtime.ts","scripts/oxc-runtime.ts","scripts/sqlike-runtime-declarations.ts","src/sqlike-features.ts","src/sqlike-native-runtime.ts","npm/sqlike/aot.ts","npm/sqlike/aot-core.ts","npm/sqlike/package.json","scripts/build-npm-packages.ts"]),
},null,2)+"\n");
console.table(results.flatMap(r=>r.pair.map(({phase,minifiedBytes,brotliBytes})=>({name:r.name,phase,minifiedBytes,brotliBytes}))));
