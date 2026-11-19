import { test } from "node:test";
import assert from "node:assert/strict";
import { compareSixQueries, sixPaths } from "./compatibility/six-paths.ts";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import { MoonDatabase } from "../adapters/moon-database.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "./compatibility/native-values.ts";
import type { Value } from "../src/contract.ts";
import { readFileSync } from "node:fs";
import * as js from "../_build/js/release/build/mizchi/sqlike/full/full.js";
import { aotBindings, aotValue } from "../src/aot-values.ts";

const schema = ["CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER,v TEXT)","CREATE TABLE s(id INTEGER PRIMARY KEY,n INTEGER,v TEXT)"];
const seed = ["INSERT INTO t VALUES(1,100,'a'),(2,200,'b'),(3,300,'c')","INSERT INTO s VALUES(1,10,'x'),(2,20,'y')"];

test("UPDATE FROM binds source names, leaves unmatched targets and returns target columns on six paths",async()=>{
  await compareSixQueries([
    "UPDATE t SET n=t.n-s.n,v=s.v FROM s WHERE t.id=s.id RETURNING id,n,v",
    "SELECT * FROM t ORDER BY id",
    "UPDATE t AS dst SET n=src.n+1 FROM s AS src WHERE dst.id=src.id RETURNING t.id,n",
    "UPDATE t AS dst SET n=dst.n+1 WHERE dst.id=3 RETURNING id,n",
    "UPDATE t SET n=s.n FROM s WHERE 0 RETURNING id",
    "SELECT changes()",
  ],schema,seed);
});

test("UPDATE FROM materializes aggregate derived tables and preserves RHS joins",async()=>{
  await compareSixQueries([
    "UPDATE t SET n=t.n-daily.amt FROM (SELECT id,sum(n) AS amt FROM sales GROUP BY id) AS daily WHERE t.id=daily.id RETURNING id,n",
    "UPDATE t SET v=coalesce(extra.v,'missing') FROM s LEFT JOIN extra ON s.id=extra.id WHERE t.id=s.id RETURNING id,v",
    "SELECT * FROM t ORDER BY id",
  ],[...schema,"CREATE TABLE sales(id INTEGER,n INTEGER)","CREATE TABLE extra(id INTEGER PRIMARY KEY,v TEXT)"],
    [...seed,"INSERT INTO sales VALUES(1,3),(1,4),(2,5)","INSERT INTO extra VALUES(1,'present')"]);
});

test("UPDATE FROM self joins compute every assignment from the statement snapshot",async()=>{
  await compareSixQueries([
    "UPDATE t AS dst SET n=src.n+100,v=src.v FROM t AS src WHERE dst.id=src.id+1 RETURNING id,n,v",
    "SELECT * FROM t ORDER BY id",
    "UPDATE t SET n=abs(s.n),n=s.n+1 FROM s WHERE t.id=s.id RETURNING id,n",
  ],schema,seed);
});

test("UPDATE FROM keeps source snapshots through AFTER triggers and cascades parent keys",async()=>{
  await compareSixQueries([
    "UPDATE t SET n=s.n FROM s WHERE t.id=s.id RETURNING id,n",
    "SELECT * FROM t ORDER BY id","SELECT * FROM s ORDER BY id","SELECT * FROM audit ORDER BY id",
    "UPDATE parent SET id=mapping.next_id FROM mapping WHERE parent.id=mapping.id RETURNING id",
    "SELECT * FROM child ORDER BY id",
  ],[...schema,"CREATE TABLE audit(id INTEGER,old_n INTEGER,new_n INTEGER)",
    "CREATE TRIGGER log_update AFTER UPDATE ON t BEGIN INSERT INTO audit VALUES(NEW.id,OLD.n,NEW.n); UPDATE s SET n=n+100; END",
    "CREATE TABLE parent(id INTEGER PRIMARY KEY)","CREATE TABLE child(id INTEGER PRIMARY KEY,p INTEGER REFERENCES parent(id) ON UPDATE CASCADE)",
    "CREATE TABLE mapping(id INTEGER PRIMARY KEY,next_id INTEGER)"],
    [...seed,"INSERT INTO parent VALUES(1)","INSERT INTO child VALUES(1,1)","INSERT INTO mapping VALUES(1,10)"]);
});

test("UPDATE FROM supports WITHOUT ROWID targets and full int64/binary cells",async()=>{
  await compareSixQueries([
    "UPDATE target SET n=source.n,b=source.b FROM source WHERE target.k=source.k RETURNING k,n,b",
    "SELECT k,n,b,typeof(n) FROM target ORDER BY k",
  ],["CREATE TABLE target(k TEXT COLLATE NOCASE PRIMARY KEY,n INTEGER,b BLOB) WITHOUT ROWID",
    "CREATE TABLE source(k TEXT COLLATE NOCASE PRIMARY KEY,n INTEGER,b BLOB) WITHOUT ROWID"],
    ["INSERT INTO target VALUES('a',1,x'01'),('b',2,x'02')",
      "INSERT INTO source VALUES('A',9223372036854775807,x'00ff'),('b',-9223372036854775808,x'1234')"]);
});

