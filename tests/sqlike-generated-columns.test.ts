import { test } from "node:test";
import assert from "node:assert/strict";
import { compareSixQueries, sixPaths } from "./compatibility/six-paths.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { MoonDatabase } from "../adapters/moon-database.ts";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import { nativeValues } from "./compatibility/native-values.ts";

test("VIRTUAL columns bind interspersed and forward dependencies on all six paths", async () => {
  await compareSixQueries([
    "INSERT INTO t VALUES(1,3,'Hello') RETURNING *",
    "INSERT INTO t(id,n,v) VALUES(2,NULL,'World') RETURNING id,twice,label,typeof(twice)",
    "SELECT *,typeof(twice),typeof(label),typeof(score) FROM t ORDER BY id",
    "UPDATE t SET n=n+4,v=upper(v) WHERE id=1 RETURNING *",
    "SELECT id,twice,label,score FROM t WHERE twice>=10 ORDER BY twice DESC",
    "SELECT sum(twice),count(label) FROM t",
    "DELETE FROM t WHERE twice>10 RETURNING *",
  ], ["CREATE TABLE t(id INTEGER PRIMARY KEY,score NUMERIC AS(twice+1),n INTEGER,twice INTEGER GENERATED ALWAYS AS(n*2) VIRTUAL,v TEXT,label TEXT AS(lower(v)||':'||coalesce(n,0)))"]);
});

test("generated column affinity, declared collation and JSON subtype match SQLite", async () => {
  await compareSixQueries([
    "INSERT INTO t(a,j) VALUES('001','{\"n\":7}'),('A','{\"n\":null}') RETURNING *",
    "SELECT a,b,typeof(b),c,typeof(c),d,typeof(d),v,json_array(v) FROM t ORDER BY a",
    "SELECT a FROM t WHERE c='a' ORDER BY a",
    "UPDATE t SET a='02',j='{\"n\":9}' WHERE a='001' RETURNING b,c,d,v",
  ], ["CREATE TABLE t(a TEXT,j TEXT,b INTEGER AS(a),c TEXT AS(a COLLATE BINARY) COLLATE NOCASE,d NUMERIC AS(length(a)),v TEXT AS(json_extract(j,'$.n')))"]);
});

test("generated constraints, indexes, upsert and trigger values share write behavior", async () => {
  await compareSixQueries([
    "INSERT INTO t VALUES(1,'Alpha',3),(2,'Beta',4) RETURNING *",
    "SELECT id,k,n FROM t WHERE k='ALPHA' ORDER BY id",
    "INSERT INTO t VALUES(3,'ALPHA',5) ON CONFLICT(k) DO UPDATE SET n=excluded.n RETURNING *",
    "UPDATE t SET v='Gamma',n=7 WHERE id=1 RETURNING *",
    "SELECT * FROM t WHERE twice>=8 ORDER BY twice,id",
    "SELECT * FROM audit ORDER BY id",
  ], ["CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT,n INTEGER,k TEXT COLLATE NOCASE AS(lower(v)) UNIQUE NOT NULL,twice INT AS(n*2) CHECK(twice>=0))",
    "CREATE INDEX by_twice ON t(twice,id)", "CREATE TABLE audit(id INTEGER,k TEXT,n INTEGER)",
    "CREATE TRIGGER audit_t AFTER UPDATE ON t BEGIN INSERT INTO audit VALUES(NEW.id,NEW.k,NEW.twice); END"]);
});

test("generated FK values and WITHOUT ROWID tables match SQLite", async () => {
  await compareSixQueries([
    "INSERT INTO p VALUES(10),(20)", "INSERT INTO c VALUES('b',10),('a',20) RETURNING *",
    "SELECT * FROM c ORDER BY k", "UPDATE c SET base=10 WHERE k='a' RETURNING *",
    "PRAGMA foreign_key_check", "SELECT c.k,p.id FROM c JOIN p ON c.ref=p.id ORDER BY c.k",
  ], ["CREATE TABLE p(id INTEGER PRIMARY KEY)",
    "CREATE TABLE c(k TEXT PRIMARY KEY,base INTEGER,ref INT AS(base) REFERENCES p(id)) WITHOUT ROWID"]);
});

test("table_info hides generated columns and table_xinfo retains declaration cid", async () => {
  await compareSixQueries(["PRAGMA table_info(t)", "PRAGMA table_xinfo(t)", "PRAGMA index_xinfo(ix)"],
    ["CREATE TABLE t(a INTEGER,b TEXT AS(a||'x'),c TEXT DEFAULT 'v')", "CREATE INDEX ix ON t(b)"]);
});

test("generated INTEGER PRIMARY KEY dependencies use the BEFORE INSERT rowid sentinel", async () => {
  await compareSixQueries([
    "INSERT INTO t(n) VALUES(2) RETURNING *", "INSERT INTO t VALUES(10,3) RETURNING *",
    "UPDATE t SET id=20 WHERE id=10 RETURNING *",
  ], ["CREATE TABLE t(id INTEGER PRIMARY KEY,n INT,v INT AS(id+n))",
    "CREATE TRIGGER before_t BEFORE INSERT ON t WHEN (NEW.n=2 AND NEW.id<>-1) OR (NEW.id=-1 AND NEW.v<>1) BEGIN SELECT RAISE(ABORT,'wrong generated rowid'); END"]);
});

