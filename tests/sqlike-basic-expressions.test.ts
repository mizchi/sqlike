import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { MoonDatabase, type MoonSqlRuntime } from "../adapters/moon-database.ts";
import { compile_program } from "../_build/js/release/build/mizchi/sqlike/compiler/compiler.js";
import { compareQueries, sqlikePaths } from "./compatibility/sqlike-paths.ts";

const literal = (s: string) =>
  s.includes("\0")
    ? `CAST(x'${Buffer.from(s).toString("hex")}' AS TEXT)`
    : `'${s.replaceAll("'", "''")}'`;

async function candidates() {
  const { instance } = await WebAssembly.instantiate(
    readFileSync("_build/wasm-gc/release/build/mizchi/sqlike/full/full.wasm"),
    {},
    { builtins: ["js-string"], importedStringConstants: "_" },
  );
  return [
    new MoonDatabase(),
    new MoonDatabase(undefined, undefined, instance.exports as unknown as MoonSqlRuntime),
  ];
}

test("GLOB operators and function match SQLite classes, ranges, Unicode, case and NUL on four paths", async () => {
  const patterns = [
    "",
    "*",
    "?",
    "a*",
    "A*",
    "*?*",
    "[a-z]",
    "[z-a]",
    "[a-b-c]",
    "[-a]",
    "[a-]",
    "[]]",
    "[^]]",
    "[]-a]",
    "[^^]",
    "[!a]",
    "[[]",
    "[]",
    "[^]",
    "[abc",
    "*[]",
    "*[^]",
    "**[é-😀]*",
    "é?",
    "*\0ignored",
    "a\\*",
    "*a*b*c*",
  ];
  const inputs = [
    "",
    "a",
    "A",
    "z",
    "b",
    "c",
    "-",
    "]",
    "[",
    "^",
    "!",
    "é",
    "É",
    "é😀",
    "a\0tail",
    "abc",
    "a\\b",
  ];
  await compareQueries(
    inputs.flatMap((s) =>
      patterns.map(
        (p) =>
          `SELECT ${literal(s)} GLOB ${literal(p)},${literal(s)} NOT GLOB ${literal(p)},glob(${literal(p)},${literal(s)})`,
      ),
    ),
  );
  await compareQueries(
    [
      "SELECT NOT 'a' GLOB '*', 'a' GLOB '*' = 1, 'a' GLOB 'a' COLLATE NOCASE",
      "SELECT 1 + 2 GLOB '3', 'a' NOT GLOB 'A' AND 1",
      "SELECT s GLOB 'a*',s GLOB 'A*' FROM t ORDER BY id",
    ],
    ["CREATE TABLE t(id INTEGER PRIMARY KEY,s TEXT COLLATE NOCASE)"],
    ["INSERT INTO t VALUES(1,'abc'),(2,'Abc')"],
  );
});

test("generated GLOB inputs agree with native SQLite without recursive matching", async () => {
  let seed = 0x732a1;
  const next = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  const alphabet = ["a", "b", "A", "*", "?", "[", "]", "^", "-", "é", "😀", "\0"];
  const word = () =>
    Array.from({ length: next() % 12 }, () => alphabet[next() % alphabet.length]).join("");
  const queries = Array.from({ length: 300 }, () => {
    const p = literal(word()),
      s = literal(word());
    return `SELECT glob(${p},${s}),${s} GLOB ${p}`;
  });
  queries.push(`SELECT glob(${literal("*a".repeat(400) + "b")},${literal("a".repeat(600))})`);
  await compareQueries(queries);
});

test("GLOB preserves NULLs, numeric conversion and valid BLOB conversion", async () => {
  const values = [
    "NULL",
    "0",
    "12",
    "12.0",
    "'12'",
    "'*'",
    "'?'",
    "x'3132'",
    "x'2a'",
    "x'00'",
    "x'2a0078'",
  ];
  await compareQueries(
    values.flatMap((a) => values.map((b) => `SELECT glob(${a},${b}),${b} GLOB ${a}`)),
  );
  const long = literal("é".repeat(25001));
  const paths = await sqlikePaths([], [{ name: "q", sql: `SELECT glob(${long},NULL)` }]);
  for (const path of paths) assert.throws(() => path.exec("q"), /pattern too complex/);
});

test("char preserves code points, NUL, SQLite integer conversion and replacement rules", async () => {
  const values = [
    "NULL",
    "0",
    "65",
    "65.9",
    "-0.5",
    "127",
    "128",
    "2047",
    "2048",
    "55295",
    "57344",
    "65535",
    "128512",
    "1114111",
    "1114112",
    "-1",
    "4294967361",
    "9223372036854775807",
    "-9223372036854775808",
    "1e999",
    "-1e999",
    "'1e2'",
    "' 65.9x'",
    "'no'",
    "x'3431'",
    "x'ff'",
    "0.0/0.0",
  ];
  await compareQueries([
    "SELECT char(),typeof(char()),hex(char())",
    "SELECT char(65,0,233,128512),hex(char(65,0,233,128512)),length(char(65,0,233,128512))",
    ...values.map((v) => `SELECT char(${v}),hex(char(${v})),typeof(char(${v}))`),
    "SELECT CASE WHEN 0 THEN char(55296) ELSE 'safe' END",
    "SELECT unicode(char(65534)),unicode(char(65535)),unicode(char(131071))",
    "SELECT glob(char(65535),char(65533)),glob(char(65533),char(65534)),char(65535) LIKE char(65533)",
    "SELECT char(65534) LIKE char(65533) ESCAPE char(65535),glob('[^'||char(65534)||']',char(65533))",
  ]);
});

