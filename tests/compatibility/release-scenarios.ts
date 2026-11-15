import type { DifferentialCase } from "./differential-contract.ts";
import { datum } from "./differential-core.ts";
import type { Value } from "../../src/contract.ts";
export const releaseSchema = [
  "CREATE TABLE tenants(tenant TEXT PRIMARY KEY NOT NULL,total INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE tasks(id INTEGER PRIMARY KEY,tenant TEXT NOT NULL,title TEXT NOT NULL CHECK(length(title)>0),deleted INTEGER NOT NULL DEFAULT 0,updated_at INTEGER,score ANY,payload BLOB,meta TEXT,created TEXT NOT NULL DEFAULT '2024-02-29T00:00:00Z',FOREIGN KEY(tenant) REFERENCES tenants(tenant) ON UPDATE CASCADE ON DELETE CASCADE) STRICT",
  "CREATE INDEX feed ON tasks(tenant,updated_at DESC,id ASC) WHERE deleted=0",
  "CREATE UNIQUE INDEX live_title ON tasks(tenant,lower(title)) WHERE deleted=0",
  "CREATE TABLE tags(task_id INTEGER NOT NULL,tag TEXT NOT NULL,PRIMARY KEY(task_id,tag),FOREIGN KEY(task_id) REFERENCES tasks(id) ON UPDATE CASCADE ON DELETE CASCADE) WITHOUT ROWID",
  "CREATE TABLE audit(id INTEGER PRIMARY KEY,task_id INTEGER NOT NULL,event TEXT NOT NULL,title TEXT)",
  "CREATE TRIGGER task_check BEFORE INSERT ON tasks WHEN new.title='forbidden' BEGIN SELECT RAISE(ABORT,'forbidden title'); END",
  "CREATE TRIGGER task_update_check BEFORE UPDATE OF title ON tasks WHEN new.title='forbidden' BEGIN SELECT RAISE(ABORT,'forbidden title'); END",
  "CREATE TRIGGER task_insert AFTER INSERT ON tasks BEGIN INSERT INTO audit(task_id,event,title) VALUES(new.id,'insert',new.title); UPDATE tenants SET total=total+1 WHERE tenant=new.tenant; END",
  "CREATE TRIGGER task_delete AFTER DELETE ON tasks BEGIN INSERT INTO audit(task_id,event,title) VALUES(old.id,'delete',old.title); UPDATE tenants SET total=total-1 WHERE tenant=old.tenant; END",
  "CREATE TRIGGER task_update AFTER UPDATE OF title ON tasks WHEN new.title<>old.title BEGIN INSERT INTO audit(task_id,event,title) VALUES(new.id,'update',new.title); END",
];
const op = (sql: string, ...params: Value[]) => ({
  sql,
  params: params.map(datum),
});
export const releaseSeed = [
  op("INSERT INTO tenants(tenant) VALUES('a'),('b')"),
  op(
    "INSERT INTO tasks(id,tenant,title,updated_at,score,payload,meta) VALUES(1,'a','One',10,1.0,x'00ff','{\"done\":false}'),(2,'a','Two',10,2.5,NULL,'{\"done\":true}')",
  ),
  op("INSERT INTO tags VALUES(1,'urgent'),(2,'work')"),
];
export const releaseObserve = [
  op(
    "SELECT id,tenant,title,deleted,updated_at,typeof(score),score,hex(payload),meta,created FROM tasks ORDER BY id",
  ),
  op("SELECT tenant,total FROM tenants ORDER BY tenant"),
  op("SELECT task_id,tag FROM tags ORDER BY task_id,tag"),
  op("SELECT task_id,event,title FROM audit ORDER BY id"),
];
export function releaseScenarios(): DifferentialCase[] {
  const make = (
    id: string,
    steps: ReturnType<typeof op>[],
    extra: Partial<DifferentialCase> = {},
  ): DifferentialCase => ({
    id,
    family: "release-application",
    scope: "supported",
    schema: releaseSchema,
    seed: releaseSeed,
    steps,
    observe: releaseObserve,
    ...extra,
  });
  return [
    make("U01", [
      op(
        "INSERT INTO tasks(id,tenant,title,score,payload,meta) VALUES(?,?,?,?,?,?) RETURNING id,typeof(score),score,hex(payload)",
        3n,
        "b",
        "three",
        1,
        new Uint8Array([0, 255]),
        null,
      ),
      op(
        "INSERT INTO tasks(id,tenant,title) VALUES(3,'b','updated') ON CONFLICT(id) DO UPDATE SET title=excluded.title RETURNING id,title",
      ),
      op("INSERT INTO tasks(id,tenant,title) VALUES(4,'b','')"),
      op("SELECT id,typeof(score),score,payload,meta FROM tasks ORDER BY id"),
    ]),
    make("U02", [
      op(
        "INSERT INTO tasks(id,tenant,title,updated_at) VALUES(3,'a','Three',9),(4,'a','Four',NULL),(5,'b','Other',10)",
      ),
      op(
        "SELECT id,title,updated_at FROM tasks WHERE tenant='a' AND deleted=0 ORDER BY updated_at DESC,id ASC LIMIT 2",
      ),
      op(
        "SELECT id,title,updated_at FROM tasks WHERE tenant='a' AND deleted=0 AND (updated_at<10 OR (updated_at=10 AND id>1)) ORDER BY updated_at DESC,id ASC LIMIT 2",
      ),
      op("UPDATE tasks SET updated_at=11 WHERE id=3"),
      op(
        "SELECT id FROM tasks WHERE tenant='a' AND deleted=0 ORDER BY updated_at ASC,id DESC",
      ),
    ]),
    make("U03", [
      op(
        "SELECT t.tenant,count(*) AS n,sum(t.score) AS score FROM tasks t JOIN tags g ON g.task_id=t.id GROUP BY t.tenant HAVING count(*)>0 ORDER BY t.tenant",
      ),
      op("UPDATE tenants SET tenant='renamed' WHERE tenant='a'"),
      op("UPDATE tasks SET id=7 WHERE id=1"),
      op("DELETE FROM tasks WHERE id=7"),
      op("INSERT INTO tags VALUES(999,'bad')"),
      op("PRAGMA foreign_key_check"),
    ]),
    make("U04", [
      op("UPDATE tasks SET deleted=1 WHERE id=1"),
      op("INSERT INTO tasks(id,tenant,title) VALUES(3,'a','ONE')"),
      op("UPDATE tasks SET deleted=0 WHERE id=1"),
      op("DELETE FROM tasks WHERE id=3"),
      op("UPDATE tasks SET deleted=0 WHERE id=1"),
      op("INSERT INTO tasks(id,tenant,title) VALUES(4,'a','one')"),
      op(
        "SELECT id,title FROM tasks WHERE title='one' COLLATE NOCASE ORDER BY id",
      ),
    ]),
    make("U05", [
      op(
        "UPDATE tasks SET title=CASE WHEN id=1 THEN 'changed' ELSE 'forbidden' END",
      ),
      op("UPDATE tasks SET title='changed' WHERE id=1 RETURNING id,title"),
      op(
        "INSERT INTO tasks(id,tenant,title) VALUES(3,'a','ok'),(4,'a','forbidden')",
      ),
      op("DELETE FROM tasks WHERE id=2"),
    ]),
    make("U06", [
      op(
        "UPDATE tasks SET meta=json_set(meta,'$.count',?),created=? WHERE id=1",
        3n,
        "2024-02-29T23:30:00+02:00",
      ),
      op(
        "SELECT id,json_valid(meta),json_extract(meta,'$.count'),date(created),datetime(created,'+1 day'),strftime('%Y-%m-%d',created),unixepoch(created) FROM tasks ORDER BY id",
      ),
      op("UPDATE tasks SET meta=json_set('{bad','$.x',1) WHERE id=1"),
      op(
        "SELECT json_extract(NULL,'$.a'),date(NULL),datetime('2000-02-29','+1 year','floor')",
      ),
    ]),
    make(
      "U07",
      [
        op("ALTER TABLE tasks ADD COLUMN extra INTEGER"),
        op("ALTER TABLE tasks RENAME COLUMN title TO label"),
        op("ALTER TABLE tasks DROP COLUMN extra"),
        op(
          "INSERT INTO tasks(id,tenant,label) VALUES(3,'a','after migration')",
        ),
        op("SELECT id,label FROM tasks ORDER BY id"),
        op("ALTER TABLE tasks DROP COLUMN label"),
      ],
      {
        dynamicOnly: true,
        observe: releaseObserve.map((q) => ({
          ...q,
          sql: q.sql.includes("FROM tasks")
            ? q.sql.replace("title", "label")
            : q.sql,
        })),
      },
    ),
    make("U08", [
      op("BEGIN"),
      op("INSERT INTO tasks(id,tenant,title) VALUES(3,'b','offline')"),
      op("SAVEPOINT optional"),
      op("UPDATE tasks SET title='trial' WHERE id=3"),
      op("ROLLBACK TO optional"),
      op("RELEASE optional"),
      op("COMMIT"),
      op("UPDATE tasks SET title='confirmed' WHERE id=3"),
    ]),
    make("U09", [
      op(
        "INSERT INTO tasks(id,tenant,title,score,payload) VALUES(?,?,?,?,?)",
        3n,
        "b",
        "overflow",
        9223372036854775807n,
        new Uint8Array(16000).fill(37),
      ),
      op("UPDATE tasks SET id=8 WHERE id=1"),
      op("DELETE FROM tasks WHERE id=2"),
      op("PRAGMA foreign_key_check"),
    ]),
  ];
}
