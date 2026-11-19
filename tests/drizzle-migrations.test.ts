import { test } from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "../adapters/drizzle.ts";
import { migrate } from "../adapters/drizzle-migrator.ts";
import { migrations } from "./fixtures/drizzle/migrations.generated.ts";
import {
  MoonDatabase,
  type MoonSqlRuntime,
} from "../adapters/moon-database.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { readFileSync } from "node:fs";
import { sha256 } from "../src/aot-values.ts";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { WasmDatabase } from "../adapters/wasm-database.ts";
import { migrate as migrateFiles } from "../adapters/drizzle-node.ts";
import { readMigrationFiles } from "drizzle-orm/migrator";

test("Kit-generated migration chain preserves rows/FK through every rebuild, rename, reopen and rerun on native/JS/Wasm", async () => {
  const wasm = (
    await WebAssembly.instantiate(
      readFileSync("_build/wasm-gc/release/build/mizchi/sqlike/full/full.wasm"),
      {},
      { builtins: ["js-string"], importedStringConstants: "_" },
    )
  ).instance.exports as unknown as MoonSqlRuntime;
  const observed = [];
  const sqlite = await sqlite3InitModule();
  for (const engine of ["native", "js", "wasm", "sqlite-wasm"]) {
    const official = new WasmDatabase(sqlite, new sqlite.oo1.DB(":memory:"));
    official.run("PRAGMA foreign_keys=ON");
    let client =
      engine === "native"
        ? new NodeDatabase(":memory:")
        : engine === "sqlite-wasm"
          ? Object.assign(official, { close: () => official.raw.close() })
          : new MoonDatabase(
              undefined,
              undefined,
              engine === "wasm" ? wasm : undefined,
            );
    if (engine !== "sqlite-wasm") official.raw.close();
    try {
      const states = [];
      for (let i = 0; i < migrations.length; i++) {
        const db = drizzle(client);
        try {
          await migrate(db, migrations.slice(0, i + 1));
        } catch (e) {
          throw Error(
            `${engine} migration ${i}: ${(e as Error).message}; SQL: ${(e as { statement?: string }).statement}`,
            { cause: e },
          );
        }
        if (i === 0) {
          client.run(
            "INSERT INTO users(id,name,email,score,legacy) VALUES(1,'one','one@example.test',2,'old'),(2,'two','two@example.test',3,'old')",
          );
          client.run(
            "INSERT INTO posts VALUES(7,1,'kept child'),(8,2,'also kept')",
          );
        }
        const table = i >= 6 ? "members" : "users",
          name = i >= 6 ? "display_name" : "name";
        states.push({
          rows: client.values(
            `SELECT id,${name},email,score FROM ${table} ORDER BY id`,
          ),
          children: client.values("SELECT * FROM posts ORDER BY id"),
          fk: client.values("PRAGMA foreign_key_check"),
          mode: client.values("PRAGMA foreign_keys"),
          columns: client.values(`PRAGMA table_info(${table})`),
        });
        assert.deepEqual(client.values("SELECT * FROM posts ORDER BY id"), [
          [7n, 1n, "kept child"],
          [8n, 2n, "also kept"],
        ]);
        assert.equal(
          client.values("SELECT count(*) FROM __drizzle_migrations")[0]![0],
          BigInt(i + 1),
        );
        await migrate(db, migrations.slice(0, i + 1));
        assert.equal(
          client.values("SELECT count(*) FROM __drizzle_migrations")[0]![0],
          BigInt(i + 1),
        );
        if (client instanceof MoonDatabase) {
          const image = client.dump();
          client.close();
          client = new MoonDatabase(
            image,
            undefined,
            engine === "wasm" ? wasm : undefined,
          );
        }
      }
      client.run(
        "INSERT INTO members(id,display_name,email,score) VALUES(3,'three','three@example.test',1)",
      );
      assert.deepEqual(client.values("SELECT member_id,event FROM audit"), [
        [3n, "insert"],
      ]);
      assert.deepEqual(
        client.values("SELECT * FROM member_names ORDER BY id"),
        [
          [1n, "one"],
          [2n, "two"],
          [3n, "three"],
        ],
      );
      observed.push(states);
    } finally {
      client.close();
    }
  }
  for (const states of observed.slice(1)) assert.deepEqual(states, observed[0]);
});

