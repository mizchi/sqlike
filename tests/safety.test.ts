import { test } from "node:test";
import assert from "node:assert/strict";
import { NodeDatabase } from "../adapters/node-database.ts";
import { OfflineClient, statement, type Transport } from "../src/client.ts";
import { SyncEngine } from "../src/engine.ts";
import type { ApplyPolicy } from "../src/safety-contract.ts";
import { failure } from "../src/errors.ts";
import { encodeFrame } from "../src/protocol.ts";

class SessionDB extends NodeDatabase {
  capture(body: () => void): Uint8Array {
    const sessions = this.all("SELECT name FROM sqlite_schema WHERE type='table'").filter(r => !String(r.name).startsWith("_") && !String(r.name).startsWith("sqlite_")).map(r => this.raw.createSession({ table: String(r.name) }));
    try { body(); return Buffer.concat(sessions.map(s => s.changeset())); }
    finally { for (const session of sessions) session.close(); }
  }
}
async function pair(native = true, policies: Record<string, ApplyPolicy> = {}) {
  const server = new NodeDatabase(":memory:", native); const engine = new SyncEngine(server, true, { policies });
  const local = new SessionDB(":memory:");
  const transport: Transport = { async push(bytes) { return engine.push(bytes); }, async snapshot() { return engine.snapshot(); } };
  const client = new OfflineClient(local, transport, { retry: { attempts: 1 } }); await client.sync();
  return { server, engine, local, client, transport, close() { server.close(); local.close(); } };
}

for (const native of [true, false]) {
  test(`reject old changeset after same-shape and identical-DDL replacement (${native})`, async () => {
    const p = await pair(native);
    try {
      p.client.execute([statement("CREATE TABLE items(id INTEGER PRIMARY KEY,title TEXT)"), statement("INSERT INTO items VALUES(1,'same')")], "sql"); await p.client.sync();
      p.client.execute([statement("UPDATE items SET title='offline' WHERE id=1")], "changeset");
      const otherDB = new SessionDB(":memory:"); const other = new OfflineClient(otherDB, p.transport); await other.sync();
      other.execute([statement("DROP TABLE items"), statement("CREATE TABLE items(id INTEGER PRIMARY KEY,title TEXT)"), statement("INSERT INTO items VALUES(1,'same')")], "sql"); await other.sync(); otherDB.close();
      await assert.rejects(p.client.sync(), /schema/i);
      assert.equal(p.server.all("SELECT title FROM items")[0]!.title, "same");
      assert.equal(p.client.pending()[0]!.status, "deferred");
    } finally { p.close(); }
  });
}

test("external identical-DDL replacement is detected by SQLite's schema cookie", async () => {
  const p = await pair();
  try {
    p.client.execute([statement("INSERT INTO notes(id,title) VALUES('x','same')")], "sql"); await p.client.sync();
    p.client.execute([statement("UPDATE notes SET title='old-client' WHERE id='x'")], "changeset");
    p.server.run("DROP TABLE notes");
    p.server.run("CREATE TABLE notes(id TEXT PRIMARY KEY NOT NULL,title TEXT NOT NULL,score INTEGER NOT NULL DEFAULT 0,payload BLOB)");
    p.server.run("INSERT INTO notes(id,title) VALUES('x','same')");
    await assert.rejects(p.client.sync(), /schema/);
    assert.equal(p.server.all("SELECT title FROM notes")[0]!.title, "same");
  } finally { p.close(); }
});

test("trusted migrations invalidate identical schemas even without a platform schema cookie", () => {
  const raw = new NodeDatabase(":memory:");
  const db = {all:raw.all.bind(raw),run:raw.run.bind(raw),transaction:raw.transaction.bind(raw)};
  try {
    const engine = new SyncEngine(db); const before = engine.schema();
    const after = engine.migrate([statement("DROP TABLE notes"),statement("CREATE TABLE notes(id TEXT PRIMARY KEY NOT NULL,title TEXT NOT NULL,score INTEGER NOT NULL DEFAULT 0,payload BLOB)")]);
    assert.equal(after.signature,before.signature);assert.equal(after.generation,before.generation+1);
  } finally { raw.close(); }
});

test("SQL-generated IDs cannot silently lose a dependent update", async () => {
  const p = await pair();
  try {
    p.client.execute([statement("INSERT INTO notes(id,title) VALUES(lower(hex(randomblob(16))),'initial')")], "sql");
    const id = String(p.local.all("SELECT id FROM notes")[0]!.id);
    p.client.execute([statement("UPDATE notes SET title='updated' WHERE id=?", [id])], "sql");
    await assert.rejects(p.client.sync(), /effect|preview/i);
    assert.equal(p.engine.revision(), 0);
    assert.equal(p.server.all("SELECT * FROM notes").length, 0);
    assert.equal(p.client.pending().length, 2);
  } finally { p.close(); }
});

