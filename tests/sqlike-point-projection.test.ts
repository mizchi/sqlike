import { test } from "node:test";
import assert from "node:assert/strict";
import { compareSixQueries, sixPaths } from "./compatibility/six-paths.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "./compatibility/native-values.ts";
import type { Value } from "../src/contract.ts";

test("scalar PK projections preserve casts, collation, JSON, rowid and residual predicates", async () => {
  await compareSixQueries([
    "SELECT n*2 AS twice,upper(s),CAST(n AS TEXT),json_array(n),id IS TRUE FROM t WHERE id=1",
    "SELECT n*2 FROM t WHERE id=2 AND s='alpha' COLLATE NOCASE",
    "SELECT CASE WHEN n>0 THEN n*2 ELSE 0 END,t.* FROM t WHERE rowid=1",
    "SELECT hex(b),length(b),b FROM t AS x WHERE x.id=1 ORDER BY n DESC",
  ],
  ["CREATE TABLE t(id INTEGER PRIMARY KEY,n,s TEXT COLLATE NOCASE,b BLOB)"],
  ["INSERT INTO t VALUES(1,3,'Alpha',X'00ff'),(2,NULL,'beta',NULL),(3,9223372036854775807,'other',NULL)"]);
});

test("point expressions read current bindings and live rows, including composite WITHOUT ROWID keys", async () => {
  const schema=["CREATE TABLE t(a TEXT COLLATE NOCASE,b INTEGER,n,PRIMARY KEY(a,b)) WITHOUT ROWID"];
  const queries=[
    {name:"seed",sql:"INSERT INTO t VALUES('A',1,3),('B',2,8)",write:true},
    {name:"get",sql:"SELECT n*?,typeof(n),a||b FROM t WHERE a=? AND b=? AND n>? LIMIT ? OFFSET ?"},
    {name:"set",sql:"UPDATE t SET n=? WHERE a=? AND b=?",write:true},
  ];
  const paths=await sixPaths(schema,queries),native=new NodeDatabase(":memory:");
  try {
    schema.forEach(sql=>native.raw.exec(sql));native.raw.exec(queries[0]!.sql);
    for(const p of paths)await p.execute("seed");
    for(const params of [[2n,"a",1n,0n,-1n,0n],[1.5,"B","2",3n,1n,0n],[2n,"A",1n,0n,1n,1n],[2n,"missing",1n,0n,1n,0n],[2n,"A",1n,0n,"1",0n]] satisfies Value[][]) {
      const expected=nativeValues(native,queries[1]!.sql,params);
      for(const p of paths)assert.deepEqual(await p.execute("get",params),expected);
    }
    native.run(queries[2]!.sql,[12n,"a",1n]);for(const p of paths)await p.execute("set",[12n,"a",1n]);
    const params:Value[]=[3n,"A",1n,0n,1n,0n];
    for(const p of paths)assert.deepEqual(await p.execute("get",params),nativeValues(native,queries[1]!.sql,params));
  }finally{native.close();await Promise.all(paths.map(p=>p.close()));}
});

test("point optimization leaves aggregates, windows, subqueries, DISTINCT and expression ordering on general paths", async () => {
  await compareSixQueries([
    "SELECT count(*),sum(n) FROM t WHERE id=9",
    "SELECT row_number() OVER(),n*2 FROM t WHERE id=1",
    "SELECT (SELECT n+1 FROM t AS x WHERE x.id=t.id) FROM t WHERE id=1",
    "SELECT DISTINCT n*2 FROM t WHERE id=1",
    "SELECT n*2 AS v FROM t WHERE id=1 ORDER BY v+1",
    "SELECT abs(n) FROM t WHERE id=2 LIMIT 0",
  ],["CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)"],["INSERT INTO t VALUES(1,3),(2,-9223372036854775808)"]);
});

test("REAL column negative zero normalization matches SQLite on SQL, AOT and binary writes",async()=>{
  await compareSixQueries([
    "INSERT INTO t VALUES(-0.0,-0.0) RETURNING r,b,typeof(r),typeof(b)",
    "SELECT r,b FROM t",
    "UPDATE t SET r=-0.0,b=-0.0 RETURNING r,b",
    "SELECT r,b FROM audit",
    "SELECT CAST(-0.0 AS REAL)",
  ],["CREATE TABLE t(r REAL,b BLOB)","CREATE TABLE audit(r,b)",
    "CREATE TRIGGER it AFTER INSERT ON t BEGIN INSERT INTO audit VALUES(NEW.r,NEW.b); END",
    "CREATE TRIGGER at AFTER UPDATE ON t BEGIN INSERT INTO audit VALUES(NEW.r,NEW.b); END"]);
});