test("WITHOUT ROWID UPDATE FROM seeks original keys after trigger changes to pending targets",async()=>{
  for(const action of ["UPDATE t SET k='c' WHERE k='b'", "DELETE FROM t WHERE k='b'; INSERT INTO t VALUES('b',999)"]) {
    await compareSixQueries([
      "UPDATE t SET n=s.n FROM s WHERE t.k=s.k RETURNING k,n", "SELECT * FROM t ORDER BY k",
    ],["CREATE TABLE t(k TEXT PRIMARY KEY,n INTEGER) WITHOUT ROWID", "CREATE TABLE s(k TEXT PRIMARY KEY,n INTEGER)",
      `CREATE TRIGGER tr AFTER UPDATE ON t WHEN NEW.k='a' BEGIN ${action}; END`],
    ["INSERT INTO t VALUES('a',100),('b',200)", "INSERT INTO s VALUES('a',10),('b',20)"]);
  }
});

test("UPDATE FROM reuses live bindings and fresh source rows in prepared SQL/AOT/binary",async()=>{
  const queries = [
    ...seed.map((sql,i)=>({name:`seed${i}`,sql,write:true})),
    {name:"q",sql:"UPDATE t AS dst SET n=src.n+?1 FROM s AS src WHERE dst.id=src.id AND dst.id>=?2 RETURNING id,n",write:true},
    {name:"change",sql:"UPDATE s SET n=n+1",write:true},
  ];
  const paths = await sixPaths(schema,queries);const native=new NodeDatabase(":memory:");
  try {
    schema.forEach(sql=>native.raw.exec(sql));seed.forEach(sql=>native.raw.exec(sql));
    for(const p of paths)for(const i of seed.keys())await p.execute(`seed${i}`);
    for(const params of [[1n,1n],[2n,2n],[3n,9n],[4n,1n]] satisfies Value[][]) {
      const expected=nativeValues(native,queries[2]!.sql,params);
      for(const p of paths)assert.deepEqual(await p.execute("q",params),expected);
      native.raw.exec(queries[3]!.sql);for(const p of paths)await p.execute("change");
    }
  } finally {native.close();await Promise.all(paths.map(p=>p.close()));}
});

test("SQL prepared UPDATE FROM refreshes source lookups after restore, clone and schema changes",async()=>{
  const wasm=(await WebAssembly.instantiate(readFileSync("_build/wasm-gc/release/build/mizchi/sqlike/full/full.wasm"),{},
    {builtins:["js-string"],importedStringConstants:"_"})).instance.exports as unknown as typeof js;
  for(const runtime of [js,wasm]) {
    const db=runtime.database_open();
    const checked=(text:string)=>{const result=JSON.parse(text);if(result.error)throw Error(result.error);return result;};
    const run=(sql:string)=>checked(runtime.database_exec(db,sql,"[]",false));
    [...schema,...seed].forEach(run);
    const sql="UPDATE t SET n=s.n+?1 FROM s WHERE t.id=s.id AND t.id>=?2 RETURNING id,n";
    const prepared=runtime.database_prepare(db,sql);
    const execute=(params:Value[])=>checked(runtime.database_prepared_exec(prepared,aotBindings(params),false,true)).rows
      .map((row:any[])=>row.map(aotValue));
    assert.deepEqual(execute([1n,1n]),[[1n,11n],[2n,21n]]);
    const image=runtime.database_dump(db),clone=runtime.database_clone(db);
    run("UPDATE s SET n=n+100");
    assert.deepEqual(execute([2n,1n]),[[1n,112n],[2n,122n]]);
    checked(runtime.database_restore(db,image));
    assert.deepEqual(execute([3n,2n]),[[2n,23n]]);
    const cloneQuery=runtime.database_prepare(clone,sql);
    assert.deepEqual(checked(runtime.database_prepared_exec(cloneQuery,aotBindings([4n,1n]),false,true)).rows
      .map((row:any[])=>row.map(aotValue)),[[1n,14n],[2n,24n]]);
    run("DROP TABLE s");run("CREATE TABLE s(v TEXT,n INTEGER,id INTEGER PRIMARY KEY)");
    run("INSERT INTO s VALUES('z',50,1),('w',60,2)");
    assert.deepEqual(execute([4n,1n]),[[1n,54n],[2n,64n]]);
  }
});

