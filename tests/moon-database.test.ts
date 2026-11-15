import { test } from "node:test";
import assert from "node:assert/strict";
import { MoonDatabase } from "../adapters/moon-database.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { compatibilityCorpus } from "./compatibility/corpus.ts";

test("MoonBit executes SQL without a native SQLite database", () => {
  const db = new MoonDatabase();
  db.run(
    "CREATE TABLE items(id INTEGER PRIMARY KEY,n INTEGER NOT NULL,t TEXT,b BLOB)",
  );
  db.run("INSERT INTO items VALUES(?,?,?,?)", [
    1n,
    9223372036854775807n,
    "日本語😀",
    new Uint8Array([0, 255]),
  ]);
  assert.deepEqual(db.all("SELECT id,n,t,b FROM items"), [
    {
      id: 1n,
      n: 9223372036854775807n,
      t: "日本語😀",
      b: new Uint8Array([0, 255]),
    },
  ]);
  assert.throws(
    () =>
      db.transaction(() => {
        db.run("UPDATE items SET t=? WHERE id=1", ["rollback"]);
        db.run("INSERT INTO items VALUES(1,0,NULL,NULL)");
      }),
    /UNIQUE constraint/,
  );
  assert.equal(db.all("SELECT t FROM items")[0]!.t, "日本語😀");
});

test("MoonBit differential SQL corpus including rejected batches and subsequent state", () => {
  for (const entry of compatibilityCorpus()) {
    const oracle = new NodeDatabase(":memory:");
    const db = new MoonDatabase();
    oracle.run("PRAGMA foreign_keys=ON");
    for (const candidate of [oracle, db])
      candidate.run(
        "CREATE TABLE notes(id TEXT PRIMARY KEY NOT NULL,title TEXT NOT NULL,score INTEGER NOT NULL DEFAULT 0,payload BLOB)",
      );
    try {
      for (const [index, step] of entry.steps.entries()) {
        // These two requests are rejected by the existing application policy,
        // before reaching either database engine.
        if (step.kind === "execute" && step.error === "sql-policy") continue;
        if (step.kind === "execute") {
          const execute = (candidate: typeof db | typeof oracle) => {
            try {
              const rows = candidate.transaction(() =>
                step.statements.map((s) =>
                  candidate.all(
                    s.sql,
                    s.params.map((c) => {
                      switch (c.t) {
                        case "null":
                          return null;
                        case "integer":
                          return BigInt(c.v);
                        case "real":
                          return c.v;
                        case "text":
                          return c.v;
                        case "blob":
                          return new Uint8Array(c.v);
                        default:
                          throw Error("undefined binding");
                      }
                    }),
                  ),
                ),
              );
              return {
                rows: rows.map((result) =>
                  result.map((row) => Object.fromEntries(Object.entries(row))),
                ),
              };
            } catch (e) {
              const message = (e as Error).message;
              return {
                error: /UNIQUE|PRIMARY KEY/.test(message)
                  ? "unique"
                  : /NOT NULL/.test(message)
                    ? "notnull"
                    : /CHECK/.test(message)
                      ? "check"
                      : /FOREIGN KEY/.test(message)
                        ? "foreignkey"
                        : /no such table/.test(message)
                          ? "missing"
                          : message,
              };
            }
          };
          assert.deepEqual(
            execute(db),
            execute(oracle),
            `${entry.id} step ${index}: ${step.statements.map((s) => s.sql).join("; ")}`,
          );
        } else {
          const params = step.statement.params.map((c) =>
            c.t === "integer"
              ? BigInt(c.v)
              : c.t === "text" || c.t === "real"
                ? c.v
                : c.t === "blob"
                  ? new Uint8Array(c.v)
                  : null,
          );
          assert.deepEqual(
            db.all(step.statement.sql, params),
            oracle
              .all(step.statement.sql, params)
              .map((row) => Object.fromEntries(Object.entries(row))),
            `${entry.id} step ${index}: ${step.statement.sql}`,
          );
        }
      }
    } finally {
      oracle.close();
    }
  }
});

import { sqliteOracle } from "./compatibility/oracle.ts";
import {
  compatibilityError,
  differentialCase,
  type CompatibilityDriver,
} from "./compatibility/contract.ts";
import { bootstrapSafety, observeSQL } from "../src/safety.ts";
import { packResult, unpack, parseStatements } from "../src/protocol.ts";

test("MoonBit also matches schema fingerprints and per-statement synchronization proofs", async () => {
  const reference = sqliteOracle();
  const db = new MoonDatabase();
  db.run(
    "CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY NOT NULL,title TEXT NOT NULL,score INTEGER NOT NULL DEFAULT 0,payload BLOB)",
  );
  bootstrapSafety(db, true);
  const candidate: CompatibilityDriver = {
    async execute(statements) {
      try {
        return {
          ok: true,
          effects: db.transaction(() => observeSQL(db, statements)).effects,
        };
      } catch (e) {
        return { ok: false, error: compatibilityError(e) };
      }
    },
    async query(statement) {
      try {
        parseStatements(new TextEncoder().encode(JSON.stringify([statement])));
        return {
          ok: true,
          rows: db
            .query(statement.sql, statement.params.map(unpack))
            .map((row) =>
              Object.fromEntries(
                Object.entries(row).map(([k, v]) => [k, packResult(v)]),
              ),
            ),
        };
      } catch (e) {
        return { ok: false, error: compatibilityError(e) };
      }
    },
  };
  let steps = 0;
  try {
    for (const entry of compatibilityCorpus())
      steps += await differentialCase(entry, reference, candidate);
  } finally {
    reference.close();
  }
  assert.equal(steps, 842);
});

