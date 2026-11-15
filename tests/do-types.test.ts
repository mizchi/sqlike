import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DODatabase, type SQLStorage } from "../adapters/do-database.ts";
import { doBindings } from "../adapters/do-bindings.ts";
function storage() {
  const db = new DatabaseSync(":memory:");
  let n = 0;
  const s: SQLStorage = {
    sql: {
      exec(sql, ...params) {
        const q = db.prepare(sql);
        q.setReadBigInts(true);
        const rows = q
          .all(
            ...params.map((v) =>
              v instanceof ArrayBuffer ? new Uint8Array(v) : v,
            ),
          )
          .map((r) =>
            Object.fromEntries(
              Object.entries(r).map(([k, v]) => [
                k,
                typeof v === "bigint"
                  ? Number(v)
                  : v instanceof Uint8Array
                    ? v.slice().buffer
                    : v,
              ]),
            ),
          ) as any;
        return {
          columnNames: q.columns().map((c) => c.name),
          toArray: () => rows,
        };
      },
    },
    transactionSync(body) {
      const name = `test${n++}`;
      db.exec(`SAVEPOINT ${name}`);
      try {
        const r = body();
        db.exec(`RELEASE ${name}`);
        return r;
      } catch (e) {
        db.exec(`ROLLBACK TO ${name};RELEASE ${name}`);
        throw e;
      }
    },
  };
  return { db, s };
}
test("DO preserves numeric classes, int64, NUL/BOM and bindings without Number inference", () => {
  const { db, s } = storage();
  try {
    const d = new DODatabase(s);
    assert.deepEqual(
      d.all(
        "SELECT 1 AS i,1.0 AS r,? AS v,typeof(?) AS t,9223372036854775807 AS big,? AS text",
        [1, 1, "\ufeffa\0b"],
      ),
      [
        {
          i: 1n,
          r: 1,
          v: 1,
          t: "real",
          big: 9223372036854775807n,
          text: "\ufeffa\0b",
        },
      ],
    );
    assert.deepEqual(
      d.all("SELECT ? AS n,typeof(?) AS t", [9223372036854775807n, 1n]),
      [{ n: 9223372036854775807n, t: "integer" }],
    );
    for (const value of [1n, 1, -0, 1.5, Number.MIN_VALUE, Number.MAX_VALUE]) {
      const sql =
        "SELECT ? AS v,typeof(?) AS t,?='1' AS eq,? BETWEEN '0' AND '2' AS between_text";
      const q = db.prepare(sql);
      q.setReadBigInts(true);
      assert.deepEqual(
        d.all(sql, [value, value, value, value]),
        q.all(value, value, value, value).map((r) => ({ ...r })),
      );
    }
    for (const sql of [
      "SELECT -0.0 AS v",
      "SELECT 1.0 AS v",
      "SELECT 1e999 AS v",
      "SELECT CAST(x'EFBBBF610062' AS TEXT) AS v",
    ]) {
      const q = db.prepare(sql);
      q.setReadBigInts(true);
      assert.deepEqual(
        d.all(sql),
        q.all().map((r) => ({ ...r })),
      );
    }
    d.run("CREATE TABLE t(v)");
    d.run("INSERT INTO t VALUES(?)", [1]);
    assert.deepEqual(d.all("SELECT typeof(v) AS t,v FROM t"), [
      { t: "real", v: 1 },
    ]);
    assert.throws(
      () => d.all("INSERT INTO t VALUES(2) RETURNING random()"),
      /unsupported DO RETURNING/,
    );
    assert.deepEqual(d.all("SELECT count(*) AS n FROM t"), [{ n: 1n }]);
    assert.throws(() => d.all("SELECT CAST(x'80' AS TEXT) AS t"), /non-UTF-8/);
    assert.throws(
      () => d.run("-- prefix\nPRAGMA encoding='UTF-16le'"),
      /unsupported DO PRAGMA/,
    );
    assert.equal(db.prepare("PRAGMA encoding").get()!.encoding, "UTF-8");
    assert.throws(
      () => d.run("INSERT INTO t VALUES(3); PRAGMA user_version=9"),
      /unsupported DO multiple statements/,
    );
    assert.deepEqual(d.all("/* prefix */ SELECT count(*) AS n FROM t"), [
      { n: 1n },
    ]);
    assert.deepEqual(
      d.all("UPDATE t SET v=2 RETURNING 'v',? AS marker,v", [1n]),
      [{ "'v'": "v", marker: 1n, v: 2n }],
    );
  } finally {
    db.close();
  }
});
test("DO binding lexer respects quoted tokens, comments and repeated positional indices", () => {
  const r = doBindings(`SELECT '?',"?",[?],?1,?1,?2 /* ? returning */ -- ?\n`, [
    1n,
    1,
  ]);
  assert.equal(r.returning, false);
  assert.equal(
    r.sql,
    `SELECT '?',"?",[?],(+CAST(?1 AS INTEGER)),(+CAST(?1 AS INTEGER)),?2 /* ? returning */ -- ?\n`,
  );
  assert.deepEqual(r.values, ["1", 1]);
  assert.throws(() => doBindings("SELECT :name", [1]), /unsupported/);
  assert.throws(() => doBindings("SELECT ?", [1n << 63n]), /range/);
  assert.equal(
    doBindings("SELECT ';'; -- trailing\n /* comment */", []).sql,
    "SELECT ';'; -- trailing\n /* comment */",
  );
});
