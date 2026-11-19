import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defineSqlike } from "../src/sqlike-features.ts";
import { buildSqlikeRuntime } from "../scripts/build-sqlike-runtime.ts";
import { analyzeCatalogRequirements } from "../scripts/analyze-catalog.ts";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import { buildDefinedCatalog } from "../scripts/defined-compiler.ts";
import { openCompiled } from "../src/sqlike-runtime.ts";
import { createDefinedDatabase } from "../adapters/defined-database-core.ts";
import { definedWasm } from "../adapters/defined-wasm.ts";

test("JSON table catalogs omit scalar JSON and SQL parsers while retaining live lateral bindings", async () => {
  const catalog={
    schema:["CREATE TABLE t(id INTEGER PRIMARY KEY,doc TEXT)"],
    queries:[{name:"add",sql:"INSERT INTO t VALUES(1,?)"},{name:"change",sql:"UPDATE t SET doc=? WHERE id=1"},
      {name:"q",sql:"SELECT j.key,j.value,j.id FROM t,json_each(t.doc) j ORDER BY t.id,j.rowid"},
      {name:"tree",sql:"SELECT key,value,parent,fullkey FROM json_tree(?1,?2) ORDER BY rowid"}],
  };
  const requirements=analyzeCatalogRequirements(catalog);
  assert.deepEqual(requirements.features,["jsonTableFunctions"]);
  assert.deepEqual(requirements.functionGroups,[]);
  assert.deepEqual(analyzeCatalogRequirements({schema:[],queries:[{name:"q",sql:"SELECT 'json_each([1])'"}]}).features,[]);
  const dir=await mkdtemp(join(tmpdir(),"sqlike-json-table-profile-"));
  try {
    for(const mode of ["aot","defined"] as const) {
      const built=await buildSqlikeRuntime(defineSqlike({mode}),{catalog,outDir:join(dir,mode),minify:false});
      assert.deepEqual(built.requirements,requirements);
      const code=await readFile(join(built.directory,"runtime.js"),"utf8");
      assert.doesNotMatch(code,/function [^\n]*(parse__statement|json__call|datetime__call)\(/);
      const js=await import(pathToFileURL(join(built.directory,"runtime.js")).href);
      const wasm=(await WebAssembly.instantiate(await readFile(join(built.directory,"runtime.wasm")),{},
        {builtins:["js-string"],importedStringConstants:"_"})).instance.exports;
      for(const [i,raw] of [js,wasm].entries()) {
        const db=mode==="aot"?openCompiled(raw,buildCatalog(catalog).artifact)
          :await createDefinedDatabase(i===0?raw:definedWasm(raw)).memory(buildDefinedCatalog(catalog));
        try {
          await db.execute("add",["[1,2]"]);
          assert.deepEqual((await db.execute("q")).rows,[[0n,1n,1n],[1n,2n,3n]]);
          await db.execute("change",['{"a":3}']);
          assert.deepEqual((await db.execute("q")).rows,[["a",3n,1n]]);
          assert.deepEqual((await db.execute("tree",['{"a":[4]}',"$.a"])).rows,[["a","[4]",null,"$.a"],[0n,4n,1n,"$.a[0]"]]);
          await assert.rejects(async()=>db.execute("tree",["[1]","$[0][0]"]),/unsupported/);
          assert.deepEqual((await db.execute("q")).rows,[["a",3n,1n]]);
          await db.execute("change",[null]);assert.deepEqual((await db.execute("q")).rows,[]);
        }finally{if("close" in db && typeof db.close==="function")await db.close();}
      }
    }
  }finally{await rm(dir,{recursive:true,force:true});}
});
