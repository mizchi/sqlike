import { test } from "node:test";
import assert from "node:assert/strict";
import { eq, sql, and, inArray } from "drizzle-orm";
import { integer, text, real, sqliteTable } from "drizzle-orm/sqlite-core";
import { drizzle, sqliteBytes, sqliteInt64 } from "../adapters/drizzle.ts";
import {
  MoonDatabase,
  type MoonSqlRuntime,
} from "../adapters/moon-database.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { readFileSync } from "node:fs";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { WasmDatabase } from "../adapters/wasm-database.ts";
import type { DrizzleClient } from "../src/drizzle-contract.ts";

const users = sqliteTable("users", {
  id: integer().primaryKey({ autoIncrement: true }),
  name: text().notNull().unique(),
  active: integer({ mode: "boolean" }).notNull().default(true),
  created: integer({ mode: "timestamp_ms" }).notNull(),
  meta: text({ mode: "json" }).$type<{ n: number }>(),
  score: real(),
  bytes: sqliteBytes(),
  wide: sqliteInt64(),
});
const posts = sqliteTable("posts", {
  id: integer().primaryKey(),
  user: integer().references(() => users.id),
  title: text(),
});
const schema = { users, posts };
const date = new Date("2026-01-02T03:04:05.000Z");
test("Drizzle CRUD, RETURNING, placeholders and duplicate JOIN columns agree on native/JS/Wasm", async () => {
  const wasm = (
    await WebAssembly.instantiate(
      readFileSync("_build/wasm-gc/release/build/mizchi/sqlike/full/full.wasm"),
      {},
      { builtins: ["js-string"], importedStringConstants: "_" },
    )
  ).instance.exports as unknown as MoonSqlRuntime;
  const clients: (DrizzleClient & { close(): void })[] = [
    new NodeDatabase(":memory:"),
    new MoonDatabase(),
    new MoonDatabase(undefined, undefined, wasm),
  ];
  const sqlite = await sqlite3InitModule(),
    official = new WasmDatabase(sqlite, new sqlite.oo1.DB(":memory:"));
  official.run("PRAGMA foreign_keys=ON");
  clients.push(Object.assign(official, { close: () => official.raw.close() }));
  try {
    const observations = clients.map((client) => {
      client.run(
        "CREATE TABLE users(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE,active INTEGER NOT NULL DEFAULT 1,created INTEGER NOT NULL,meta TEXT,score REAL,bytes BLOB,wide INTEGER)",
      );
      client.run(
        "CREATE TABLE posts(id INTEGER PRIMARY KEY,user INTEGER REFERENCES users(id),title TEXT)",
      );
      const db = drizzle(client, { schema });
      const output: unknown[] = [];
      output.push(
        db
          .insert(users)
          .values({
            name: "\ufeffone\0",
            created: date,
            active: true,
            meta: { n: 1 },
            score: 1,
            bytes: new Uint8Array([0, 255]),
            wide: 9223372036854775807n,
          })
          .returning()
          .get(),
      );
      output.push(
        db
          .insert(users)
          .values({ name: "two", created: date })
          .returning({ id: users.id, title: users.name })
          .all(),
      );
      output.push(
        db
          .insert(users)
          .values({ name: "two", created: date })
          .onConflictDoNothing()
          .returning()
          .all(),
      );
      output.push(
        db
          .insert(users)
          .values({ name: "two", created: date })
          .onConflictDoUpdate({ target: users.name, set: { score: 2.5 } })
          .returning({ id: users.id, score: users.score })
          .get(),
      );
      assert.throws(() =>
        client.run(
          "INSERT INTO users(name,created) VALUES('bad',0) ON CONFLICT(other.name) DO UPDATE SET name='bad'",
        ),
      );
      db.insert(posts).values({ id: 7, user: 1, title: "post" }).run();
      output.push(
        db
          .select({ user: users, post: posts })
          .from(users)
          .leftJoin(posts, eq(users.id, posts.user))
          .orderBy(users.id)
          .all(),
      );
      output.push(
        db
          .update(users)
          .set({ score: sql`${users.score}+1` })
          .where(eq(users.id, 1))
          .returning({
            id: users.id,
            upper: sql<string>`upper(${users.name})`.mapWith(String),
            next: sql<number>`${users.score}+1`.mapWith(Number),
          })
          .get(),
      );
      const prepared = db
        .select({ name: users.name, wide: users.wide })
        .from(users)
        .where(eq(users.id, sql.placeholder("id")))
        .prepare();
      output.push(prepared.get({ id: 1 }));
      output.push(
        db
          .select({ id: users.id })
          .from(users)
          .where(and(inArray(users.id, [1, 2]), eq(users.active, true)))
          .orderBy(users.id)
          .all(),
      );
      output.push(db.delete(users).where(eq(users.id, 2)).returning().all());
      assert.deepEqual(output[0], {
        id: 1,
        name: "\ufeffone\0",
        active: true,
        created: date,
        meta: { n: 1 },
        score: 1,
        bytes: new Uint8Array([0, 255]),
        wide: 9223372036854775807n,
      });
      assert.equal(
        db.select().from(users).where(eq(users.id, 99)).get(),
        undefined,
      );
      return output;
    });
    for (const observation of observations.slice(1))
      assert.deepEqual(observation, observations[0]);
  } finally {
    for (const client of clients) client.close();
  }
});

test("Drizzle transaction/nested rollback and unsafe number RETURNING never publish rejected rows", () => {
  for (const client of [new NodeDatabase(":memory:"), new MoonDatabase()]) {
    try {
      client.run(
        "CREATE TABLE users(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE,active INTEGER NOT NULL DEFAULT 1,created INTEGER NOT NULL,meta TEXT,score REAL,bytes BLOB,wide INTEGER)",
      );
      client.run(
        "CREATE TABLE posts(id INTEGER PRIMARY KEY,user INTEGER REFERENCES users(id),title TEXT)",
      );
      const db = drizzle(client, { schema });
      db.transaction((tx) => {
        tx.insert(users).values({ name: "kept", created: date }).run();
        assert.throws(() =>
          tx.transaction((nested) => {
            nested
              .insert(users)
              .values({ name: "rolled back", created: date })
              .run();
            nested.rollback();
          }),
        );
        tx.insert(users).values({ name: "also kept", created: date }).run();
      });
      assert.deepEqual(
        db.select({ name: users.name }).from(users).orderBy(users.id).all(),
        [{ name: "kept" }, { name: "also kept" }],
      );
      assert.throws(() =>
        db.transaction((tx) => {
          tx.insert(users)
            .values({ name: "outer rollback", created: date })
            .run();
          throw Error("stop");
        }),
      );
      assert.throws(
        () =>
          db
            .insert(users)
            .values({
              id: sql`9007199254740993`,
              name: "unsafe",
              created: date,
            })
            .returning()
            .all(),
        /safe integer/,
      );
      db.transaction((tx) => {
        assert.throws(
          () =>
            tx
              .insert(users)
              .values({
                id: sql`9007199254740993`,
                name: "caught unsafe",
                created: date,
              })
              .returning()
              .all(),
          /safe integer/,
        );
        assert.equal(
          tx.select().from(users).where(eq(users.name, "caught unsafe")).get(),
          undefined,
        );
      });
      assert.throws(
        () =>
          db.transaction(async (tx) => {
            tx.insert(users).values({ name: "async", created: date }).run();
          }),
        /synchronous/,
      );
      assert.deepEqual(
        db.select({ name: users.name }).from(users).orderBy(users.id).all(),
        [{ name: "kept" }, { name: "also kept" }],
      );
    } finally {
      client.close();
    }
  }
});
