import { test } from "node:test";
import assert from "node:assert/strict";
import * as runtime from "../_build/js/release/build/mizchi/sqlike/sqlike.js";
import { openSql } from "../src/sqlike-runtime.ts";
import { drizzle } from "../adapters/drizzle.ts";
import { sql } from "drizzle-orm";

test("the independent SQL driver preserves positional RETURNING and nested ORM rollback", () => {
  const db = openSql(runtime);
  try {
    db.run("CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT,b BLOB)");
    assert.deepEqual(db.values("INSERT INTO t VALUES(?,?,?) RETURNING id,id,v,b", [
      9007199254740993n, "\ufeffone\0", new Uint8Array([0, 255]),
    ]), [[9007199254740993n, 9007199254740993n, "\ufeffone\0", new Uint8Array([0, 255])]]);
    const orm = drizzle(db);
    orm.transaction((outer) => {
      outer.run(sql`INSERT INTO t VALUES(2,'outer',NULL)`);
      assert.throws(() => outer.transaction((nested) => {
        nested.run(sql`INSERT INTO t VALUES(3,'nested',NULL)`);
        throw Error("nested rollback");
      }), /nested rollback/);
      assert.deepEqual(db.values("SELECT id FROM t ORDER BY id"), [[2n], [9007199254740993n]]);
    });
    assert.throws(() => db.transaction(() => {
      db.values("INSERT INTO t VALUES(4,'abort',NULL) RETURNING id");
      throw Error("rollback");
    }), /rollback/);
    assert.deepEqual(db.values("SELECT id FROM t ORDER BY id"), [[2n], [9007199254740993n]]);
    assert.throws(() => db.savepoint(() => {}), /transaction/);
    db.close();
    assert.throws(() => db.values("SELECT 1"), /closed/);
  } finally {
    db.close();
  }
});
