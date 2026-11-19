import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const version: string = JSON.parse(readFileSync("package.json", "utf8")).version;

test("baseline, full and parser-free AOT are distinct portable MoonBit package contracts", () => {
  const dir = mkdtempSync(join(tmpdir(), "sqlike-entrypoints-")),
    consumer = join(dir, "consumer");
  mkdirSync(consumer);
  try {
    writeFileSync(
      join(dir, "moon.work"),
      `members = [${JSON.stringify(resolve("packages/sqlike"))}, "consumer"]\n`,
    );
    writeFileSync(
      join(consumer, "moon.mod"),
      `name = "test/entries"\nversion = "0.0.1"\nimport { "mizchi/sqlike@${version}" }\n`,
    );
    writeFileSync(
      join(consumer, "moon.pkg"),
      'import { "mizchi/sqlike" @base, "mizchi/sqlike/full" @full, "mizchi/sqlike/aot" @aot, "mizchi/sqlike/compiler" }\n',
    );
    writeFileSync(
      join(consumer, "entry_test.mbt"),
      String.raw`
test "three contracts" {
  let baseline = @base.Connection::open(":memory:")
  let basic = baseline.prepare("SELECT ?+1")
  basic.bind(index=1, 7L)
  assert_true(basic.step())
  let n : Int64 = basic.column(index=0)
  assert_eq(n, 8L)
  basic.finalize()
  for sql in [
    "PRAGMA foreign_keys=ON",
    "CREATE TABLE parent(id INTEGER PRIMARY KEY) STRICT",
    "CREATE TABLE child(id INTEGER PRIMARY KEY,pid INTEGER REFERENCES parent(id),name TEXT) STRICT",
    "CREATE UNIQUE INDEX child_name ON child(name)",
    "INSERT INTO parent VALUES(1)",
    "INSERT INTO child VALUES(1,1,'ok')",
    "BEGIN", "INSERT INTO parent VALUES(2)", "ROLLBACK",
  ] {
    let s=baseline.prepare(sql)
    ignore(s.step())
    s.finalize()
  }
  let joined=baseline.prepare("SELECT c.name,count(*) FROM child c JOIN parent p ON c.pid=p.id GROUP BY c.name")
  assert_true(joined.step())
  let name : String=joined.column(index=0)
  let count : Int64=joined.column(index=1)
  assert_eq(name,"ok")
  assert_eq(count,1L)
  joined.finalize()
  for sql in ["INSERT INTO parent VALUES('bad')","INSERT INTO child VALUES(2,2,'missing')","INSERT INTO child VALUES(3,1,'ok')"] {
    assert_true(try {
      let s=baseline.prepare(sql)
      defer s.finalize()
      ignore(s.step())
      false
    } catch { _ => true })
  }
  assert_true(try {
    let heavy = baseline.prepare("SELECT json_array(1)")
    defer heavy.finalize()
    ignore(heavy.step())
    false
  } catch { _ => true })
  baseline.close()
  let full = @full.Connection::open(":memory:")
  let json = full.prepare("SELECT json_array(1)")
  assert_true(json.step())
  let text : String = json.column(index=0)
  assert_eq(text, "[1]")
  json.finalize()
  full.close()
  let artifact = @compiler.compile_program("{\"schema\":[],\"queries\":[{\"name\":\"q\",\"sql\":\"SELECT ?+1\"}]}")
  let program = @aot.Program::load(artifact)
  let db = @aot.Connection::from_program(program)
  let q = db.prepare("q")
  q.bind(index=1, 41L)
  assert_true(q.step())
  let value : Int64 = q.column(index=0)
  assert_eq(value,42L)
  q.finalize()
  assert_true(try { ignore(db.prepare("SELECT 1")); false } catch { _ => true })
  db.close()
}
`,
    );
    for (const target of ["js", "wasm-gc"]) {
      const output = execFileSync(
        "moon",
        ["-C", dir, "test", "consumer", "--target", target],
        { encoding: "utf8", stdio: "pipe", timeout: 90000 },
      );
      assert.match(output, /passed: 1, failed: 0/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
