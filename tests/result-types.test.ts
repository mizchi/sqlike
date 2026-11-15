import { test } from "node:test";
import assert from "node:assert/strict";
import { NodeDatabase } from "../adapters/node-database.ts";
import { MoonDatabase } from "../adapters/moon-database.ts";
import { SyncEngine, importSnapshot } from "../src/engine.ts";
import { packResult, packStored, pack } from "../src/protocol.ts";
test("result/storage marshalling never changes an integral REAL into INTEGER", () => {
  assert.deepEqual(packResult(1), { t: "real", v: 1 });
  assert.deepEqual(packStored(1), { t: "real", v: 1 });
  assert.deepEqual(packStored(1n), { t: "integer", v: "1" });
  assert.deepEqual(pack(1), { t: "integer", v: "1" }); // Existing input-builder convention is explicit.
});
test("database bindings and snapshot roundtrips preserve REAL storage classes", () => {
  for (const source of [new NodeDatabase(":memory:"), new MoonDatabase()]) {
    try {
      assert.deepEqual(
        source
          .all("SELECT typeof(?) AS t,? AS v", [1, 1])
          .map((r) => [r.t, r.v]),
        [["real", 1]],
      );
      source.run("CREATE TABLE typed(id INTEGER PRIMARY KEY,v)");
      source.run("INSERT INTO typed VALUES(1,1.0),(2,1e100)");
      const snapshot = new SyncEngine(source).snapshot();
      assert.deepEqual(
        snapshot.tables.find((t) => t.name === "typed")!.rows.map((r) => r[1]),
        [
          { t: "real", v: 1 },
          { t: "real", v: 1e100 },
        ],
      );
      const dest = new MoonDatabase();
      dest.transaction(() => importSnapshot(dest, snapshot));
      assert.deepEqual(
        dest.queryValues("SELECT typeof(v),v FROM typed ORDER BY id"),
        [
          ["real", 1],
          ["real", 1e100],
        ],
      );
    } finally {
      if (source instanceof NodeDatabase) source.close();
    }
  }
});

test("Turso rejects ambiguous REAL bindings before dispatch instead of reclassifying values", async () => {
  const { validateTursoBindings } = await import(
    "../adapters/turso-bindings.ts"
  );
  for (const n of [1, -0, 1e100, NaN, Infinity])
    assert.throws(
      () => validateTursoBindings([n]),
      /unsupported Turso REAL binding/,
    );
  assert.doesNotThrow(() =>
    validateTursoBindings([1n, 1.5, "x", null, new Uint8Array([0, 255])]),
  );
});
