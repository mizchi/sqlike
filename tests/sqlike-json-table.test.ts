import { test } from "node:test";
import assert from "node:assert/strict";
import { compareSixQueries, sixPaths } from "./compatibility/six-paths.ts";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import { MoonDatabase } from "../adapters/moon-database.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "./compatibility/native-values.ts";
import type { Value } from "../src/contract.ts";

test("json_each returns typed cells, hidden rowids and SQLite JSON element IDs", async () => {
  for(const json of [
    '[1,1.0,-0,1e20,true,false,null,"x",[2],{"a":3}]',
    '{"a":1,"a":2,"a.b":3,"_x":4,"空":5,"a\\nb":6,"\\u0061":7}',
    JSON.stringify(["x".repeat(260),"é","\\u0061",9223372036854775807n.toString()]),
    '[9223372036854775807,9223372036854775808,-9223372036854775809]',
  ]) await compareSixQueries([`SELECT rowid,* FROM json_each('${json.replaceAll("'","''")}')`]);
});

test("json_tree preserves parent IDs, raw paths, duplicate labels and compact container values", async () => {
  const json=' { "a": [1,{"b":true}], "cc": null, "a.b":{"\\u0061":["é",2.50]}, "a":[] } ';
  await compareSixQueries([`SELECT rowid,* FROM json_tree('${json}')`,
    `SELECT fullkey,atom FROM json_tree('${json}') WHERE type NOT IN ('array','object') ORDER BY rowid`]);
});

test("seeded JSON trees retain every typed cell, path and ID across varied layouts", async () => {
  let state=0x51a17e;
  const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return state>>>0;};
  const keys=["a","a_b","0","é","","a.b","a\"b","slash\\"];
  const make=(depth:number):unknown=>{
    const kind=random()%7;
    if(kind<2 && depth<4) {
      if(kind===0)return Array.from({length:random()%5},()=>make(depth+1));
      return Object.fromEntries(Array.from({length:random()%5},()=>[keys[random()%keys.length]!,make(depth+1)]));
    }
    return [null,true,false,1.5,-17,"é😀", "a\nb", "x".repeat(260)][random()%8];
  };
  const queries=Array.from({length:32},()=>JSON.stringify(make(0))).flatMap(json=>
    ["json_each","json_tree"].map(fn=>`SELECT rowid,* FROM ${fn}('${json.replaceAll("'","''")}')`));
  await compareSixQueries(queries);
});

test("JSON table roots handle scalar, empty, missing, quoted keys and SQL NULL", async () => {
  const queries=[];
  for(const fn of ["json_each","json_tree"]) {
    for(const input of ["NULL","1","1.5","'null'","'\"x\"'","'[]'","'{}'"])
      queries.push(`SELECT rowid,*,json,root FROM ${fn}(${input})`);
    for(const root of ["$","$.a","$.missing",'$."a.b"'])
      queries.push(`SELECT rowid,* FROM ${fn}('{"a":[10,20],"a.b":3}','${root}')`);
    for(const root of ["$[1]","$[#-1]"])
      queries.push(`SELECT rowid,* FROM ${fn}('[10,[20,30]]','${root}')`);
    queries.push(`SELECT * FROM ${fn}('[1]',NULL)`);
  }
  await compareSixQueries(queries);
});

test("JSON tables correlate with preceding rows, chain and preserve LEFT JOIN null extension", async () => {
  await compareSixQueries([
    "SELECT t.id,j.key,j.value,j.id,j.parent FROM t,json_each(t.doc) j ORDER BY t.id,j.rowid",
    "SELECT t.id,j.value FROM t LEFT JOIN json_each(t.doc) AS j ON j.value>1 ORDER BY t.id,j.rowid",
    "SELECT t.id,j.value,k.key,k.value FROM t,json_each(t.doc) j,json_each(j.value) k ORDER BY t.id,j.rowid,k.rowid",
    "SELECT id,(SELECT count(*) FROM json_tree(t.doc)) FROM t ORDER BY id",
  ],["CREATE TABLE t(id INTEGER PRIMARY KEY,doc TEXT)"],
    ["INSERT INTO t VALUES(1,'[1,2]'),(2,'[]'),(3,NULL),(4,'[[3,4]]')"]);
});

