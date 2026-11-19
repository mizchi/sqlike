import { test } from "node:test";
import assert from "node:assert/strict";
import { MoonDatabase } from "../adapters/moon-database.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { readSchemaEntries } from "../src/schema-entries.ts";
import { withMaterializedReplication } from "../src/materialized-replication.ts";
import { SyncEngine } from "../src/engine.ts";

test("logical and physical schema enumeration preserve trigger order during snapshot and materialized replay", () => {
  for (const raw of [new MoonDatabase(), new NodeDatabase(":memory:")]) {
    const db = withMaterializedReplication(raw),
      engine = new SyncEngine(db);
    try {
      for (const sql of [
        "CREATE TABLE t(id INTEGER PRIMARY KEY)",
        "CREATE TABLE audit(id INTEGER PRIMARY KEY AUTOINCREMENT,v TEXT)",
        "CREATE TRIGGER z AFTER INSERT ON t BEGIN INSERT INTO audit(v) VALUES('z'); END",
        "CREATE VIEW v AS SELECT id FROM t",
        "CREATE TRIGGER a AFTER INSERT ON t BEGIN INSERT INTO audit(v) VALUES('a'); END",
      ])
        raw.run(sql);
      assert.deepEqual(
        readSchemaEntries(db)
          .filter((e) => e.type === "trigger")
          .map((e) => e.name),
        ["z", "a"],
      );
      assert.deepEqual(
        engine
          .snapshot()
          .schema?.filter((s) => /^CREATE TRIGGER/.test(s))
          .map((s) => s.match(/TRIGGER (\w+)/)![1]),
        ["z", "a"],
      );
      db.replicaTransaction(() =>
        db.applyMaterialized(() => raw.run("INSERT INTO t VALUES(1)")),
      );
      assert.deepEqual(raw.all("SELECT * FROM audit"), []);
      raw.run("INSERT INTO t VALUES(2)");
      assert.deepEqual(
        raw.all("SELECT v FROM audit ORDER BY id").map((r) => r.v),
        ["a", "z"],
      );
      if (raw instanceof MoonDatabase)
        assert.throws(
          () => raw.all("SELECT rowid FROM sqlite_schema"),
          /unsupported physical schema/,
        );
    } finally {
      raw.close();
    }
  }
});