test("generated defaults, STRICT ANY and UPDATE FROM retain base-column contracts", async () => {
  await compareSixQueries([
    "INSERT INTO t DEFAULT VALUES RETURNING *", "INSERT INTO t(n) VALUES(4) RETURNING *",
    "UPDATE t SET n=s.n FROM s WHERE t.id=s.id RETURNING *",
    "SELECT * FROM t ORDER BY id", "INSERT INTO strict_t VALUES('001') RETURNING *,typeof(v)",
  ], ["CREATE TABLE t(id INTEGER PRIMARY KEY,n INT DEFAULT 2,v INT AS(n*2))", "CREATE TABLE s(id INTEGER PRIMARY KEY,n INT)",
    "CREATE TABLE strict_t(a ANY,v ANY AS(a)) STRICT"], ["INSERT INTO s VALUES(1,9)"]);
});

test("generated tables reject Session capture before executing the callback", () => {
  const db=new MoonDatabase();
  try {
    db.run("CREATE TABLE t(id INTEGER PRIMARY KEY,n INT,v INT AS(n*2))");
    let called=false;
    assert.throws(()=>db.capture(()=>{called=true;db.run("INSERT INTO t VALUES(1,2)");}), /generated/);
    assert.equal(called,false);assert.deepEqual(db.values("SELECT * FROM t"),[]);
  }finally{db.close();}
});

test("writes to VIRTUAL columns and generated constraint failures reject atomically", async () => {
  const schema = ["CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER,v INTEGER AS(n*2) UNIQUE CHECK(v>=0))"];
  const queries = [
    { name: "seed", sql: "INSERT INTO t VALUES(1,2),(2,3)", write: true },
    { name: "check", sql: "UPDATE t SET n=CASE id WHEN 1 THEN 4 ELSE -1 END", write: true },
    { name: "unique", sql: "UPDATE t SET n=8", write: true },
    { name: "get", sql: "SELECT * FROM t ORDER BY id" },
  ];
  const paths = await sixPaths(schema,queries), native = new NodeDatabase(":memory:");
  try {
    schema.forEach(sql=>native.raw.exec(sql)); native.raw.exec(queries[0]!.sql);
    for(const p of paths) await p.execute("seed");
    for(const name of ["check","unique"]) {
      assert.throws(()=>native.raw.exec(queries.find(q=>q.name===name)!.sql));
      for(const p of paths) { await assert.rejects(p.execute(name), /constraint/i); assert.deepEqual(await p.execute("get"), nativeValues(native,queries[3]!.sql)); }
    }
    for(const sql of ["INSERT INTO t(id,n,v) VALUES(3,4,8)", "UPDATE t SET v=1 WHERE 0", "INSERT INTO t VALUES(3,4) ON CONFLICT(id) DO UPDATE SET v=excluded.v"]) {
      assert.throws(()=>native.raw.exec(sql)); assert.throws(()=>buildCatalog({schema,queries:[{name:"q",sql}]}));
      const moon=new MoonDatabase(); try {schema.forEach(ddl=>moon.run(ddl));assert.throws(()=>moon.run(sql), /generated/);}finally{moon.close();}
    }
  } finally {native.close();await Promise.all(paths.map(p=>p.close()));}
});

test("invalid generation expressions reject while defining an empty schema", () => {
  const native=new NodeDatabase(":memory:"), moon=new MoonDatabase();
  const declarations = [
    "CREATE TABLE t(a INT,b AS(b+1))", "CREATE TABLE t(a INT,b AS(c+1),c AS(b+1))",
    "CREATE TABLE t(a INT,b AS(rowid+1))", "CREATE TABLE t(a INT,b AS(t.a+1))",
    "CREATE TABLE t(a INT,b AS(?))", "CREATE TABLE t(a INT,b AS((SELECT 1)))",
    "CREATE TABLE t(a INT,b AS(sum(a)))", "CREATE TABLE t(a INT,b AS(row_number() OVER()))",
    "CREATE TABLE t(a INT,b AS(changes()))", "CREATE TABLE t(a INT,b AS(random()))",
    "CREATE TABLE t(a INT,b AS(a+1) DEFAULT NULL)", "CREATE TABLE t(a INT,b AS(a+1) PRIMARY KEY)",
    "CREATE TABLE t(b AS(1))", "CREATE TABLE t(a INT,b AS(missing+1))",
  ];
  try {
    for(const sql of declarations) {assert.throws(()=>native.raw.exec(sql),sql);assert.throws(()=>moon.run(sql),sql);assert.throws(()=>buildCatalog({schema:[sql],queries:[]}),sql);}
    for(const sql of ["CREATE TABLE t(a INT,b AS(a+1) STORED)","CREATE TABLE t(a INT,b AS(date('2000-01-01')))","CREATE TABLE t(a INT,b REAL AS(a))"]) {
      assert.throws(()=>moon.run(sql), /unsupported|generated/);assert.throws(()=>buildCatalog({schema:[sql],queries:[]}), /unsupported|generated/);
    }
  } finally {native.close();moon.close();}
});
