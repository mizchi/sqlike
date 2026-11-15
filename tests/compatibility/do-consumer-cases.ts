import type { Value } from "../../src/contract.ts";

export interface DoConsumerCase {
  id: string;
  schema: string[];
  steps: {
    sql: string;
    params?: Value[];
    reject?: boolean;
    nativeError?: boolean;
  }[];
}
const schema = [
  "CREATE TABLE notes(id INTEGER PRIMARY KEY,title TEXT NOT NULL,n ANY,payload BLOB,tenant TEXT DEFAULT 'a') STRICT",
  "CREATE INDEX feed ON notes(tenant,id DESC) WHERE id>0",
  "INSERT INTO notes VALUES(1,'one',1.0,x'00ff','a'),(2,'two',2,NULL,'b')",
];
export const doConsumerCases: DoConsumerCase[] = [
  {
    id: "cte-values-types",
    schema,
    steps: [
      {
        sql: "WITH bound(i,r,t,b,n) AS (VALUES(?,?,?,?,?)) SELECT i,r,t,b,n,typeof(i) AS ti,typeof(r) AS tr FROM bound",
        params: [
          9223372036854775807n,
          1,
          "\ufeffa\0b",
          new Uint8Array([0, 255]),
          null,
        ],
      },
      {
        sql: "/* leading */ WITH RECURSIVE ids(id) AS (VALUES(?) UNION ALL SELECT id+1 FROM ids WHERE id<3) SELECT id FROM ids ORDER BY id; -- trailing",
        params: [1n],
      },
      {
        sql: 'WITH "select"(v) AS NOT MATERIALIZED (VALUES(\'not a SELECT;\')), "update" AS MATERIALIZED (SELECT v FROM "select") SELECT v FROM "update"',
      },
      {
        sql: "WITH outer_cte AS (WITH inner_cte AS (SELECT 1.0 AS n) SELECT n FROM inner_cte) SELECT n FROM outer_cte",
      },
      {
        sql: "WITH missing AS (SELECT id FROM notes WHERE 0) SELECT id FROM missing",
      },
      {
        sql: 'WITH "_bls_result" AS (SELECT 4 AS x) SELECT x FROM "_bls_result"',
      },
      { sql: "WITH x AS (VALUES(1,1.0)) VALUES(1,1.0)" },
      { sql: "WITH x AS (SELECT 1) SELECT 1 AS v,1.0 AS v" },
    ],
  },
  {
    id: "cte-application-dml",
    schema: [
      ...schema,
      "CREATE TABLE audit(id INTEGER PRIMARY KEY,note_id INTEGER,event TEXT)",
      "CREATE TRIGGER ai AFTER INSERT ON notes BEGIN INSERT INTO audit(note_id,event) VALUES(new.id,'insert'); END",
      "CREATE TRIGGER au AFTER UPDATE ON notes BEGIN INSERT INTO audit(note_id,event) VALUES(new.id,'update'); END",
      "CREATE TRIGGER ad AFTER DELETE ON notes BEGIN INSERT INTO audit(note_id,event) VALUES(old.id,'delete'); END",
    ],
    steps: [
      {
        sql: "WITH incoming(id,title,n,payload,tenant) AS (VALUES(?,?,?,?,?)) INSERT INTO notes SELECT * FROM incoming RETURNING *",
        params: [9007199254740993n, "new", 1, new Uint8Array([1, 255]), "a"],
      },
      {
        sql: "WITH selected AS (SELECT id FROM notes WHERE tenant=?) UPDATE notes SET n=? WHERE id IN (SELECT id FROM selected) RETURNING id,n",
        params: ["a", 2.5],
      },
      {
        sql: "WITH selected AS (SELECT id FROM notes WHERE tenant='b') DELETE FROM notes WHERE id IN (SELECT id FROM selected) RETURNING id,title",
      },
      {
        sql: "WITH incoming(id,title) AS (VALUES(4,'four'),(1,'duplicate')) INSERT INTO notes(id,title) SELECT * FROM incoming",
        nativeError: true,
      },
      {
        sql: "SELECT id,title,typeof(n) AS type,n,payload FROM notes ORDER BY id",
      },
      { sql: "SELECT note_id,event FROM audit ORDER BY id" },
    ],
  },
  {
    id: "metadata",
    schema,
    steps: [
      { sql: "PRAGMA index_list(notes)" },
      { sql: "PRAGMA main.index_info('feed')" },
      { sql: 'PRAGMA "main"."index_xinfo"(\'feed\')' },
      { sql: "PRAGMA [table_list]('notes')" },
      { sql: "PRAGMA table_xinfo(notes)" },
      { sql: "PRAGMA database_list", reject: true },
      { sql: "PRAGMA encoding", reject: true },
      { sql: "PRAGMA user_version", reject: true },
      { sql: "PRAGMA application_id", reject: true },
      { sql: "PRAGMA encoding='UTF-16le'", reject: true },
      { sql: "PRAGMA user_version=123", reject: true },
      { sql: "PRAGMA main.application_id(123)", reject: true },
      { sql: "PRAGMA user_version", reject: true },
    ],
  },
  {
    id: "returning-columns",
    schema: [
      ...schema,
      "CREATE TABLE counter_baseline(n INTEGER)",
      "INSERT INTO counter_baseline VALUES(total_changes()+1)",
    ],
    steps: [
      {
        sql: "INSERT INTO notes(id,title,n,payload) VALUES(?,?,?,?) RETURNING id,title,typeof(n),n,hex(payload),payload",
        params: [9007199254740993n, "\ufeffa\0b", 1, new Uint8Array([0, 255])],
      },
      {
        sql: "WITH incoming(id,title) AS (VALUES(3,'new')) INSERT INTO notes(id,title) SELECT * FROM incoming RETURNING *",
      },
      {
        sql: "INSERT INTO notes(id,title) VALUES(3,'upsert') ON CONFLICT(id) DO UPDATE SET title=excluded.title RETURNING id AS key,title AS \"label;?\"",
      },
      {
        sql: "UPDATE notes SET n=? WHERE id=? RETURNING ID,typeof(n) AS storage_class,n",
        params: [2.5, 3n],
      },
      { sql: "UPDATE notes SET title='ignored' WHERE 0 RETURNING title" },
      {
        sql: "DELETE FROM notes WHERE id=? RETURNING id,title,n,payload",
        params: [3n],
      },
      {
        sql: "SELECT changes() AS changed,last_insert_rowid() AS last_id,total_changes()-(SELECT n FROM counter_baseline) AS total_delta",
      },
      {
        sql: "INSERT INTO notes(id,title) VALUES(4,'must reject') RETURNING random()",
        reject: true,
      },
      {
        sql: "INSERT INTO notes(id,title) VALUES(4,'must reject') RETURNING (SELECT title FROM notes LIMIT 1)",
        reject: true,
      },
      {
        sql: "INSERT INTO notes(id,title) VALUES(4,'computed') RETURNING id+1,upper(title),coalesce(n,0) AS n,id+id,CASE WHEN id=4 THEN title ELSE 'no' END,'title'",
      },
      {
        sql: "UPDATE notes SET title=? WHERE id=? RETURNING id+?,? AS label,typeof(?) AS kind,?+0 AS real_value",
        params: ["bound", 4n, 9223372036854775800n, "bound label", 1n, 1],
      },
      {
        sql: "DELETE FROM notes WHERE id=4 RETURNING id",
      },
      {
        sql: "UPDATE notes SET title='must reject' WHERE 0 RETURNING unknown(title)",
        reject: true,
      },
      {
        sql: "SELECT changes() AS changed,last_insert_rowid() AS last_id,total_changes()-(SELECT n FROM counter_baseline) AS total_delta",
      },
      {
        sql: "INSERT INTO notes(id,title) VALUES(4,CAST(x'80' AS TEXT)) RETURNING title",
        reject: true,
      },
    ],
  },
  {
    id: "returning-identifiers",
    schema: [
      'CREATE TABLE notes(id INTEGER PRIMARY KEY,"Current_Time" TEXT,"Ü" INTEGER,"ü" REAL)',
    ],
    steps: [
      {
        sql: 'INSERT INTO notes VALUES(1,\'literal\',2,3.0) RETURNING "Current_Time","Ü","ü"',
      },
      {
        sql: 'UPDATE notes SET "Ü"=4 RETURNING "Ü" label,"ü" AS lower_case,typeof("ü") kind',
      },
      { sql: 'UPDATE notes SET "Ü"=5 RETURNING current_time', reject: true },
      { sql: "DELETE FROM notes WHERE id=1 RETURNING *" },
    ],
  },
  {
    id: "reject-atomically",
    schema,
    steps: [
      {
        sql: "WITH chosen AS (SELECT 1) UPDATE notes SET title='uncommitted' RETURNING random()",
        reject: true,
      },
      {
        sql: "WITH chosen AS (SELECT 1) DELETE FROM notes; INSERT INTO notes VALUES(9,'bad',NULL,NULL,'a')",
        reject: true,
      },
      {
        sql: "WITH chosen AS (SELECT :name) DELETE FROM notes",
        params: [1n],
        reject: true,
      },
      { sql: "WITH chosen AS SELECT 1 DELETE FROM notes", reject: true },
      { sql: "WITH chosen AS (SELECT 1) DROP TABLE notes", reject: true },
      {
        sql: "WITH x AS (SELECT 1) SELECT CAST(x'80' AS TEXT) AS invalid",
        reject: true,
      },
      { sql: "SELECT id,title,n,payload,tenant FROM notes ORDER BY id" },
    ],
  },
];