import { decodeChangeset } from "../src/protocol.ts";

test("MoonBit emits SQLite Session changesets accepted by native SQLite", () => {
  const db = new MoonDatabase();
  const native = new NodeDatabase(":memory:");
  const schema =
    "CREATE TABLE items(a TEXT NOT NULL,b INTEGER NOT NULL,n REAL,payload BLOB,PRIMARY KEY(a,b))";
  for (const candidate of [db, native]) {
    candidate.run(schema);
    candidate.run(
      "INSERT INTO items VALUES('old',1,1.5,x'ff'),('delete',2,2.5,NULL)",
    );
  }
  try {
    const bytes = db.capture(() => {
      db.run("INSERT INTO items VALUES(?,?,?,?)", [
        "日本語",
        9223372036854775807n,
        3.25,
        new Uint8Array([0, 255]),
      ]);
      db.run("UPDATE items SET n=9.5 WHERE a='old'");
      db.run("DELETE FROM items WHERE a='delete'");
    });
    assert.equal(decodeChangeset(bytes).length, 3);
    native.applyNativeChangeset!(bytes);
    assert.deepEqual(
      db.all("SELECT * FROM items ORDER BY a,b"),
      native
        .all("SELECT * FROM items ORDER BY a,b")
        .map((r) => Object.fromEntries(Object.entries(r))),
    );
    const before = db.dump();
    assert.throws(() => db.capture(() => db.run("DROP TABLE items")), /DDL/);
    assert.equal(db.dump(), before);
  } finally {
    native.close();
  }
});

test("checkpoint rollback covers DDL and data; rejected unsupported SQL cannot partly mutate state", () => {
  const db = new MoonDatabase();
  db.run("CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT)");
  db.run("INSERT INTO t VALUES(1,'before')");
  const before = db.dump();
  for (const sql of [
    "UPDATE t SET v='after'; COMMIT",
    "CREATE TEMP TRIGGER x AFTER INSERT ON t BEGIN SELECT 1; END",
    "ALTER TABLE t ADD COLUMN n INTEGER UNIQUE",
    "UPDATE t SET v=unknown_function(v)",
  ]) {
    assert.throws(() => db.run(sql));
    assert.equal(db.dump(), before, sql);
  }
  assert.throws(() => db.query("DELETE FROM t"), /read-only/);
  assert.equal(db.dump(), before);
  assert.throws(
    () =>
      db.transaction(() => {
        db.run("ALTER TABLE t ADD COLUMN n INTEGER DEFAULT 7");
        db.run("CREATE TABLE another(id INTEGER)");
        db.run("CREATE TRIGGER x AFTER INSERT ON t BEGIN SELECT 1; END");
        throw new Error("abort");
      }),
    /abort/,
  );
  assert.equal(db.dump(), before);
});

test("a durable image contains the complete transaction; uncertain publication poisons the connection", () => {
  let stored: string | undefined;
  let loseAck = false;
  const db = new MoonDatabase(undefined, (image) => {
    stored = image;
    if (loseAck) throw new Error("commit response lost");
  });
  db.transaction(() => {
    db.run("CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT)");
    db.run("CREATE TABLE _bls_outbox(id INTEGER PRIMARY KEY,body TEXT)");
  });
  const before = stored;
  assert.throws(() =>
    db.transaction(() => {
      db.run("INSERT INTO t VALUES(1,'rollback')");
      throw new Error("abort");
    }),
  );
  assert.equal(stored, before);
  loseAck = true;
  assert.throws(
    () =>
      db.transaction(() => {
        db.run("INSERT INTO t VALUES(1,'committed')");
        db.run("INSERT INTO _bls_outbox VALUES(1,'same-transaction')");
      }),
    /response lost/,
  );
  assert.throws(() => db.all("SELECT * FROM t"), /requires reload/);
  const reopened = new MoonDatabase(stored);
  assert.deepEqual(reopened.all("SELECT * FROM t"), [
    { id: 1n, v: "committed" },
  ]);
  assert.deepEqual(reopened.all("SELECT * FROM _bls_outbox"), [
    { id: 1n, body: "same-transaction" },
  ]);
});