test("official Kit journal reader equals browser metadata and fresh migration is idempotent", async () => {
  const config = { migrationsFolder: "tests/fixtures/drizzle/migrations" };
  assert.deepEqual(readMigrationFiles(config), migrations);
  for (const client of [new NodeDatabase(":memory:"), new MoonDatabase()])
    try {
      const db = drizzle(client);
      assert.deepEqual(await migrateFiles(db, config), { applied: 8 });
      assert.deepEqual(await migrateFiles(db, config), { applied: 0 });
      assert.deepEqual(
        client.values("SELECT count(*) FROM __drizzle_migrations"),
        [[8n]],
      );
      assert.throws(
        () => db.transaction(() => migrate(db, migrations)),
        /idle/,
      );
    } finally {
      client.close();
    }
});

test("migration failure rolls back schema/data/journal, restores FK and rejects history drift", async () => {
  for (const client of [new NodeDatabase(":memory:"), new MoonDatabase()]) {
    try {
      const db = drizzle(client);
      await migrate(db, migrations.slice(0, 1));
      client.run(
        "INSERT INTO users VALUES(1,'one','one@example.test',1,'old')",
      );
      const before = client.values(
        "SELECT name,sql FROM sqlite_schema ORDER BY name",
      );
      const statements = [
        "PRAGMA foreign_keys=OFF;",
        "CREATE TABLE should_rollback(n INTEGER)",
        "INSERT INTO users(id,name,email) VALUES(1,'duplicate','duplicate')",
        "PRAGMA foreign_keys=ON;",
      ];
      const failed = {
        sql: statements,
        hash: await sha256(statements.join("--> statement-breakpoint")),
        folderMillis: migrations[0]!.folderMillis + 1,
        bps: true,
      };
      await assert.rejects(
        migrate(db, [migrations[0]!, failed]),
        /constraint/i,
      );
      assert.deepEqual(
        client.values("SELECT name,sql FROM sqlite_schema ORDER BY name"),
        before,
      );
      assert.deepEqual(client.values("PRAGMA foreign_keys"), [[1n]]);
      assert.equal(
        client.values("SELECT count(*) FROM __drizzle_migrations")[0]![0],
        1n,
      );
      const changed = {
        ...migrations[0]!,
        sql: ["CREATE TABLE unexpected(n)"],
        hash: await sha256("CREATE TABLE unexpected(n)"),
      };
      await assert.rejects(migrate(db, [changed]), /history|hash|drift/);
      await assert.rejects(
        migrate(db, [{ ...migrations[0]!, hash: "0".repeat(64) }]),
        /hash/,
      );
      assert.deepEqual(
        client.values("SELECT name,sql FROM sqlite_schema ORDER BY name"),
        before,
      );
    } finally {
      client.close();
    }
  }
});

test("captured Kit expression-index rebuild bug rejects on native and SQLike instead of becoming a different index", () => {
  const sql = readFileSync(
    "tests/fixtures/drizzle/kit-0.31.11-invalid-index.sql",
    "utf8",
  );
  for (const db of [new NodeDatabase(":memory:"), new MoonDatabase()]) {
    try {
      db.run("CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT)");
      assert.throws(() => db.run(sql));
      assert.deepEqual(
        db.values("SELECT name FROM sqlite_schema WHERE type='index'"),
        [],
      );
    } finally {
      db.close();
    }
  }
});

test("custom migration chunks execute all statements including CASE/semicolon trigger bodies", async () => {
  const text = `-- no Kit breakpoint needed inside a custom SQL file
CREATE TABLE custom(id INTEGER PRIMARY KEY,n TEXT);
CREATE TABLE audit_custom(n TEXT);
CREATE TRIGGER custom_added AFTER INSERT ON custom BEGIN
  INSERT INTO audit_custom VALUES(CASE WHEN new.n=';' THEN 'case;end' ELSE new.n END);
  INSERT INTO audit_custom VALUES('second;statement');
END;
INSERT INTO custom VALUES(1,';');`;
  const migration = {
    sql: [text],
    hash: await sha256(text),
    folderMillis: 1,
    bps: false,
  };
  for (const client of [new NodeDatabase(":memory:"), new MoonDatabase()])
    try {
      await migrate(drizzle(client), [migration]);
      assert.deepEqual(client.values("SELECT n FROM audit_custom"), [
        ["case;end"],
        ["second;statement"],
      ]);
      const bad =
        "CREATE TABLE should_not_exist(n); COMMIT; CREATE TABLE also_missing(n);";
      await assert.rejects(
        migrate(drizzle(client), [
          migration,
          { sql: [bad], hash: await sha256(bad), folderMillis: 2, bps: false },
        ]),
        /outer transaction/,
      );
      assert.deepEqual(
        client.values(
          "SELECT name FROM sqlite_schema WHERE name='should_not_exist'",
        ),
        [],
      );
    } finally {
      client.close();
    }
});
