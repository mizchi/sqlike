import { test } from "node:test";
import assert from "node:assert/strict";
import { compareSixQueries, sixPaths } from "./compatibility/six-paths.ts";
import { MoonDatabase } from "../adapters/moon-database.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { WasmDatabase } from "../adapters/wasm-database.ts";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";

test("format and printf integer/string substitutions match native SQLite on six paths", async () => {
  const queries = [
    "SELECT format(),printf(),format(NULL),format('%d'),format('%s/%q/%Q/%w/%c',NULL,NULL,NULL,NULL,NULL)",
    "SELECT format('%s',''),format('%n'),format('%q',''),format('%Q',''),format('%w',''),format('abc%'),format('%')",
    "SELECT format('%q/%Q/%w','a''b\"c','a''b\"c','a''b\"c')",
    "SELECT printf('%c|%.3c|%5c','😀x','あ',NULL),hex(format('%c',NULL))",
    "SELECT format('%n%d',123,456),format('%c',123),format('%d','1e3'),format('%d','x')",
    "SELECT format('%.*s',-2,'abc'),format('%*d',-5,3),format('%!5s|%5s','あ','あ')",
    "SELECT format('%.2q|%.2Q|%.2w','a''bc','a''bc','a\"bc'),format('%10Q','x')",
    "SELECT format('%lld|%ld|%lli',9007199254740993,9007199254740993,9007199254740993)",
    "SELECT format('%.*d|%.*c',-3,1,-3,'a'),format('%!.2q','あいう')",
    "SELECT format('%d|%d|%d',1e100,-1e100,'9223372036854775808')",
  ];
  for (const type of ["d", "i", "u", "x", "X", "o", "p"]) {
    for (const flags of ["", "+", " ", "#", "-", "0", "-0", ",", "0,", "+,"]) {
      for (const spec of ["", "8", ".0", "8.3"]) {
        const format = quote(`%${flags}${spec}${type}`);
        queries.push(
          `SELECT ${[-9223372036854775808n, -42n, 0n, 1n, 1234567n, 9223372036854775807n].map((n) => `format(${format},${n})`).join(",")}`,
        );
      }
    }
  }
  for (const type of ["s", "z", "q", "Q", "w", "c", "%"]) {
    for (const spec of ["", "8", "-8", "08", "8.2", "!8.2"]) {
      const format = quote(`%${spec}${type}`);
      const inputs = ["NULL", quote("abc"), quote("a'\"b"), "123"];
      if (spec !== "8.2" || type === "c" || type === "%")
        inputs.push(quote("あいう"));
      queries.push(
        `SELECT ${inputs.map((v) => `format(${format},${v})`).join(",")}`,
      );
    }
  }
  await compareSixQueries(queries);
});

test("empty format strings reject across six paths because pinned SQLite versions disagree", async () => {
  const native = new NodeDatabase(":memory:");
  const sqlite = await sqlite3InitModule();
  const official = new WasmDatabase(sqlite, new sqlite.oo1.DB(":memory:"));
  try {
    const version = String(
      native.raw.prepare("SELECT sqlite_version() v").get()!.v,
    );
    if (version === "3.53.4")
      assert.equal(native.raw.prepare("SELECT format('') v").get()!.v, null);
    assert.deepEqual(official.values("SELECT format('')"), [[""]]);
  } finally {
    native.close();
    official.raw.close();
  }
  const paths = await sixPaths(
    ["CREATE TABLE t(v TEXT)"],
    [
      { name: "write", sql: "INSERT INTO t VALUES(format(?1))", write: true },
      { name: "read", sql: "SELECT * FROM t" },
    ],
  );
  try {
    for (const db of paths) {
      for (const value of ["", "\0trailing"]) {
        await assert.rejects(
          db.execute("write", [value]),
          /unsupported.*empty format/,
        );
        assert.deepEqual(await db.execute("read"), []);
      }
      await db.execute("write", ["%s"]);
      assert.deepEqual(await db.execute("read"), [[""]]);
    }
  } finally {
    await Promise.all(paths.map((p) => p.close()));
  }
});

test("format rejects unsupported conversions, invalid UTF-8 slices and excessive output atomically", () => {
  const db = new MoonDatabase();
  try {
    db.run("CREATE TABLE t(v TEXT)");
    for (const expression of [
      "format('%f',1.2)",
      "format('%j','a')",
      "format('%#Q','a')",
      "format('%.1s','あ')",
      "format('%s',x'ff')",
      "format('%k','a')",
      "format('%10000000d',1)",
      "format('%.*s',-9223372036854775808,'a')",
    ]) {
      assert.throws(
        () => db.run(`INSERT INTO t VALUES(${expression})`),
        /unsupported|format.*limit/,
        expression,
      );
      assert.deepEqual(db.values("SELECT * FROM t"), []);
    }
  } finally {
    db.close();
  }
});