test("JSON table container subtype is retained directly and explicit across relation boundaries", async () => {
  await compareSixQueries([
    "SELECT json_array(value),json_quote(value),json_array(atom) FROM json_each('[[1],\"[2]\",{}]')",
    "SELECT json_group_array(value) FROM json_each('[[1],\"[2]\",{}]')",
    "SELECT v FROM (SELECT value AS v FROM json_each('[[1],\"[2]\"]')) j",
    "SELECT json_array(json(v)) FROM (SELECT value AS v FROM json_each('[[1],\"[2]\"]')) j",
    "SELECT value='1',value=1,typeof(value),id='1',rowid='0' FROM json_each('[1]')",
  ]);
});

test("JSON table bindings and source rows remain live on all six paths", async () => {
  const queries=[{name:"q",sql:"SELECT rowid,key,value,type,id,parent,fullkey,path FROM json_tree(?1,?2) ORDER BY rowid"}];
  const paths=await sixPaths([],queries),native=new NodeDatabase(":memory:");
  try {
    for(const params of [["[1,2]","$"],["{\"a\":[3,4]}","$.a"],["[]","$"],[null,"$"],["[5]","$[0]"]] satisfies Value[][]) {
      const expected=nativeValues(native,queries[0]!.sql,params);
      for(const p of paths)assert.deepEqual(await p.execute("q",params),expected);
    }
  }finally{native.close();await Promise.all(paths.map(p=>p.close()));}
});

test("qualified json_valid guards skip malformed preceding inputs without losing LEFT JOIN rows", async () => {
  await compareSixQueries([
    "SELECT t.id,j.value FROM t,json_each(t.doc) j WHERE json_valid(t.doc) AND j.value>1 ORDER BY t.id,j.rowid",
    "SELECT t.id,j.value FROM t LEFT JOIN json_each(t.doc) j ON 1 WHERE json_valid(t.doc) ORDER BY t.id,j.rowid",
  ],["CREATE TABLE t(id INTEGER PRIMARY KEY,doc TEXT)"],
  ["INSERT INTO t VALUES(1,'[1,2]'),(2,'{bad'),(3,NULL),(4,'[]')"]);
});

test("INSERT SELECT and UPDATE FROM use JSON tables and reject late JSON failures atomically", async () => {
  await compareSixQueries([
    "INSERT INTO t SELECT key+1,value FROM json_each('[3,4]') RETURNING *",
    "UPDATE t SET n=j.value FROM json_each('[10,20]') j WHERE t.id=j.key+1 RETURNING *",
  ],["CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)"]);
  const schema=["CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)","CREATE TABLE docs(id INTEGER PRIMARY KEY,doc TEXT)"];
  const queries=[{name:"seed",sql:"INSERT INTO docs VALUES(1,'[1]'),(2,'{bad')",write:true},
    {name:"bad",sql:"INSERT INTO t SELECT docs.id,j.value FROM docs,json_each(docs.doc) j",write:true},
    {name:"get",sql:"SELECT * FROM t"}];
  const paths=await sixPaths(schema,queries);
  try {for(const p of paths){await p.execute("seed");await assert.rejects(p.execute("bad"),/JSON/);assert.deepEqual(await p.execute("get"),[]);}}
  finally{await Promise.all(paths.map(p=>p.close()));}
});

test("unsupported JSON table shapes and invalid scopes reject before empty execution", () => {
  const schema=["CREATE TABLE t(id INTEGER PRIMARY KEY,doc TEXT)"];
  const moon=new MoonDatabase();
  try {
    schema.forEach(sql=>moon.run(sql));
    for(const sql of ["SELECT * FROM json_each(missing)","SELECT * FROM t,json_each(later.doc) j,t AS later",
      "SELECT * FROM json_each('[1]', '$', '$')", "SELECT json_each('[1]')", "SELECT * FROM json_each('[1]') j WHERE j.missing=1"]) {
      assert.throws(()=>moon.values(sql),sql);assert.throws(()=>buildCatalog({schema,queries:[{name:"q",sql}]}),sql);
    }
    for(const sql of ["SELECT * FROM json_tree('{\"a\":[1]}','$.a[0]')", "SELECT value FROM json_each('[1]') WHERE root='$[0]'",
      "SELECT * FROM t FULL JOIN json_each('[1]') j ON 1",
      "SELECT json_array(v) FROM (SELECT value AS v FROM json_each('[[1]]')) j"]) {
      assert.throws(()=>moon.values(sql),/unsupported/);assert.throws(()=>buildCatalog({schema,queries:[{name:"q",sql}]}),/unsupported/);
    }
  }finally{moon.close();}
});
