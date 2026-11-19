import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const version: string = JSON.parse(readFileSync("package.json", "utf8")).version;

const targets = (process.env.RELEASE_PACK_TARGETS ?? "js").split(",");
const fromRegistry = process.env.RELEASE_PACK_REGISTRY === "1";
const sqlikeModule = resolve(process.env.SQLIKE_MODULE_DIR ?? "packages/sqlike");
const litestreamModule = resolve(process.env.LITESTREAM_MODULE_DIR ?? "packages/litestream");

function runConsumer(root: string, consumer: string, target: string) {
  const args = fromRegistry
    ? ["-C", consumer, "test", "--target", target]
    : ["-C", root, "test", "consumer", "--target", target];
  return execFileSync("moon", args, { encoding: "utf8", stdio: "pipe", timeout: 60000 });
}

test("an external MoonBit consumer uses sqlike and its compiler without the litestream module", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlike-consumer-"));
  try {
    const consumer = join(root, "consumer");
    mkdirSync(consumer);
    if (!fromRegistry) {
      writeFileSync(
        join(root, "moon.work"),
        `members = [${JSON.stringify(sqlikeModule)}, "consumer"]\n`,
      );
    }
    writeFileSync(
      join(consumer, "moon.mod"),
      `name = "test/sqlike-consumer"\nversion = "0.0.1"\nimport { "mizchi/sqlike@${version}" }\n`,
    );
    writeFileSync(
      join(consumer, "moon.pkg"),
      'import { "mizchi/sqlike", "mizchi/sqlike/aot", "mizchi/sqlike/compiler" }\n',
    );
    writeFileSync(
      join(consumer, "consumer_test.mbt"),
      String.raw`
///|
test "typed and compiled public interfaces work across module boundaries" {
  let connection = @sqlike.Connection::open(":memory:")
  let statement = connection.prepare("SELECT ?")
  statement.bind(index=1, 9007199254740993L)
  assert_true(statement.step())
  let integer : Int64 = statement.column(index=0)
  assert_eq(integer, 9007199254740993L)
  statement.finalize()
  connection.close()
  let artifact = @compiler.compile_program("{\"schema\":[],\"queries\":[{\"name\":\"one\",\"sql\":\"SELECT 1\"}]}")
  let program = @aot.Program::load(artifact)
  let compiled = @aot.Connection::from_program(program)
  let select = compiled.prepare_compiled(program.query("one"))
  assert_true(select.step())
  let one : Int64 = select.column(index=0)
  assert_eq(one, 1L)
  select.finalize()
  compiled.close()
}
`,
    );
    for (const target of targets) {
      const output = runConsumer(root, consumer, target);
      assert.match(output, /passed: 1, failed: 0/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an external Litestream consumer does not need SQLike or any database driver", () => {
  const root = mkdtempSync(join(tmpdir(), "litestream-consumer-"));
  try {
    const consumer = join(root, "consumer");
    mkdirSync(consumer);
    if (!fromRegistry) {
      writeFileSync(
        join(root, "moon.work"),
        `members = [${JSON.stringify(litestreamModule)}, "consumer"]\n`,
      );
    }
    writeFileSync(
      join(consumer, "moon.mod"),
      `name = "test/litestream-consumer"\nversion = "0.0.1"\nimport { "mizchi/litestream@${version}" }\n`,
    );
    writeFileSync(join(consumer, "moon.pkg"), 'import { "mizchi/litestream" }\n');
    writeFileSync(
      join(consumer, "consumer_test.mbt"),
      'test "sync and LTX exports are backend independent" { assert_eq(@litestream.revision_decision(0,0,1,false), "apply"); let file = @litestream.encode_ltx(b"", b"bad", "1", "1", "0"); assert_true(@litestream.ltx_info(file).contains("error")) }\n',
    );
    for (const target of targets) {
      const output = runConsumer(root, consumer, target);
      assert.match(output, /passed: 1, failed: 0/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
