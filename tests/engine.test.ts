import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { NodeDatabase } from "../adapters/node-database.ts";
import { SyncEngine } from "../src/engine.ts";
import { pack } from "../src/protocol.ts";
import { encodeOperation, schemaStamp, observeSQL } from "../src/safety.ts";

const sql = (db: NodeDatabase, opId: string, base: number, query: string, params: import("../src/contract.ts").Cell[] = []) => {
  const marker = new Error("preview rollback"); let frame!: Uint8Array;
  try { db.transaction(() => {
    const guard = { version: 2 as const, schema: schemaStamp(db), policy: "strict@1", intent: null, assertions: [], proof: observeSQL(db, [{sql:query,params}]).effects };
    frame = encodeOperation({kind:1,opId,base,payload:new TextEncoder().encode(JSON.stringify([{sql:query,params}]))}, guard);
    throw marker;
  }); } catch (error) { if (error !== marker) throw error; }
  return frame;
};
const binary = (db: NodeDatabase, opId: string, base: number, payload: Uint8Array) => encodeOperation({kind:2,opId,base,payload}, {version:2,schema:schemaStamp(db),policy:"strict@1",intent:null,assertions:[]});

for (const native of [true, false]) {
  test(`atomic commit, dedupe, stale SQL and rollback (${native ? "native" : "DO translation"})`, () => {
    const db = new NodeDatabase(":memory:", native);
    const engine = new SyncEngine(db);
    const frame = sql(db, "a:1", 0, "INSERT INTO notes(id,title) VALUES ('a','first')");
    assert.equal(engine.push(frame).revision, 1);
    assert.equal(engine.push(frame).duplicate, true);
    assert.throws(() => engine.push(sql(db, "a:1", 0, "DELETE FROM notes")), /identity/);
    assert.throws(() => engine.push(sql(db, "b:1", 0, "UPDATE notes SET title='lost'")), /stale/);
    const bad = encodeOperation({ kind: 1, base: 1, opId: "bad", payload: new TextEncoder().encode(JSON.stringify([{ sql: "UPDATE notes SET title='bad'", params: [] }, { sql: "INSERT INTO missing VALUES (1)", params: [] }])) }, {version:2,schema:schemaStamp(db),policy:"strict@1",intent:null,assertions:[],proof:[{affected:1,changes:"0".repeat(64),result:"0".repeat(64),schema:"0".repeat(64)}]});
    assert.throws(() => engine.push(bad));
    assert.equal(engine.snapshot().revision, 1);
    assert.equal(db.all("SELECT title FROM notes")[0]?.title, "first");
    db.close();
  });

  test(`native changesets merge different rows, reject conflicts and protect journal (${native ? "native" : "DO translation"})`, () => {
    const db = new NodeDatabase(":memory:", native);
    const engine = new SyncEngine(db);
    engine.push(sql(db, "seed", 0, "INSERT INTO notes(id,title) VALUES ('a','old'),('b','old')"));
    const client = new DatabaseSync(":memory:");
    client.exec("CREATE TABLE notes(id TEXT PRIMARY KEY NOT NULL,title TEXT NOT NULL,score INTEGER NOT NULL DEFAULT 0,payload BLOB); INSERT INTO notes(id,title) VALUES ('a','old'),('b','old')");
    const session = client.createSession();
    client.exec("UPDATE notes SET title='offline',payload=x'00ff',score=42 WHERE id='a'");
    engine.push(sql(db, "other", 1, "UPDATE notes SET title='remote' WHERE id='b'"));
    const frame = binary(db, "offline", 1, session.changeset());
    assert.equal(engine.push(frame).revision, 3);
    assert.equal(engine.push(frame).duplicate, true);
    const rows = db.all("SELECT id,title FROM notes ORDER BY id");
    assert.deepEqual(rows.map(r => r.title), ["offline", "remote"]);
    assert.throws(() => engine.push(binary(db, "conflict", 1, session.changeset())), /conflict/i);
    assert.equal(engine.snapshot().revision, 3);
    client.exec("CREATE TABLE _bls_attack(id PRIMARY KEY); INSERT INTO _bls_attack VALUES(1)");
    const attack = client.createSession(); client.exec("UPDATE _bls_attack SET id=2");
    assert.throws(() => engine.push(binary(db, "attack", 3, attack.changeset())));
    attack.close(); session.close(); client.close(); db.close();
  });
}

test("binary changesets preserve int64 and snapshots encode values without rounding", () => {
  const db = new NodeDatabase(":memory:"); const engine = new SyncEngine(db);
  const params = [pack("big"), pack("int64"), pack(9223372036854775807n)];
  engine.push(sql(db, "big", 0, "INSERT INTO notes(id,title,score) VALUES (?,?,?)", params));
  assert.deepEqual(engine.snapshot().tables[0]?.rows[0]?.[2], { t: "integer", v: "9223372036854775807" });
  db.close();
});
