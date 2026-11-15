import { test } from "node:test";
import assert from "node:assert/strict";
import { MoonDatabase } from "../adapters/moon-database.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { withMaterializedReplication } from "../src/materialized-replication.ts";
import { SyncEngine } from "../src/engine.ts";
import { OfflineClient, statement } from "../src/client.ts";
for (const kind of ["node", "sqlike"] as const)
  test(`${kind} binary sync materializes triggers and FK cascades once, restores checking and deduplicates ACK`, async () => {
    const raw =
      kind === "node" ? new NodeDatabase(":memory:") : new MoonDatabase();
    const server = withMaterializedReplication(raw),
      engine = new SyncEngine(server);
    const local = withMaterializedReplication(new MoonDatabase());
    let lose = false;
    const client = new OfflineClient(
      local,
      {
        snapshot: async () => engine.snapshot(),
        push: async (b) => {
          const ack = engine.push(b);
          if (lose) {
            lose = false;
            throw Error("lost ACK");
          }
          return ack;
        },
      },
      { retry: { attempts: 1 } },
    );
    try {
      engine.migrate([
        statement("CREATE TABLE parent(id INTEGER PRIMARY KEY)"),
        statement(
          "CREATE TABLE child(id INTEGER PRIMARY KEY,p INTEGER REFERENCES parent(id) ON DELETE CASCADE ON UPDATE CASCADE)",
        ),
        statement(
          "CREATE TABLE audit(id INTEGER PRIMARY KEY AUTOINCREMENT,v TEXT)",
        ),
        statement(
          "CREATE TRIGGER parent_add AFTER INSERT ON parent BEGIN INSERT INTO audit(v) VALUES('insert'); END",
        ),
        statement(
          "CREATE TRIGGER child_del AFTER DELETE ON child BEGIN INSERT INTO audit(v) VALUES('delete'); END",
        ),
      ]);
      await client.sync();
      client.execute(
        [
          statement("INSERT INTO parent VALUES(1)"),
          statement("INSERT INTO child VALUES(2,1)"),
        ],
        "changeset",
      );
      lose = true;
      await assert.rejects(client.sync(), /lost ACK/);
      assert.equal(raw.all("SELECT * FROM audit").length, 1);
      await client.sync();
      assert.equal(engine.revision(), 1);
      client.execute(
        [statement("UPDATE parent SET id=3 WHERE id=1")],
        "changeset",
      );
      await client.sync();
      assert.equal(raw.all("SELECT p FROM child")[0]!.p, 3n);
      client.execute([statement("DELETE FROM parent WHERE id=3")], "changeset");
      await client.sync();
      assert.equal(raw.all("SELECT * FROM child").length, 0);
      assert.equal(raw.all("SELECT * FROM audit").length, 2);
      assert.equal(local.all("SELECT * FROM audit").length, 2);
      assert.throws(
        () => raw.run("INSERT INTO child VALUES(4,999)"),
        /FOREIGN KEY/,
      );
      raw.run("INSERT INTO parent VALUES(4)");
      assert.equal(raw.all("SELECT * FROM audit").length, 3);
      assert.equal(raw.all("PRAGMA foreign_keys")[0]!.foreign_keys, 1n);
    } finally {
      raw.close();
      local.close();
    }
  });
test("materialized apply rolls back missing FK targets, restores trigger definitions, schema stamp and FK mode", () => {
  const raw = new NodeDatabase(":memory:"),
    db = withMaterializedReplication(raw),
    engine = new SyncEngine(db);
  engine.migrate([
    statement("CREATE TABLE p(id INTEGER PRIMARY KEY)"),
    statement(
      "CREATE TABLE c(id INTEGER PRIMARY KEY,p INTEGER REFERENCES p(id))",
    ),
    statement("CREATE TRIGGER tr AFTER INSERT ON p BEGIN SELECT 1; END"),
  ]);
  const stamp = engine.schema();
  try {
    assert.throws(
      () =>
        db.replicaTransaction(() =>
          db.applyMaterialized(() => raw.run("INSERT INTO c VALUES(1,404)")),
        ),
      /FOREIGN KEY/,
    );
    assert.equal(raw.all("SELECT * FROM c").length, 0);
    assert.equal(
      raw.all("SELECT name FROM sqlite_schema WHERE type='trigger'").length,
      1,
    );
    assert.deepEqual(engine.schema(), stamp);
    assert.equal(raw.all("PRAGMA foreign_keys")[0]!.foreign_keys, 1n);
  } finally {
    raw.close();
  }
});
test("SQLike never persists the temporary FK suppression mode and swallowed apply errors cannot commit", () => {
  const images: string[] = [];
  const raw = new MoonDatabase(undefined, (image) => images.push(image));
  const db = withMaterializedReplication(raw);
  raw.run("CREATE TABLE p(id INTEGER PRIMARY KEY)");
  raw.run("CREATE TABLE c(id INTEGER PRIMARY KEY,p INTEGER REFERENCES p(id))");
  images.length = 0;
  db.replicaTransaction(() =>
    db.applyMaterialized(() => raw.run("INSERT INTO p VALUES(1)")),
  );
  assert.ok(images.length > 0);
  for (const image of images)
    assert.equal(JSON.parse(image).state.foreign_keys, true);
  assert.throws(
    () =>
      db.replicaTransaction(() => {
        try {
          db.applyMaterialized(() => raw.run("INSERT INTO c VALUES(1,404)"));
        } catch {}
      }),
    /failed materialized/,
  );
  assert.equal(raw.all("SELECT * FROM c").length, 0);
  raw.close();
});
test("an adapter which cannot disable FK enforcement rejects before touching rows or triggers", () => {
  const raw = new NodeDatabase(":memory:"),
    db = withMaterializedReplication(raw);
  let called = false;
  try {
    raw.transaction(() =>
      assert.throws(
        () =>
          db.replicaTransaction(() => {
            called = true;
          }),
        /cannot disable foreign keys/,
      ),
    );
    assert.equal(called, false);
    assert.equal(raw.all("PRAGMA foreign_keys")[0]!.foreign_keys, 1n);
  } finally {
    raw.close();
  }
});
test("materialized apply rejects async callbacks and rolls back its DDL scope", () => {
  const raw = new NodeDatabase(":memory:"),
    db = withMaterializedReplication(raw);
  raw.run("CREATE TABLE p(id INTEGER PRIMARY KEY)");
  raw.run("CREATE TRIGGER tr AFTER INSERT ON p BEGIN SELECT 1; END");
  try {
    assert.throws(
      () => db.replicaTransaction(() => db.applyMaterialized(async () => {})),
      /must be synchronous/,
    );
    assert.equal(
      raw.all("SELECT name FROM sqlite_schema WHERE type='trigger'").length,
      1,
    );
  } finally {
    raw.close();
  }
});