test("SQL numeric edges, ASCII affinity, scalar semantics and empty sources match SQLite", () => {
  const native = new NodeDatabase(":memory:");
  const db = new MoonDatabase();
  const queries = [
    "SELECT -9223372036854775808 AS n,typeof(-9223372036854775808) AS t",
    "SELECT 9223372036854775807+1 AS n,7/2 AS division,5%2 AS rem,1/0 AS zero",
    "SELECT 1.0%0.5 AS remainder",
    "SELECT length('日本語😀'),hex(x'00ff'),abs(-3),lower('ＡA'),upper('ａa')",
    "SELECT 9007199254740993>9007199254740992.0 AS greater,-9007199254740993<-9007199254740992.0 AS lower",
    "WITH empty AS (SELECT id FROM t WHERE 0) SELECT id FROM empty",
    "SELECT count(*) AS n,sum(n) AS total,avg(n) AS average FROM t WHERE 0",
    "SELECT abs(-9223372036854775808) AS n FROM t WHERE 0",
    `SELECT coalesce(1,json_extract('malformed','$.n')) AS n`,
  ];
  try {
    for (const d of [db, native]) {
      d.run("CREATE TABLE t(id INTEGER PRIMARY KEY,n NUMERIC)");
      d.run("INSERT INTO t VALUES(1,?),(2,?),(3,?)", ["　1", "\u00a01", "1e2"]);
    }
    queries.push("SELECT id,n,typeof(n) FROM t ORDER BY id");
    for (const sql of queries)
      assert.deepEqual(
        db.all(sql),
        native.all(sql).map((row) => Object.fromEntries(Object.entries(row))),
        sql,
      );
  } finally {
    native.close();
  }
});

test("statement preparation rejects unknown RETURNING/UPSERT expressions even with no matching rows", () => {
  const db = new MoonDatabase();
  db.run("CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT)");
  const before = db.dump();
  for (const sql of [
    "UPDATE t SET v='x' WHERE 0 RETURNING unsupported(v)",
    "DELETE FROM t WHERE 0 RETURNING missing_column",
    "INSERT INTO t VALUES(1,'x') ON CONFLICT(id) DO UPDATE SET v=missing_column",
    "INSERT INTO t VALUES(1,'x') RETURNING unknown(v)",
  ]) {
    assert.throws(() => db.run(sql), /unsupported|no such column/, sql);
    assert.equal(db.dump(), before, sql);
  }
});

test("malformed logical images fail during reopen before exposing a connection", () => {
  const db = new MoonDatabase();
  db.run("CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT NOT NULL)");
  db.run("INSERT INTO t VALUES(1,'x')");
  const original = JSON.parse(db.dump());
  for (const mutate of [
    (image: typeof original) => {
      image.state.tables[0].rows[0].values = [];
    },
    (image: typeof original) => {
      image.state.tables[0].rows.push(image.state.tables[0].rows[0]);
    },
    (image: typeof original) => {
      image.state.tables[0].columns[0].name = "renamed-without-DDL";
    },
    (image: typeof original) => {
      image.state.tables[0].rows[0].values[1] = "Null";
    },
  ]) {
    const image = structuredClone(original);
    mutate(image);
    assert.throws(
      () => new MoonDatabase(JSON.stringify(image)),
      /invalid|constraint|image|duplicate/,
    );
  }
});

test("binary capture preserves a changed primary-key spelling under NOCASE collation", () => {
  const db = new MoonDatabase();
  const native = new NodeDatabase(":memory:");
  try {
    for (const d of [db, native]) {
      d.run(
        "CREATE TABLE t(id TEXT PRIMARY KEY NOT NULL COLLATE NOCASE,v TEXT)",
      );
      d.run("INSERT INTO t VALUES('old','v')");
    }
    const bytes = db.capture(() =>
      db.run("UPDATE t SET id='OLD' WHERE id='old'"),
    );
    native.applyNativeChangeset!(bytes);
    assert.deepEqual(
      db.all("SELECT * FROM t"),
      native
        .all("SELECT * FROM t")
        .map((row) => Object.fromEntries(Object.entries(row))),
    );
  } finally {
    native.close();
  }
});

test("implicit rowid labels and explicit aliases match SQLite column names", () => {
  const native = new NodeDatabase(":memory:");
  const db = new MoonDatabase();
  try {
    for (const d of [db, native]) {
      d.run("CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT)");
      d.run("INSERT INTO t VALUES(1,'x')");
      d.run("CREATE TABLE plain(v TEXT)");
      d.run("INSERT INTO plain VALUES('y')");
    }
    for (const sql of [
      "SELECT rowid FROM t",
      "SELECT ROWID AS rowid FROM t",
      "SELECT _rowid_,oid,id FROM t ORDER BY id",
      "SELECT ID,ID AS ID FROM t",
      "SELECT oid,_rowid_ FROM plain",
      "SELECT t.rowid FROM t AS t",
    ])
      assert.deepEqual(
        db.all(sql),
        native.all(sql).map((r) => Object.fromEntries(Object.entries(r))),
        sql,
      );
  } finally {
    native.close();
  }
});

test("pre-reader logical images without an encoding field remain readable", () => {
  const db = new MoonDatabase();
  db.run("CREATE TABLE old(id INTEGER PRIMARY KEY,v TEXT)");
  db.run("INSERT INTO old VALUES(1,'legacy')");
  const image = JSON.parse(db.dump());
  delete image.state.encoding;
  assert.deepEqual(
    new MoonDatabase(JSON.stringify(image)).all("SELECT * FROM old"),
    [{ id: 1n, v: "legacy" }],
  );
});