test("unrepresentable surrogate char inputs reject atomically rather than returning different text bytes", async () => {
  const paths = await sqlikePaths(
    ["CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT)"],
    [
      { name: "seed", sql: "INSERT INTO t VALUES(1,'a'),(2,'b')", write: true },
      {
        name: "bad",
        sql: "UPDATE t SET v=char(CASE WHEN id=1 THEN 65 ELSE 55296 END)",
        write: true,
      },
      { name: "surrogate", sql: "SELECT hex(char(56320))" },
    ],
  );
  for (const path of paths) {
    path.exec("seed");
    const before = path.dump();
    assert.throws(() => path.exec("bad"), /surrogate|Unicode/);
    assert.equal(path.dump(), before);
    assert.throws(() => path.exec("surrogate"), /surrogate|Unicode/);
  }
});

test("hex and separated numeric SQL literals keep signed int64, REAL and parser-free execution", async () => {
  const values = [
    "0x0",
    "0XfF",
    "0x7FFFFFFFFFFFFFFF",
    "0x8000000000000000",
    "0xFFFFFFFFFFFFFFFF",
    "0x000000000000000001",
    "-0xFFFFFFFFFFFFFFFF",
    "-0x8000000000000001",
    "+0x12",
    "-(0x8000000000000000 COLLATE BINARY)",
    "-CAST(0x8000000000000000 AS INTEGER)",
    "0xF_F",
    "0x0_8000_0000_0000_0000",
    "0_1",
    "1_000",
    "9_223_372_036_854_775_807",
    "9_223_372_036_854_775_808",
    "-9_223_372_036_854_775_808",
    "1_2.3_4",
    ".1_2",
    "1_0.",
    "1_2.3_4e+1_0",
    "1e-1_0",
    "1_0e3_0_0",
  ];
  await compareQueries(values.map((v) => `SELECT ${v},typeof(${v})`));
  await compareQueries(
    [
      "SELECT CAST('0xFF' AS INTEGER),CAST('1_000' AS INTEGER),CAST('1_000' AS REAL)",
      "SELECT '0xFF'+0,'1_000'+0,CAST(x'30784646' AS INTEGER)",
      "SELECT v,typeof(v) FROM t ORDER BY id",
    ],
    ["CREATE TABLE t(id INTEGER PRIMARY KEY,v INTEGER DEFAULT 0xF_F)"],
    ["INSERT INTO t(id) VALUES(0_1),(0x2)"],
  );
});

test("new syntax retains source column labels", async () => {
  const native = new DatabaseSync(":memory:");
  const dbs = await candidates();
  const sql = "SELECT 0xF_F,1_000,char(65),'a' GLOB '*'";
  try {
    const names = native
      .prepare(sql)
      .columns()
      .map((c) => c.name);
    for (const db of dbs) assert.deepEqual(Object.keys(db.query(sql)[0]!), names);
  } finally {
    native.close();
    for (const db of dbs) db.close();
  }
});

test("malformed numbers, overflowing hex and negated hex minima reject in raw runtimes and compiler", async () => {
  const native = new DatabaseSync(":memory:");
  const dbs = await candidates();
  try {
    for (const expression of [
      "0x",
      "0x_1",
      "0x1_",
      "0x1__2",
      "0x1g",
      "0x10000000000000000",
      "0x1_0000_0000_0000_0000",
      "-0x8000000000000000",
      "-(+0x8000000000000000)",
      "-0x8000000000000000 COLLATE BINARY",
      "1__0",
      "1_",
      "1_.0",
      "1._0",
      "1e_2",
      "1e+_2",
      "1.2abc",
    ]) {
      const sql = `SELECT ${expression}`;
      assert.throws(() => native.prepare(sql), Error, sql);
      for (const db of dbs) assert.throws(() => db.values(sql), Error, sql);
      const compiled = JSON.parse(
        compile_program(JSON.stringify({ schema: [], queries: [{ name: "q", sql }] })),
      );
      assert.equal(typeof compiled.error, "string", sql);
    }
  } finally {
    native.close();
    for (const db of dbs) db.close();
  }
});

test("function argument limits reject invalid calls while preserving large IN lists", async () => {
  await compareQueries([
    `SELECT char(${Array(1000).fill("65").join(",")})`,
    `SELECT 65 IN(${Array(1100).fill("65").join(",")})`,
  ]);
  const native = new DatabaseSync(":memory:");
  const dbs = await candidates();
  try {
    for (const name of ["char", "concat", "min"]) {
      const sql = `SELECT ${name}(${Array(1001).fill("65").join(",")})`;
      assert.throws(() => native.prepare(sql), /too many arguments/);
      for (const db of dbs) assert.throws(() => db.values(sql), /argument limit/);
      const compiled = JSON.parse(
        compile_program(JSON.stringify({ schema: [], queries: [{ name: "q", sql }] })),
      );
      assert.match(compiled.error ?? "", /argument limit/);
    }
    const invalid = 'SELECT "in"(1,1)';
    assert.throws(() => native.prepare(invalid), /no such function/);
    for (const db of dbs) assert.throws(() => db.values(invalid), /reserved/);
    assert.match(
      JSON.parse(
        compile_program(JSON.stringify({ schema: [], queries: [{ name: "q", sql: invalid }] })),
      ).error ?? "",
      /reserved/,
    );
  } finally {
    native.close();
    for (const db of dbs) db.close();
  }
});
