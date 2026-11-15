import { test } from "node:test";
import assert from "node:assert/strict";
import { NodeDatabase } from "../adapters/node-database.ts";
import { MoonDatabase } from "../adapters/moon-database.ts";
import { OfflineClient, statement, type Transport } from "../src/client.ts";
import { SyncEngine } from "../src/engine.ts";
import { sqlAllowed } from "../src/protocol.ts";

const trigger =
  "CREATE TRIGGER note_audit AFTER INSERT ON notes BEGIN INSERT INTO audit(note_id,title) VALUES(new.id,new.title); END";
for (const serverKind of ["sqlite", "sqlike"] as const)
  test(`${serverKind} SQL synchronization captures trigger effects once through lost ACK and snapshot reload`, async () => {
    const server =
      serverKind === "sqlite"
        ? new NodeDatabase(":memory:")
        : new MoonDatabase();
    const engine = new SyncEngine(server);
    const local = new MoonDatabase();
    let lose = false;
    const transport: Transport = {
      snapshot: async () => engine.snapshot(),
      push: async (bytes) => {
        const ack = engine.push(bytes);
        if (lose) {
          lose = false;
          throw Error("lost trigger ACK");
        }
        return ack;
      },
    };
    const client = new OfflineClient(local, transport, {
      retry: { attempts: 1 },
    });
    try {
      assert.equal(
        sqlAllowed(trigger),
        false,
        "network SQL policy stays strict",
      );
      engine.migrate([
        statement(
          "CREATE TABLE audit(id INTEGER PRIMARY KEY AUTOINCREMENT,note_id TEXT,title TEXT)",
        ),
        statement(trigger),
      ]);
      await client.sync();
      client.execute(
        [statement("INSERT INTO notes(id,title) VALUES('a','one')")],
        "sql",
      );
      assert.equal(local.all("SELECT * FROM audit").length, 1);
      lose = true;
      await assert.rejects(client.sync(), /lost trigger ACK/);
      assert.equal(engine.revision(), 1);
      assert.equal(server.all("SELECT * FROM audit").length, 1);
      await client.sync();
      assert.equal(client.pending().length, 0);
      assert.equal(engine.revision(), 1);
      assert.equal(
        local.all("SELECT * FROM audit").length,
        1,
        "imported after-images must not fire triggers",
      );
      const restored = new MoonDatabase(local.dump());
      try {
        assert.equal(restored.all("SELECT * FROM audit").length, 1);
        restored.run("INSERT INTO notes(id,title) VALUES('b','two')");
        assert.equal(restored.all("SELECT * FROM audit").length, 2);
      } finally {
        restored.close();
      }
      client.execute([statement("INSERT INTO notes(id,title) VALUES('b','binary')")], "changeset");
      await assert.rejects(client.sync(), /materialized replication/i);
      assert.equal(server.all("SELECT * FROM audit").length, 1);

    } finally {
      local.close();
      server.close();
    }
  });