test("application can defer non-unique matches and explicitly resolve them by primary key", async () => {
  let calls = 0;
  const policy: ApplyPolicy = {
    onAmbiguous(context, read) {
      calls++;
      if (context.issue.code !== "cardinality") return { action: "defer", reason: "manual review" };
      const rows = read(statement("SELECT id FROM notes WHERE id='b'"));
      if (rows.length !== 1) return { action: "defer", reason: "no unique choice" };
      return { action: "resolve", reason: "explicit user-selected key", statements: [statement("UPDATE notes SET score=7 WHERE id='b'")], assertions: [{ name: "selected", query: statement("SELECT id FROM notes WHERE id='b'"), exactly: 1 }] };
    },
    after(_context, read) {
      return Number(read(statement("SELECT score FROM notes WHERE id='b'"))[0]?.score) === 7 ? { action: "apply" } : { action: "reject", reason: "invariant failed" };
    },
  };
  const p = await pair(false, { "select-one@1": policy });
  try {
    p.client.execute([statement("INSERT INTO notes(id,title) VALUES('a','same'),('b','same')")], "sql"); await p.client.sync();
    p.client.execute([statement("UPDATE notes SET score=7 WHERE title='same'")], "sql", { policy: "select-one@1", assertions: [{ name: "target", query: statement("SELECT id FROM notes WHERE title='same'"), exactly: 1 }] });
    const frame = Uint8Array.from(p.client.pending()[0]!.frame);
    await p.client.sync();
    assert.equal(calls, 1);
    assert.deepEqual(p.server.all("SELECT score FROM notes ORDER BY id").map(r => Number(r.score)), [0, 7]);
    const duplicate = p.engine.push(frame);
    assert.equal(duplicate.duplicate, true); assert.equal(duplicate.outcome, "resolved"); assert.equal(calls, 1);
  } finally { p.close(); }
});

test("client resolver replaces an uncommitted suffix, preserves audit history and never repeats accepted prefix", async () => {
  const p = await pair();
  try {
    p.client.execute([statement("INSERT INTO notes(id,title) VALUES('a','one')")], "sql");
    p.client.execute([statement("INSERT INTO notes(id,title) VALUES(lower(hex(randomblob(16))),'random')")], "sql");
    await assert.rejects(p.client.sync(), /effect|preview/i);
    assert.equal(p.engine.revision(), 1);
    await p.client.resolvePending({ action: "replace", reason: "freeze generated key", operations: [{ mode: "sql", statements: [statement("INSERT INTO notes(id,title) VALUES('fixed','random')")] }] });
    await p.client.sync();
    assert.equal(p.engine.revision(), 2);
    assert.deepEqual(p.server.all("SELECT id FROM notes ORDER BY id").map(r => r.id), ["a", "fixed"]);
    assert.equal(p.client.resolutions().length, 1);
  } finally { p.close(); }
});

test("policy errors, asynchronous callbacks and failed postconditions fail closed", async () => {
  const policies: Record<string, ApplyPolicy> = {
    "throws@1": { before() { throw new Error("broken policy"); } },
    "async@1": { before: (() => Promise.resolve({ action: "apply" })) as never },
    "reject@1": { after() { return { action: "reject", reason: "business invariant" }; } },
  };
  for (const policy of Object.keys(policies)) {
    const p = await pair(true, policies);
    try {
      p.client.execute([statement("INSERT INTO notes(id,title) VALUES('x','one')")], "sql", { policy });
      await assert.rejects(p.client.sync(), /policy|invariant/i);
      assert.equal(p.engine.revision(), 0); assert.equal(p.server.all("SELECT * FROM notes").length, 0);
      assert.equal(p.client.pending().length, 1);
    } finally { p.close(); }
  }
});

test("unguarded legacy requests cannot bypass schema/proof checks", async () => {
  const p = await pair();
  try {
    const bytes = encodeFrame({kind:1,base:0,opId:"unguarded",payload:new TextEncoder().encode(JSON.stringify([statement("INSERT INTO notes(id,title) VALUES('x','bad')")]))});
    assert.throws(() => p.engine.push(bytes), /unguarded/);
    assert.equal(p.engine.revision(), 0);
  } finally { p.close(); }
});

test("a replica recovery policy cannot replace the user's database with another identity", async () => {
  const original = new NodeDatabase(":memory:"); const old = new SyncEngine(original);
  const replacement = new NodeDatabase(":memory:"); const other = new SyncEngine(replacement);
  const local = new SessionDB(":memory:"); let fault = false; let calls = 0;
  const client = new OfflineClient(local, {
    async push(bytes) { return old.push(bytes); },
    async snapshot() { return old.snapshot(); },
    async prepareSnapshot(options) {
      if (fault && !options?.reset) throw failure("replica-missing", "missing image", "integrity");
      return {snapshot: fault ? other.snapshot() : old.snapshot(), commit() { calls++; }, async dispose() {}};
    },
  }, {onReplicaIssue: () => ({action:"resnapshot",reason:"recover missing image"})});
  try {
    await client.sync(); fault = true;
    await assert.rejects(client.sync(), /identity/);
    assert.equal(calls, 1);
  } finally { original.close(); replacement.close(); local.close(); }
});

