import { test } from "node:test";
import assert from "node:assert/strict";
import { NodeDatabase } from "../adapters/node-database.ts";
import { MoonDatabase } from "../adapters/moon-database.ts";
import { nativeValues } from "./compatibility/native-values.ts";
import { wasmRuntime } from "./compatibility/feature-runtime.ts";

test("GROUP BY uses expression collation with numeric equality and NULL groups on JS and Wasm GC", async () => {
  const native = new NodeDatabase(":memory:");
  const candidates = [
    new MoonDatabase(),
    new MoonDatabase(undefined, undefined, await wasmRuntime()),
  ];
  try {
    for (const db of [native, ...candidates]) {
      db.run(
        "CREATE TABLE groups(id INTEGER PRIMARY KEY,v TEXT COLLATE NOCASE,n BLOB)",
      );
      db.run(
        "INSERT INTO groups VALUES(1,'A',1),(2,'a',1.0),(3,'b',NULL),(4,'B',NULL),(5,'z ',2),(6,'z',2)",
      );
    }
    const queries = [
      "SELECT v,count(*) FROM groups GROUP BY v ORDER BY v",
      "SELECT v COLLATE BINARY,count(*) FROM groups GROUP BY v COLLATE BINARY ORDER BY v COLLATE BINARY",
      "SELECT v COLLATE RTRIM,count(*) FROM groups GROUP BY v COLLATE RTRIM ORDER BY v COLLATE RTRIM",
      "SELECT n,count(*) FROM groups GROUP BY n ORDER BY n",
      "SELECT v,n,count(*) FROM groups GROUP BY v,n ORDER BY v,n",
    ];
    for (const sql of queries)
      for (const db of candidates)
        assert.deepEqual(db.queryValues(sql), nativeValues(native, sql), sql);
  } finally {
    native.close();
  }
});
