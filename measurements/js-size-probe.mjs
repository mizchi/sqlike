import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {brotliCompressSync,gzipSync,constants} from 'node:zlib';
const root=process.cwd(), require=createRequire(path.join(root,'package.json'));
const {build}=await import(pathToFileURL(require.resolve('vite')));
const {parseAst}=await import(pathToFileURL(path.join(root,'node_modules/.pnpm/rolldown@1.2.19/node_modules/rolldown/dist/parse-ast-index.mjs')));
const entry=path.join(root,'_build/js/release/build/mizchi/litestream-example/runtime/runtime.js');
const source=fs.readFileSync(entry,'utf8'), ast=parseAst(source);
const groups={datetime:['_M0FP26mizchi6sqlike14datetime__call'],sqlJson:['_M0FP26mizchi6sqlike10json__call'],windows:['_M0FP26mizchi6sqlike16compute__windows']};
const variants=[['baseline',[]],...Object.entries(groups),['all-three',Object.values(groups).flat()]];
const results=[];
for(const [name,names] of variants){
 const replacements=ast.body.filter(n=>n.type==='FunctionDeclaration'&&names.includes(n.id.name));
 if(replacements.length!==names.length)throw Error('missing root '+name);
 let code=source;
 for(const n of replacements.sort((a,b)=>b.start-a.start))code=code.slice(0,n.body.start)+'{ throw Error("size-probe-disabled"); }'+code.slice(n.body.end);
 const output=await build({configFile:false,publicDir:false,logLevel:'silent',plugins:[{name:'transient-root-ablation',transform(_code,id){if(id===entry)return {code,map:null};}}],build:{write:false,minify:true,target:'esnext',lib:{entry,formats:['es']}}});
 const chunk=(Array.isArray(output)?output[0]:output).output.find(c=>c.type==='chunk');
 const bytes=Buffer.from(chunk.code);
 const sizes={raw:bytes.length,gzip:gzipSync(bytes,{level:9}).length,brotli:brotliCompressSync(bytes,{params:{[constants.BROTLI_PARAM_QUALITY]:11}}).length};
 const item={name,roots:names,...sizes,removed:results[0]?Object.fromEntries(Object.keys(sizes).map(k=>[k,results[0][k]-sizes[k]])):undefined};results.push(item);console.log(JSON.stringify(item));
}
fs.writeFileSync('/tmp/browser-litestream-js-probes.json',JSON.stringify({method:'Transient generated-JS root ablation followed by dead-code elimination; invalid runtimes used only to measure reachable code, not production-compatible profiles; deltas are not additive.',results},null,2));
