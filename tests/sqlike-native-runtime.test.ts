import { test } from "node:test";
import assert from "node:assert/strict";
import * as runtime from "../_build/js/release/build/mizchi/sqlike/experimental-aot-typed/experimental-aot-typed.js";
import { openNativeCompiled } from "../src/sqlike-native-runtime.ts";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "./compatibility/native-values.ts";
import type { Value } from "../src/contract.ts";

const schema=["CREATE TABLE t(id INTEGER PRIMARY KEY,b BLOB,n INTEGER CHECK(n>0))"];
const queries=[
  {name:"add",sql:"INSERT INTO t VALUES(?,?,?) RETURNING *"},
  {name:"q",sql:"SELECT b AS same,n*2 AS same FROM t WHERE id=?"},
  {name:"set",sql:"UPDATE t SET n=? WHERE id=? RETURNING n"},
  {name:"constants",sql:"SELECT ?,?,?,?,?,?,?"},
  {name:"clock",sql:"SELECT CURRENT_TIMESTAMP,changes(),last_insert_rowid()"},
  {name:"all",sql:"SELECT * FROM t ORDER BY id"},
  {name:"overflow",sql:"SELECT abs(?)"},
];
const artifact=()=>buildCatalog({schema,queries}).artifact;

test("native compiled adapter preserves typed bindings, positional output and BLOB ownership",()=>{
  const db=openNativeCompiled(runtime,artifact(),"",{clock:()=>0}),native=new NodeDatabase(":memory:");
  try{
    schema.forEach(sql=>native.raw.exec(sql));
    const blob=Buffer.from([1,2,255]),params:Value[]=[1n,blob,3n];
    const added=db.execute("add",params);
    assert.deepEqual(added.rows,nativeValues(native,queries[0]!.sql,params));
    assert.equal(added.readonly,false);assert.equal(added.changes,1);
    blob[0]=88;(added.rows[0]![1] as Uint8Array)[1]=99;
    const q=db.prepare("q");assert.deepEqual(q.names,["same","same"]);
    assert.deepEqual(q.values([1n]),[[Uint8Array.of(1,2,255),6n]]);
    const values:Value[]=[9223372036854775807n,-9223372036854775808n,1.5,-0,"a\0日本語",null,Uint8Array.of(0,255)];
    assert.deepEqual(db.values("constants",values),nativeValues(native,queries[3]!.sql,values));
    assert.equal(Object.is(db.values("constants",values)[0]![3],-0),true);
    assert.deepEqual(db.values("clock"),[["1970-01-01 00:00:00",1n,1n]]);
    for(const invalid of [[],[true],[undefined],[{}],[NaN],[Infinity],[1n<<63n],[-(1n<<63n)-1n],["\ud800"]]) {
      assert.throws(()=>q.values(invalid as Value[]));assert.deepEqual(q.get([1n]),[Uint8Array.of(1,2,255),6n]);
    }
    assert.throws(()=>db.values("overflow",[-9223372036854775808n]),/overflow/);
    assert.deepEqual(db.values("overflow",[3n]),[[3n]]);
    q.finalize();q.finalize();assert.throws(()=>q.values([1n]),/finalized/);
    assert.throws(()=>db.prepare("set"),/SELECT/);
    assert.throws(()=>db.execute("set",[-1n,1n]),/constraint/);
    assert.deepEqual(db.values("q",[1n]),[[Uint8Array.of(1,2,255),6n]]);
  }finally{db.close();native.close();}
});

test("native prepared wrappers survive restore and rollback, release handles on cache eviction and close",()=>{
  const calls={prepare:0,finalize:0};
  const raw={...runtime,prepare:(...args:Parameters<typeof runtime.prepare>)=>{calls.prepare++;return runtime.prepare(...args);},
    finalize:(q:Parameters<typeof runtime.finalize>[0])=>{calls.finalize++;return runtime.finalize(q);}};
  const db=openNativeCompiled(raw,artifact(),"",{statementCacheCapacity:1,clock:()=>0});
  db.execute("add",[1n,null,3n]);const q=db.prepare("q"),image=db.dump();
  assert.deepEqual(q.values([1n]),[[null,6n]]);
  db.execute("set",[8n,1n]);assert.deepEqual(q.values([1n]),[[null,16n]]);
  db.restore(image);assert.deepEqual(q.values([1n]),[[null,6n]]);
  assert.throws(()=>db.transaction(()=>{db.execute("set",[9n,1n]);assert.deepEqual(q.values([1n]),[[null,18n]]);throw Error("undo");}),/undo/);
  assert.deepEqual(q.values([1n]),[[null,6n]]);
  assert.throws(()=>db.transaction(()=>Promise.resolve()),/synchronous/);
  assert.throws(()=>db.transaction(()=>db.transaction(()=>{})),/nested/);
  db.values("all");db.values("clock");db.values("all");
  assert.ok(calls.finalize>=2);
  db.close();db.close();assert.equal(calls.finalize,calls.prepare);
  assert.throws(()=>q.values([1n]),/closed/);assert.throws(()=>db.dump(),/closed/);
});

test("native raw ABI validates arrays before executing and does not JSON-encode successful calls",()=>{
  const db=runtime.open(artifact(),"");
  for(const params of [null,{},"[]",[true],[undefined],Array(3)])assert.throws(()=>runtime.execute_typed(db,"add",params as Value[]));
  assert.deepEqual(runtime.execute_typed(db,"all",[]).rows,[]);
  const parse=JSON.parse,stringify=JSON.stringify;
  try{
    JSON.parse=()=>{throw Error("unexpected JSON.parse");};JSON.stringify=()=>{throw Error("unexpected JSON.stringify");};
    assert.deepEqual(runtime.execute_typed(db,"add",[1n,Uint8Array.of(1),2n]).rows,[[1n,Uint8Array.of(1),2n]]);
    const q=runtime.prepare(db,"q");
    try{assert.deepEqual(runtime.values_typed(q,[1n]),[[Uint8Array.of(1),4n]]);}finally{runtime.finalize(q);}
  }finally{JSON.parse=parse;JSON.stringify=stringify;}
});

test("typed REAL storage normalizes negative zero while untyped storage and direct bindings preserve it",()=>{
  const schema=["CREATE TABLE t(r REAL,b BLOB)","CREATE TABLE audit(r,b)",
    "CREATE TRIGGER insert_t AFTER INSERT ON t BEGIN INSERT INTO audit VALUES(NEW.r,NEW.b); END",
    "CREATE TRIGGER after_t AFTER UPDATE ON t BEGIN INSERT INTO audit VALUES(NEW.r,NEW.b); END"];
  const queries=[{name:"add",sql:"INSERT INTO t VALUES(?,?) RETURNING r,b"},
    {name:"set",sql:"UPDATE t SET r=?,b=? RETURNING r,b"},{name:"q",sql:"SELECT r,b FROM t"},
    {name:"audit",sql:"SELECT r,b FROM audit"}];
  const db=openNativeCompiled(runtime,buildCatalog({schema,queries}).artifact),native=new NodeDatabase(":memory:");
  try{
    schema.forEach(sql=>native.raw.exec(sql));
    for(const name of ["add","set"]) {
      const sql=queries.find(q=>q.name===name)!.sql;
      assert.deepEqual(db.execute(name,[-0,-0]).rows,nativeValues(native,sql,[-0,-0]));
      assert.deepEqual(db.values("q"),nativeValues(native,queries[2]!.sql));
    }
    assert.deepEqual(db.values("audit"),nativeValues(native,queries[3]!.sql));
  }finally{db.close();native.close();}
});
