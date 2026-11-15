import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDefinedCatalog } from "../scripts/defined-compiler.ts";
import { DefinedDatabase } from "../adapters/defined-database.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import type { CatalogSource } from "../src/aot-contract.ts";
import type { Value } from "../src/contract.ts";

const source: CatalogSource = {
  schema: [
    "CREATE TABLE parent(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE CHECK(length(name)>0),score REAL NOT NULL DEFAULT 0,payload BLOB)",
    "CREATE INDEX score_feed ON parent(score,id DESC)",
    "CREATE TABLE child(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES parent(id) ON UPDATE CASCADE ON DELETE CASCADE)",
    "CREATE TABLE audit(id INTEGER PRIMARY KEY,parent_id INTEGER,event TEXT)",
    "CREATE TRIGGER parent_added AFTER INSERT ON parent BEGIN INSERT INTO audit(parent_id,event) VALUES(new.id,'insert'); END",
  ],
  queries: [
    {
      name: "insert",
      sql: "INSERT INTO parent(name,score,payload) VALUES(?,?,?) RETURNING id,name,score,payload",
    },
    { name: "child", sql: "INSERT INTO child VALUES(?,?)" },
    {
      name: "update",
      sql: "UPDATE parent SET id=?,score=score+1 WHERE id=? RETURNING id,score",
    },
    {
      name: "read",
      sql: "SELECT p.id,p.name,p.score,p.payload,c.id FROM parent p LEFT JOIN child c ON c.parent_id=p.id ORDER BY p.id,c.id",
    },
    { name: "audit", sql: "SELECT parent_id,event FROM audit ORDER BY id" },
    { name: "delete", sql: "DELETE FROM parent WHERE id=? RETURNING id,name" },
    { name: "begin", sql: "BEGIN" },
    { name: "commit", sql: "COMMIT" },
    { name: "rollback", sql: "ROLLBACK" },
  ],
};
test("predefined binary DDL and named statements preserve native typed rows, constraints, triggers/FK and reopen", async () => {
  const catalog = buildDefinedCatalog(source);
  const db = await DefinedDatabase.memory(catalog),
    native = new NodeDatabase(":memory:");
  try {
    for (const sql of source.schema) native.run(sql);
    for (const [name, params] of [
      ["insert", ["\ufeffone\0", 1, new Uint8Array([0, 255])]],
      ["child", [7n, 1n]],
      ["update", [9007199254740993n, 1n]],
      ["read", []],
      ["audit", []],
    ] as [string, Value[]][]) {
      const result = await db.execute(name, params);
      assert.deepEqual(
        result.rows,
        native.values(source.queries.find((q) => q.name === name)!.sql, params),
      );
    }
    const before = await db.prepare("read").all();
    await assert.rejects(db.execute("insert", ["", 2, null]), /CHECK/);
    assert.deepEqual(await db.prepare("read").all(), before);
    const image = await db.snapshot();
    assert.equal(
      Buffer.from(image).includes(Buffer.from("CREATE TABLE")),
      false,
    );
    assert.equal(
      Buffer.from(image).includes(Buffer.from("parent_added")),
      false,
    );
    const reopened = await DefinedDatabase.memory(catalog, { image });
    try {
      assert.deepEqual(await reopened.prepare("read").all(), before);
      assert.deepEqual(
        (await reopened.execute("delete", [9007199254740993n])).rows,
        native.values(source.queries.find((q) => q.name === "delete")!.sql, [
          9007199254740993n,
        ]),
      );
      assert.deepEqual(await reopened.prepare("read").all(), []);
      await assert.rejects(
        reopened.execute("SELECT * FROM parent"),
        /query|statement/i,
      );
    } finally {
      await reopened.close();
    }
    const added = buildDefinedCatalog({
      ...source,
      queries: [
        ...source.queries,
        { name: "count", sql: "SELECT count(*) FROM parent" },
        { name: "info", sql: "PRAGMA table_info(parent)" },
      ],
    });
    assert.equal(catalog.manifest.schemaId, added.manifest.schemaId);
    const updated = await DefinedDatabase.memory(added, { image });
    try {
      assert.deepEqual(await updated.prepare("count").all(), [[1n]]);
    } finally {
      await updated.close();
    }
  } finally {
    await db.close();
    native.close();
  }
});

test("binary schema/program checksums, schema identity and damaged snapshots reject before use", async () => {
  const catalog = buildDefinedCatalog(source);
  const bad = catalog.schema.slice();
  bad[bad.length - 1] = bad[bad.length - 1]! ^ 1;
  await assert.rejects(
    DefinedDatabase.memory({ ...catalog, schema: bad }),
    /hash|checksum/,
  );
  const other = buildDefinedCatalog({
    ...source,
    schema: [...source.schema, "CREATE TABLE other(n INTEGER)"],
  });
  await assert.rejects(
    DefinedDatabase.memory({
      ...catalog,
      statements: other.statements,
      manifest: {
        ...catalog.manifest,
        statementsSHA256: other.manifest.statementsSHA256,
      },
    }),
    /schema/,
  );
  const db = await DefinedDatabase.memory(catalog);
  try {
    const image = await db.snapshot();
    for (const end of [0, 1, 16, image.length - 1])
      await assert.rejects(
        DefinedDatabase.memory(catalog, { image: image.slice(0, end) }),
        /header|checksum|length/,
      );
  } finally {
    await db.close();
  }
});
