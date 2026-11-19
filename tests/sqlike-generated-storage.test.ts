import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as aot from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import * as sql from "../_build/js/release/build/mizchi/sqlike/full/full.js";
import * as ltx from "../_build/js/release/build/mizchi/litestream/litestream.js";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import { aotBindings, aotValue } from "../src/aot-values.ts";
import { applyLtx } from "../src/ltx.ts";

test("VIRTUAL columns survive SQLite export, physical import and LTX with ordinary and WITHOUT ROWID layouts", async () => {
  const wasm = (await WebAssembly.instantiate(readFileSync("_build/wasm-gc/release/build/mizchi/litestream-example/runtime/runtime.wasm"), {},
    {builtins:["js-string"],importedStringConstants:"_"})).instance.exports as unknown as typeof aot;
  const sqlWasm = (await WebAssembly.instantiate(readFileSync("_build/wasm-gc/release/build/mizchi/sqlike/full/full.wasm"), {},
    {builtins:["js-string"],importedStringConstants:"_"})).instance.exports as unknown as typeof sql;
  const dir = mkdtempSync(join(tmpdir(), "sqlike-generated-storage-"));
  const checked=(text:string)=>{const result=JSON.parse(text);if(result.error)throw Error(result.error);return result;};
  try {
    for (const suffix of ["", " WITHOUT ROWID"]) {
      const source = {
        schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT AS(upper(raw)),raw TEXT,n INT,twice INT AS(n*2))"+suffix,
          "CREATE INDEX by_v ON t(v COLLATE NOCASE)", "CREATE UNIQUE INDEX by_twice ON t(twice) WHERE twice>10"],
        queries: [{name:"add",sql:"INSERT INTO t VALUES(?,?,?)"},{name:"change",sql:"UPDATE t SET n=n+100 WHERE id=1"},
          {name:"q",sql:"SELECT id,v,raw,n,twice FROM t ORDER BY id"}],
      };
      const built=buildCatalog(source,{pageSize:512});
      const outputs: Uint8Array[]=[];
      for(const runtime of [aot,wasm]) {
        const db=runtime.aot_open(built.artifact,"");checked(runtime.aot_info(db));
        for(let i=1;i<=25;i++)checked(runtime.aot_execute(db,"add",aotBindings([BigInt(i),`row${i}`,BigInt(i)])));
        const exportImage=()=>{const result=runtime.aot_export_sqlite(db);checked(runtime.sqlite_info(result));return Uint8Array.from(Buffer.from(runtime.sqlite_data_base64(result),"base64"));};
        const base=exportImage();
        checked(runtime.aot_execute(db,"change","[]"));
        const after=exportImage();outputs.push(after);
        const expected=checked(runtime.aot_execute(db,"q","[]")).rows.map((row:any[])=>row.map(aotValue));
        const encoded=ltx.encode_ltx(base,after,"2","2","0");checked(ltx.ltx_info(encoded));
        assert.deepEqual(applyLtx(base,"1",ltx.ltx_data(encoded),3).data,after);
        const path=join(dir,"database.sqlite");writeFileSync(path,after);
        const native=new DatabaseSync(path);
        try {
          assert.equal(native.prepare("PRAGMA integrity_check").get()!.integrity_check,"ok");
          const query=native.prepare(source.queries[2]!.sql);query.setReadBigInts(true);query.setReturnArrays(true);
          assert.deepEqual(query.all(),expected);
        }finally{native.close();}
        for(const dynamic of [sql,sqlWasm]) {
          const handle=dynamic.database_open();
          checked(dynamic.database_import_sqlite_base64(handle,Buffer.from(after).toString("base64")));
          const actual=checked(dynamic.database_query_values(handle,source.queries[2]!.sql,"[]")).rows.map((row:any[])=>row.map(aotValue));
          assert.deepEqual(actual,expected);
          checked(dynamic.database_exec(handle,"UPDATE t SET n=n+1 WHERE id=2","[]",false));
          assert.deepEqual(checked(dynamic.database_query_values(handle,"SELECT n,twice FROM t WHERE id=2","[]")).rows
            .map((row:any[])=>row.map(aotValue)),[[3n,6n]]);
        }
      }
      assert.deepEqual(outputs[0],outputs[1]);
    }
  }finally{rmSync(dir,{recursive:true,force:true});}
});
