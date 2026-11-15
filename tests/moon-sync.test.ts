import { test } from "node:test";
import assert from "node:assert/strict";
import { MoonDatabase } from "../adapters/moon-database.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { OfflineClient, statement, type Transport } from "../src/client.ts";
import { SyncEngine } from "../src/engine.ts";
import { applicationPolicies } from "../src/application.ts";

for (const authority of ["sqlite", "moonbit"]) {
  test(`MoonBit/${authority}: lost ACK survives reopen; ambiguous policy resolves once`, async () => {
    const server =
      authority === "sqlite"
        ? new NodeDatabase(":memory:")
        : new MoonDatabase();
    const engine = new SyncEngine(server, true, {
      policies: applicationPolicies,
    });
    let image: string | undefined;
    const persist = (next: string) => {
      image = next;
    };
    let loseAck = false;
    const transport: Transport = {
      async snapshot() {
        return engine.snapshot();
      },
      async push(bytes) {
        const ack = engine.push(bytes);
        if (loseAck) {
          loseAck = false;
          throw new Error("ACK lost after authority commit");
        }
        return ack;
      },
    };
    let db = new MoonDatabase(undefined, persist);
    let client = new OfflineClient(db, transport, { retry: { attempts: 1 } });
    try {
      await client.sync();
      client.execute(
        [
          statement(
            "INSERT INTO notes(id,title) VALUES('a','same'),('b','same')",
          ),
        ],
        "sql",
      );
      loseAck = true;
      await assert.rejects(client.sync(), /ACK lost/);
      assert.equal(engine.revision(), 1);
      assert.equal(client.pending().length, 1);
      await assert.rejects(
        client.resolvePending({
          action: "replace",
          reason: "cannot guess commit outcome",
          operations: [],
        }),
        /confirmed/,
      );
      db = new MoonDatabase(image, persist);
      client = new OfflineClient(db, transport, { retry: { attempts: 1 } });
      await client.sync();
      assert.equal(engine.revision(), 1);
      assert.equal(client.pending().length, 0);
      client.execute(
        [statement("UPDATE notes SET score=7 WHERE title='same'")],
        "sql",
        {
          policy: "select-note@1",
          intent: { id: "b", score: 7 },
          assertions: [
            {
              name: "unique selection",
              query: statement("SELECT id FROM notes WHERE title='same'"),
              exactly: 1,
            },
          ],
        },
      );
      const frame = Uint8Array.from(client.pending()[0]!.frame);
      await client.sync();
      assert.deepEqual(
        client.state().rows.map((r) => r.score),
        [
          { t: "integer", v: "0" },
          { t: "integer", v: "7" },
        ],
      );
      assert.equal(engine.push(frame).duplicate, true);
      assert.equal(engine.revision(), 2);
      assert.equal(client.receipts().at(-1)!.receipt.outcome, "resolved");
      client.execute(
        [statement("UPDATE notes SET title='binary' WHERE id='a'")],
        "changeset",
      );
      await client.sync();
      assert.equal(client.state().rows[0]!.title!.t, "text");
      assert.equal(
        server.all("SELECT title FROM notes WHERE id='a'")[0]!.title,
        "binary",
      );
    } finally {
      if (server instanceof NodeDatabase) server.close();
    }
  });
}