test("multiple source matches reject before changing any target row even when values agree",async()=>{
  const base=[schema[0]!,"CREATE TABLE s(id INTEGER,n INTEGER)"];
  const queries=[{name:"seedt",sql:seed[0]!,write:true},{name:"seeds",sql:"INSERT INTO s VALUES(1,5),(2,9),(2,9)",write:true},
    {name:"bad",sql:"UPDATE t SET n=s.n FROM s WHERE t.id=s.id",write:true},{name:"get",sql:"SELECT * FROM t ORDER BY id"}];
  const paths=await sixPaths(base,queries);const native=new NodeDatabase(":memory:");
  try {
    base.forEach(sql=>native.raw.exec(sql));native.raw.exec(queries[0]!.sql);native.raw.exec(queries[1]!.sql);
    assert.doesNotThrow(()=>native.raw.exec(queries[2]!.sql));
    for(const p of paths){await p.execute("seedt");await p.execute("seeds");const before=await p.execute("get");
      await assert.rejects(p.execute("bad"),/multiple source rows|ambiguous UPDATE FROM/);assert.deepEqual(await p.execute("get"),before);}
  } finally {native.close();await Promise.all(paths.map(p=>p.close()));}
});

test("UPDATE FROM statement failures roll back earlier rows and trigger side effects",async()=>{
  const base=["CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER UNIQUE CHECK(n>=0))","CREATE TABLE s(id INTEGER PRIMARY KEY,n INTEGER)",
    "CREATE TABLE audit(id INTEGER)","CREATE TRIGGER log_update AFTER UPDATE ON t BEGIN INSERT INTO audit VALUES(NEW.id); END"];
  const queries=[{name:"seedt",sql:"INSERT INTO t VALUES(1,1),(2,2)",write:true},{name:"seeds",sql:"INSERT INTO s VALUES(1,5),(2,5)",write:true},
    {name:"bad",sql:"UPDATE t SET n=s.n FROM s WHERE t.id=s.id RETURNING id,n",write:true},
    {name:"get",sql:"SELECT * FROM t ORDER BY id"},{name:"audit",sql:"SELECT * FROM audit"}];
  const paths=await sixPaths(base,queries);const native=new NodeDatabase(":memory:");
  try {
    base.forEach(sql=>native.raw.exec(sql));native.raw.exec(queries[0]!.sql);native.raw.exec(queries[1]!.sql);
    assert.throws(()=>native.raw.exec(queries[2]!.sql),/UNIQUE/);
    for(const p of paths){await p.execute("seedt");await p.execute("seeds");await assert.rejects(p.execute("bad"),/UNIQUE/);
      assert.deepEqual(await p.execute("get"),nativeValues(native,queries[3]!.sql));assert.deepEqual(await p.execute("audit"),[]);}
  } finally {native.close();await Promise.all(paths.map(p=>p.close()));}
});

test("UPDATE FROM evaluates all assignments and rolls back expression failures",async()=>{
  const queries = [...seed.map((sql,i)=>({name:`seed${i}`,sql,write:true})),
    {name:"bad",sql:"UPDATE t SET n=abs(-9223372036854775808),n=s.n FROM s WHERE t.id=s.id",write:true},
    {name:"get",sql:"SELECT * FROM t ORDER BY id"}];
  const paths=await sixPaths(schema,queries);const native=new NodeDatabase(":memory:");
  try {
    schema.forEach(sql=>native.raw.exec(sql));seed.forEach(sql=>native.raw.exec(sql));
    assert.throws(()=>native.raw.exec(queries[2]!.sql),/overflow/);
    for(const p of paths){for(const i of seed.keys())await p.execute(`seed${i}`);
      await assert.rejects(p.execute("bad"),/overflow/);assert.deepEqual(await p.execute("get"),nativeValues(native,queries[3]!.sql));}
  } finally {native.close();await Promise.all(paths.map(p=>p.close()));}
});

test("invalid UPDATE FROM scopes reject before empty execution or writes",()=>{
  const queries=[
    "UPDATE t SET n=s.n FROM s WHERE id=s.id",
    "UPDATE t SET n=s.n FROM s WHERE t.id=s.id RETURNING s.n",
    "UPDATE t AS dst SET n=s.n FROM s WHERE dst.id=s.id RETURNING dst.id",
    "UPDATE t SET n=s.n FROM s WHERE 0 RETURNING t.*",
    "UPDATE t SET n=1 FROM s JOIN t AS other ON t.id=s.id WHERE other.id=s.id",
    "UPDATE t SET n=1 FROM s ON 1","UPDATE t SET n=1 FROM t",
    "UPDATE t SET n=1 FROM s WHERE 0 RETURNING missing",
  ];
  const native=new NodeDatabase(":memory:"),moon=new MoonDatabase();
  try {for(const db of[native,moon])for(const sql of schema)db.run(sql);
    for(const sql of queries){assert.throws(()=>native.run(sql),sql);assert.throws(()=>moon.run(sql),sql);
      assert.throws(()=>buildCatalog({schema,queries:[{name:"q",sql}]}),sql);}
  } finally {native.close();moon.close();}
});
