import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { encodeFrame, decodeFrame, decodeChangeset, sqlAllowed,isInternalTable } from "../src/protocol.ts";

test("MoonBit binary envelope rejects truncation, trailing data and invalid revisions", () => {
  const frame = { kind: 2 as const, base: 17, opId: "日本語:1", payload: new Uint8Array([0, 255, 1]) };
  const bytes = encodeFrame(frame);
  assert.deepEqual(decodeFrame(bytes), frame);
  for (let i = 0; i < bytes.length; i++) assert.throws(() => decodeFrame(bytes.subarray(0, i)));
  assert.throws(() => decodeFrame(new Uint8Array([...bytes, 0])));
  assert.throws(() => encodeFrame({ ...frame, base: 2 ** 32 }));
});

test("MoonBit decodes actual SQLite INSERT/UPDATE/DELETE with int64, Unicode, REAL and BLOB", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE items (a TEXT, b INTEGER, n REAL, payload BLOB, PRIMARY KEY(a,b)); INSERT INTO items VALUES ('old',1,1.5,x'ff'); INSERT INTO items VALUES ('delete',2,2.5,NULL)");
  const session = db.createSession();
  db.exec("INSERT INTO items VALUES ('日本語',9223372036854775807,3.25,x'00ff'); UPDATE items SET n=9.5 WHERE a='old'; DELETE FROM items WHERE a='delete'");
  const changes = decodeChangeset(session.changeset());
  assert.equal(changes.length, 3);
  assert.deepEqual(changes.find(c => c.op === 18)?.new, [{ t: "text", v: "日本語" }, { t: "integer", v: "9223372036854775807" }, { t: "real", v: 3.25 }, { t: "blob", v: [0, 255] }]);
  assert.equal(changes.find(c => c.op === 23)?.new[0]?.t, "undefined");
  assert.throws(() => decodeChangeset(session.changeset().subarray(0, 8)));
  session.close(); db.close();
});

test("SQL policy protects metadata and transaction ownership across SQLite quoting", () => {
  for (const sql of ['DELETE FROM [_bls_log]', "SELECT * FROM `_bls_log`", "SELECT * FROM '_bls_log'", "DELETE FROM sqlite_sequence", "DELETE FROM _litestream_lock", "ATTACH 'foo' AS db", "SELECT load_extension('foo')", "UPDATE notes SET score=1; COMMIT", "/* unterminated", "SELECT 'unterminated"]) assert.equal(sqlAllowed(sql), false, sql);
  assert.equal(sqlAllowed("INSERT INTO notes VALUES (?, 'it''s fine'); -- trailing"), true);
});

test("Turso internal tables are excluded from snapshots and inaccessible to application SQL/changesets",()=>{
  const table="__turso_internal_seq_test";
  assert.equal(isInternalTable(table),true);
  for(const sql of [`DELETE FROM ${table}`,`SELECT * FROM [${table}]`,`SELECT * FROM '${table}'`])assert.equal(sqlAllowed(sql),false);
  const db=new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE ${table}(id INTEGER PRIMARY KEY,value TEXT)`);
    const session=db.createSession();db.exec(`INSERT INTO ${table} VALUES(1,'no')`);
    try {assert.throws(()=>decodeChangeset(session.changeset()));}finally{session.close();}
  }finally{db.close();}
});
