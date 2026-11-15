import { test } from "node:test";
import assert from "node:assert/strict";
import { NodeDatabase } from "../adapters/node-database.ts";
import { schemaSignature } from "../src/safety.ts";

test("schema signatures ignore formatting while preserving literal and quoted-identifier differences", () => {
  const signature = (sql: string) => {
    const db = new NodeDatabase(":memory:");
    try {
      db.run(sql);
      return schemaSignature(db);
    } finally {
      db.close();
    }
  };
  const a = signature(
    "CREATE TABLE notes(id TEXT PRIMARY KEY,title TEXT DEFAULT 'Case -- A',score INTEGER CHECK(score>=0))",
  );
  const b = signature(
    "create table notes ( id text primary key, /* formatting */ title text default 'Case -- A', score integer check (score >= 0))",
  );
  assert.equal(a, b);
  assert.notEqual(
    a,
    signature(
      "CREATE TABLE notes(id TEXT PRIMARY KEY,title TEXT DEFAULT 'case -- a',score INTEGER CHECK(score>=0))",
    ),
  );
  assert.notEqual(
    signature('CREATE TABLE notes("Case" TEXT)'),
    signature('CREATE TABLE notes("case" TEXT)'),
  );
});
