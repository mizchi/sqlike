import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeDatabase } from "../adapters/node-database.ts";
import { MoonDatabase } from "../adapters/moon-database.ts";
import { SyncEngine } from "../src/engine.ts";
import { bootstrapSafety } from "../src/safety.ts";
import type { Value } from "../src/contract.ts";

function fixture(
  options: { size?: number; encoding?: string; vacuum?: string } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "moon-sqlite-file-"));
  const path = join(directory, "source.sqlite");
  const db = new NodeDatabase(path);
  db.raw.exec(
    `PRAGMA journal_mode=DELETE; PRAGMA page_size=${options.size ?? 512}; PRAGMA encoding='${options.encoding ?? "UTF-8"}'; PRAGMA auto_vacuum=${options.vacuum ?? "NONE"}; VACUUM;`,
  );
  return {
    db,
    image: () => new Uint8Array(readFileSync(path)),
    close() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
function equalQuery(
  native: NodeDatabase,
  moon: MoonDatabase,
  sql: string,
  params: Value[] = [],
) {
  assert.deepEqual(
    moon.all(sql, params),
    native
      .all(sql, params)
      .map((row) => Object.fromEntries(Object.entries(row))),
    sql,
  );
}

for (const options of [
  { size: 512 },
  { size: 4096 },
  { size: 65536 },
  { size: 512, encoding: "UTF-16le" },
  { size: 1024, encoding: "UTF-16be" },
]) {
  test(`pure MoonBit reads SQLite serial values, rowids, encodings and overflow: ${JSON.stringify(options)}`, () => {
    const f = fixture(options);
    try {
      f.db.run(
        "CREATE TABLE typed(id INTEGER PRIMARY KEY,n INTEGER,r REAL,t TEXT,b BLOB)",
      );
      const integers = [
        -9223372036854775808n,
        -140737488355329n,
        -2147483649n,
        -8388609n,
        -32769n,
        -129n,
        -1n,
        0n,
        1n,
        127n,
        32767n,
        8388607n,
        2147483647n,
        140737488355327n,
        9223372036854775807n,
      ];
      f.db.transaction(() => {
        for (const [i, n] of integers.entries())
          f.db.run("INSERT INTO typed VALUES(?,?,?,?,?)", [
            BigInt(i) - 7n,
            n,
            i % 2 ? 42 : 1.25,
            i % 3 ? "\ufeff日本語😀\0" : "large😀".repeat(1500),
            new Uint8Array(i % 3 ? 0 : 9000).fill(255),
          ]);
      });
      f.db.run("ALTER TABLE typed ADD COLUMN added INTEGER NOT NULL DEFAULT 7");
      const moon = MoonDatabase.fromSQLite(f.image());
      equalQuery(
        f.db,
        moon,
        "SELECT rowid,id,n,typeof(n),r,typeof(r),t,b,added FROM typed ORDER BY id",
      );
      moon.run("UPDATE typed SET t='local' WHERE id=0");
      assert.notEqual(
        f.db.all("SELECT t FROM typed WHERE id=0")[0]!.t,
        "local",
      );
      const reopened = new MoonDatabase(moon.dump());
      equalQuery(f.db, reopened, "SELECT id,n FROM typed ORDER BY id");
    } finally {
      f.close();
    }
  });
}

test("pure MoonBit traverses table/index interiors and WITHOUT ROWID records in primary-key storage order", () => {
  const f = fixture({ vacuum: "FULL" });
  try {
    f.db.raw.exec(
      "CREATE TABLE ordinary(id INTEGER PRIMARY KEY,v TEXT UNIQUE,n INTEGER); CREATE TABLE composite(v TEXT,b INTEGER NOT NULL,a TEXT NOT NULL,PRIMARY KEY(a,b)) WITHOUT ROWID; CREATE INDEX by_n ON ordinary(n);",
    );
    f.db.transaction(() => {
      for (let i = 0; i < 1200; i++) {
        f.db.run("INSERT INTO ordinary VALUES(?,?,?)", [
          BigInt(i) - 600n,
          `item${i.toString().padStart(5, "0")}`,
          i,
        ]);
        f.db.run("INSERT INTO composite VALUES(?,?,?)", [
          `payload${i}` + "😀".repeat(i % 10),
          i % 11,
          `key${i.toString().padStart(6, "0")}`,
        ]);
      }
    });
    f.db.raw.exec(
      "DELETE FROM ordinary WHERE n%3=0; DELETE FROM composite WHERE b=7; PRAGMA incremental_vacuum;",
    );
    const moon = MoonDatabase.fromSQLite(f.image());
    equalQuery(f.db, moon, "SELECT * FROM ordinary ORDER BY id");
    equalQuery(f.db, moon, "SELECT * FROM composite ORDER BY a,b");
    assert.throws(
      () => moon.run("INSERT INTO ordinary VALUES(99999,'item00001',0)"),
      /UNIQUE/,
    );
  } finally {
    f.close();
  }
});

test("pure MoonBit reads native AUTOINCREMENT high-water marks and the complete synchronization snapshot", () => {
  const f = fixture();
  try {
    const engine = new SyncEngine(f.db, true);
    f.db.raw.exec(
      "CREATE TABLE monotonic(id INTEGER PRIMARY KEY AUTOINCREMENT,v TEXT); INSERT INTO monotonic VALUES(100,'deleted'); DELETE FROM monotonic; INSERT INTO notes(id,title,score) VALUES('one','native',42);",
    );
    bootstrapSafety(f.db, true);
    engine.schema();
    const moon = MoonDatabase.fromSQLite(f.image());
    moon.run("INSERT INTO monotonic(v) VALUES('next')");
    assert.equal(moon.all("SELECT id FROM monotonic")[0]!.id, 101n);
    assert.deepEqual(
      new MoonDatabase().snapshotOf(f.image()),
      engine.snapshot(),
    );
  } finally {
    f.close();
  }
});

test("SQLite image rejection is atomic for corrupt headers, cells, page ownership and overflow chains", () => {
  const f = fixture();
  try {
    f.db.run("CREATE TABLE large(id INTEGER PRIMARY KEY,v BLOB)");
    f.db.run("INSERT INTO large VALUES(1,?)", [new Uint8Array(10000).fill(7)]);
    const image = f.image();
    assert.ok(MoonDatabase.fromSQLite(image));
    const root = Number(
      f.db.all("SELECT rootpage FROM sqlite_schema WHERE name='large'")[0]!
        .rootpage,
    );
    const start = (root - 1) * 512;
    const candidates = [image.subarray(0, 99), image.subarray(0, -1)];
    for (const [offset, value] of [
      [0, 0],
      [16, 0],
      [18, 9],
      [21, 63],
      [56, 0xff],
      [start, 0],
      [start + 3, 0xff],
      [start + 8, 0],
      [start + 9, 1],
    ] as const) {
      const copy = image.slice();
      copy[offset] = copy[offset] === value ? value ^ 0xff : value;
      candidates.push(copy);
    }
    // Overflow self-reference must be rejected rather than looping forever.
    const overflow = image.slice();
    new DataView(overflow.buffer).setUint32(2 * 512, 3);
    candidates.push(overflow);
    for (const invalid of candidates)
      assert.throws(
        () => MoonDatabase.fromSQLite(invalid),
        /SQLite|image|corrupt|truncated|unsupported/,
        `offset/length ${invalid.length}`,
      );
  } finally {
    f.close();
  }
});

for (const encoding of ["UTF-8", "UTF-16le", "UTF-16be"])
  test(`BINARY collation preserves ${encoding} file order, scalar comparisons and MIN/MAX`, () => {
    const f = fixture({ encoding });
    try {
      f.db.raw.exec(
        "CREATE TABLE words(v TEXT PRIMARY KEY NOT NULL) WITHOUT ROWID; CREATE INDEX words_v ON words(v);",
      );
      for (const v of ["😀", "\ue000", "a", "A"])
        f.db.run("INSERT INTO words VALUES(?)", [v]);
      const moon = MoonDatabase.fromSQLite(f.image());
      for (const sql of [
        "SELECT * FROM words ORDER BY v",
        "SELECT * FROM words ORDER BY v COLLATE NOCASE",
        "SELECT min(v),max(v) FROM words",
        "SELECT v FROM words WHERE v>'a' ORDER BY v",
      ])
        equalQuery(f.db, moon, sql);
      equalQuery(
        f.db,
        new MoonDatabase(moon.dump()),
        "SELECT * FROM words ORDER BY v",
      );
    } finally {
      f.close();
    }
  });