test("a corrupt ACK cannot be mistaken for proof of rejection or enable duplicate resolution", async () => {
  const server = new NodeDatabase(":memory:"); const engine = new SyncEngine(server); const local = new SessionDB(":memory:");
  let corrupt = true; let calls = 0;
  const client = new OfflineClient(local, {
    async snapshot() { return engine.snapshot(); },
    async push(bytes) { const receipt = engine.push(bytes); if (corrupt) { corrupt = false; throw failure("relay-checksum", "corrupt ACK", "integrity"); } return receipt; },
  }, {retry:{attempts:1}, onIssue:()=>{calls++;return{action:"replace",reason:"should never run",operations:[]};}});
  try {
    await client.sync(); client.execute([statement("INSERT INTO notes(id,title) VALUES('x','one')")],"sql");
    await assert.rejects(client.sync(), /corrupt ACK/);
    assert.equal(calls,0);assert.equal(engine.revision(),1);
    await assert.rejects(client.resolvePending({action:"replace",reason:"unsafe without ACK",operations:[]}),/confirmed/);
    await client.sync(); assert.equal(engine.revision(),1);assert.equal(client.receipts().length,1);
  } finally { server.close();local.close(); }
});

test("an uncertain authority commit can be confirmed by exact duplicate without policy callbacks", async () => {
  let calls = 0;
  const p = await pair(true, { "uncertain@1": { onAmbiguous() { calls++; return {action:"resolve",reason:"must not run",statements:[statement("UPDATE notes SET score=99")],assertions:[]}; } } });
  try {
    p.client.execute([statement("INSERT INTO notes(id,title) VALUES('x','once')")],"sql",{policy:"uncertain@1"});
    const transaction = p.server.transaction.bind(p.server); let lost = true;
    p.server.transaction = body => { const result = transaction(body); if (lost) {lost=false;throw new Error("commit response lost");} return result; };
    await assert.rejects(p.client.sync(),/commit response lost/);
    assert.equal(calls,0);assert.equal(p.engine.revision(),1);
    await assert.rejects(p.client.resolvePending({action:"replace",reason:"not confirmed",operations:[]}),/confirmed/);
    await p.client.sync();assert.equal(p.engine.revision(),1);
    assert.equal(p.client.pending().length,0);
  } finally { p.close(); }
});

test("authority storage failures cannot invoke a semantic resolver or permit client replacement", async () => {
  let calls = 0;
  const p = await pair(true, { "storage@1": { onAmbiguous() { calls++; return {action:"resolve",reason:"must not run",statements:[statement("INSERT INTO notes(id,title) VALUES('wrong','resolved')")],assertions:[]}; } } });
  try {
    p.client.execute([statement("INSERT INTO notes(id,title) VALUES('x','original')")],"sql",{policy:"storage@1"});
    const run = p.server.run.bind(p.server);let lost=true;
    p.server.run = (sql,params) => {if(lost && sql.startsWith("INSERT INTO _bls_log")){lost=false;throw new Error("authority storage unavailable");}run(sql,params);};
    await assert.rejects(p.client.sync(),/authority storage unavailable/);
    assert.equal(calls,0);assert.equal(p.engine.revision(),0);
    await assert.rejects(p.client.resolvePending({action:"replace",reason:"not confirmed",operations:[]}),/confirmed/);
    await p.client.sync();assert.equal(p.engine.revision(),1);
    assert.equal(p.server.all("SELECT id FROM notes")[0]!.id,"x");
  } finally {p.close();}
});

test("a schema policy can explicitly resolve an external identical-DDL replacement", async () => {
  let calls = 0;
  const p = await pair(true, { "migration@1": { onAmbiguous(context) {
    calls++;assert.equal(context.issue.code,"schema");
    return {action:"resolve",reason:"map intent onto the migrated key",statements:[statement("UPDATE notes SET score=9 WHERE id='x'")],assertions:[{name:"migrated key",query:statement("SELECT id FROM notes WHERE id='x'"),exactly:1}]};
  } } });
  try {
    p.client.execute([statement("INSERT INTO notes(id,title) VALUES('x','same')")],"sql");await p.client.sync();
    p.client.execute([statement("UPDATE notes SET score=9 WHERE id='x'")],"changeset",{policy:"migration@1"});
    p.server.run("DROP TABLE notes");
    p.server.run("CREATE TABLE notes(id TEXT PRIMARY KEY NOT NULL,title TEXT NOT NULL,score INTEGER NOT NULL DEFAULT 0,payload BLOB)");
    p.server.run("INSERT INTO notes(id,title) VALUES('x','same')");
    await p.client.sync();assert.equal(calls,1);
    assert.equal(Number(p.server.all("SELECT score FROM notes")[0]!.score),9);
    assert.equal(p.client.receipts().at(-1)!.receipt.outcome,"resolved");
  } finally { p.close(); }
});
