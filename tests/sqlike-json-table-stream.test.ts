import { test } from "node:test";
import assert from "node:assert/strict";
import { compareSixQueries, sixPaths } from "./compatibility/six-paths.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { nativeValues } from "./compatibility/native-values.ts";

test("streamed JSON aggregates match materialized paths across types, hidden columns and roots", async () => {
  const aggregates="sum(atom),total(atom),avg(atom),count(atom),count(value),count(*),sum(key),count(type),count(json),count(root),sum(rowid),sum(_rowid_),sum(oid),count(NULL),sum(2)";
  const queries=[];
  for(const fn of ["json_each","json_tree"])for(const input of ["null","[]","{}","1","[1,null,2.5,true,false,\"3\",[],{}]","{\"a\":[1,2],\"a\":4,\"b\":null}"]) {
    const sql=`SELECT ${aggregates} FROM ${fn}('${input}') AS j`;
    queries.push(sql,`${sql} WHERE 1=1`);
  }
  queries.push(
    "SELECT sum(atom),count(*) FROM json_tree('[1,[2,3]]','$[1]')",
    "SELECT sum(key),sum(atom),count(*) FROM json_tree('[1,2]','$[#-1]')",
    "SELECT sum(atom),count(*) FROM json_each('{\"a\":[2,3]}','$.missing')",
    "SELECT count(*),total(atom),avg(value) FROM json_tree(NULL)",
    "SELECT count(*),sum(atom) FROM json_each('[1]',NULL)",
    "SELECT count(*),sum(atom) FROM json_each('[1]') LIMIT 0",
    "SELECT count(*),sum(atom) FROM json_each('[1]') LIMIT 1 OFFSET 1",
    "SELECT sum(value),avg(value),count(key) FROM json_tree('[[],{},1,\"2\",null]')",
  );
  await compareSixQueries(queries);
});

test("streamed aggregates preserve numeric overflow, real compensation and live-bind recovery", async () => {
  const sql="SELECT sum(atom),total(atom),avg(atom),count(*) FROM json_each(?)";
  const paths=await sixPaths([],[{name:"q",sql}]),native=new NodeDatabase(":memory:");
  try {
    for(const input of ["[9223372036854775807,1]","bad json","[1,2]","[1e100,1,-1e100,2]","[9223372036854775807,1,0.5]","[]"]) {
      let expected;try{expected=nativeValues(native,sql,[input]);}catch{}
      for(const p of paths) {
        if(expected)assert.deepEqual(await p.execute("q",[input]),expected);
        else await assert.rejects(p.execute("q",[input]));
      }
    }
  }finally{native.close();await Promise.all(paths.map(p=>p.close()));}
});
