import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DODatabase, type SQLStorage } from "../adapters/do-database.ts";
import type { Value } from "../src/contract.ts";
import { doConsumerCases } from "./compatibility/do-consumer-cases.ts";

/** Native SQLite with the DO boundary: every numeric result becomes Number. */
function storage(db: DatabaseSync): SQLStorage {
  let counter = 0;
  return {
    sql: {
      exec(sql, ...params) {
        const q = db.prepare(sql);
        q.setReadBigInts(true);
        const rows = q.all(
          ...params.map((v) =>
            v instanceof ArrayBuffer ? new Uint8Array(v) : v,
          ),
        );
        return {
          columnNames: q.columns().map((c) => c.name),
          toArray: () =>
            rows.map((r) =>
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
            ) as Record<string, number | string | null | ArrayBuffer>[],
        };
      },
    },
    transactionSync(fn) {
      const name = `s${counter++}`;
      db.exec(`SAVEPOINT ${name}`);
      try {
        const r = fn();
        db.exec(`RELEASE ${name}`);
        return r;
      } catch (e) {
        db.exec(`ROLLBACK TO ${name};RELEASE ${name}`);
        throw e;
      }
    },
  };
}
function native(db: DatabaseSync, sql: string, params: Value[]) {
  const q = db.prepare(sql);
  q.setReadBigInts(true);
  return q.all(...params).map((r) => ({ ...r }));
}
for (const scenario of doConsumerCases)
  test(`DO consumer ${scenario.id} matches native typed rows and failed-write state`, () => {
    const reference = new DatabaseSync(":memory:"),
      raw = new DatabaseSync(":memory:"),
      store = storage(raw),
      db = new DODatabase(store);
    try {
      for (const sql of scenario.schema) {
        reference.exec(sql);
        raw.exec(sql);
      }
      for (const step of scenario.steps) {
        if (step.reject) {
          const before = native(raw, "SELECT * FROM notes ORDER BY id", []);
          assert.throws(
            () => db.all(step.sql, step.params),
            /unsupported DO|SQL syntax/i,
            step.sql,
          );
          assert.deepEqual(
            native(raw, "SELECT * FROM notes ORDER BY id", []),
            before,
            step.sql,
          );
        } else if (step.nativeError) {
          assert.throws(() =>
            storage(reference).transactionSync(() =>
              native(reference, step.sql, step.params ?? []),
            ),
          );
          assert.throws(() => db.all(step.sql, step.params));
        } else {
          assert.deepEqual(
            db.all(step.sql, step.params),
            native(reference, step.sql, step.params ?? []),
            step.sql,
          );
        }
        assert.deepEqual(
          native(raw, "SELECT * FROM notes ORDER BY id", []),
          native(reference, "SELECT * FROM notes ORDER BY id", []),
        );
      }
    } finally {
      reference.close();
      raw.close();
    }
  });
