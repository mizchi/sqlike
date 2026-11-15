import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeDatabase } from "../adapters/node-database.ts";
import { OfflineClient, RemoteError, statement, type Transport } from "../src/client.ts";
import { SyncEngine } from "../src/engine.ts";

class SessionDB extends NodeDatabase {
  capture(body: () => void): Uint8Array {
    const sessions = this.all("SELECT name FROM sqlite_schema WHERE type='table'").filter(r => !String(r.name).startsWith("_bls_") && !String(r.name).startsWith("sqlite_")).map(r => this.raw.createSession({ table: String(r.name) }));
    try { body(); return Buffer.concat(sessions.map(s => s.changeset())); }
    finally { for (const s of sessions) s.close(); }
  }
}

test("lost ACK survives client restart; identical operations commit exactly once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "browser-litestream-"));
  const server = new NodeDatabase(":memory:"); const engine = new SyncEngine(server);
  let loseAck = false;
  const transport: Transport = {
    async snapshot() { return engine.snapshot(); },
    async push(bytes) { const ack = engine.push(bytes); if (loseAck) { loseAck = false; throw new Error("connection lost after commit"); } return ack; },
  };
  let local = new SessionDB(join(dir, "local.sqlite")); let client = new OfflineClient(local, transport, { retry: { attempts: 1 } });
  try {
    await client.sync(); loseAck = true;
    client.execute([statement("INSERT INTO notes(id,title) VALUES (?,?)", ["x", "offline"])], "changeset");
    await assert.rejects(client.sync(), /connection lost/);
    assert.equal(client.pending().length, 1); assert.equal(engine.revision(), 1);
    local.close(); local = new SessionDB(join(dir, "local.sqlite")); client = new OfflineClient(local, transport, { retry: { attempts: 1 } });
    await client.sync();
    assert.equal(engine.revision(), 1); assert.equal(client.pending().length, 0);
    assert.equal(client.state().rows[0]?.title?.t, "text");
  } finally { local.close(); server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("failed snapshot download keeps outbox; stale SQL is durable and cannot overwrite remote rows", async () => {
  const server = new NodeDatabase(":memory:"); const engine = new SyncEngine(server);
  const local = new SessionDB(":memory:"); let failDownload = false;
  const transport: Transport = {
    async snapshot() { if (failDownload) throw new Error("snapshot unavailable"); return engine.snapshot(); },
    async push(bytes) { try { return engine.push(bytes); } catch (e) { throw new RemoteError(String(e), true); } },
  };
  const client = new OfflineClient(local, transport, { retry: { attempts: 1 } });
  try {
    await client.sync(); failDownload = true;
    client.execute([statement("INSERT INTO notes(id,title) VALUES('x','one')")], "sql");
    await assert.rejects(client.sync(), /snapshot unavailable/);
    assert.equal(client.pending().length, 1);
    failDownload = false; await client.sync(); assert.equal(engine.revision(), 1);
    client.execute([statement("UPDATE notes SET title='local'")], "sql");
    server.run("UPDATE notes SET title='remote'");
    // Represent a concurrent commit via another client, including its journal entry.
    const other = new SessionDB(":memory:"); const peer = new OfflineClient(other, transport); await peer.sync();
    peer.execute([statement("UPDATE notes SET score=10")], "sql"); await peer.sync(); other.close();
    await assert.rejects(client.sync(), /stale/);
    assert.equal(client.pending()[0]?.status, "deferred");
    assert.equal(server.all("SELECT title FROM notes")[0]?.title, "remote");
    await client.discardPending(); assert.equal(client.pending().length, 0);
  } finally { local.close(); server.close(); }
});
