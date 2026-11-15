import { test } from "node:test";
import assert from "node:assert/strict";
import {
  browserCapabilities,
  parseBrowserEngine,
  defaultSyncMode,
  requireCapability,
} from "../src/browser-engine.ts";
import { OfflineClient, statement } from "../src/client.ts";
import { NodeDatabase } from "../adapters/node-database.ts";

test("SQLike, SQLite and Turso use one SQL contract with explicit optional capabilities", () => {
  assert.equal(parseBrowserEngine("sqlike"), "sqlike");
  assert.equal(parseBrowserEngine("moonbit"), "sqlike");
  for (const engine of ["sqlite", "sqlike", "turso"] as const) {
    assert.equal(browserCapabilities[engine].sql, true);
    assert.equal(
      defaultSyncMode(engine),
      engine === "turso" ? "sql" : "changeset",
    );
  }
  assert.throws(
    () => requireCapability("turso", "sqliteImageRead"),
    /unsupported|SQLite image|LTX/i,
  );
  assert.throws(
    () => requireCapability("turso", "changesetCapture"),
    /Session capture/,
  );
  assert.doesNotThrow(() => requireCapability("sqlike", "sqliteImageRead"));
});
test("a SQL-only backend syncs without a fake Session API and rejects binary writes before mutation", async () => {
  const db = new NodeDatabase(":memory:"),
    server = new NodeDatabase(":memory:");
  const { SyncEngine } = await import("../src/engine.ts");
  const engine = new SyncEngine(server);
  const client = new OfflineClient(db, {
    async snapshot() {
      return engine.snapshot();
    },
    async push(bytes) {
      return engine.push(bytes);
    },
  });
  try {
    await client.sync();
    client.execute(
      [statement("INSERT INTO notes(id,title) VALUES('a','common')")],
      "sql",
    );
    await client.sync();
    assert.equal(client.pending().length, 0);
    assert.deepEqual(
      db.all("SELECT id,title FROM notes").map((row) => ({ ...row })),
      [{ id: "a", title: "common" }],
    );
    assert.throws(
      () =>
        client.execute(
          [statement("UPDATE notes SET title='invalid' WHERE id='a'")],
          "changeset",
        ),
      /Session capture/,
    );
    assert.equal(client.pending().length, 0);
    assert.equal(db.all("SELECT title FROM notes")[0]!.title, "common");
  } finally {
    db.close();
    server.close();
  }
});
