import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { emitSqlikeMoonbit } from "../scripts/emit-sqlike-moonbit.ts";
import { buildSqlikeRuntime } from "../scripts/build-sqlike-runtime.ts";
import { defineSqlike, sqlitePages } from "../src/sqlike-features.ts";
test("MoonBit source and flat JS/Wasm emitters share a closed plan and portable typed AOT contract", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sqlike-source-emitter-"));
  const catalog = {
    schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)"],
    queries: [
      { name: "add", sql: "INSERT INTO t VALUES(?,?)" },
      { name: "q", sql: "SELECT n*2 FROM t WHERE id=?" },
    ],
  };
  try {
    const profile = defineSqlike({ mode: "aot", features: [sqlitePages] });
    const emitted = await emitSqlikeMoonbit(profile, {
      outDir: join(dir, "library"),
      catalog,
      moduleName: "test/selected",
    });
    const flat = await buildSqlikeRuntime(profile, {
      outDir: join(dir, "flat"),
      catalog,
      minify: false,
    });
    assert.deepEqual(emitted.plan.selected, flat.plan.selected);
    assert.deepEqual(emitted.plan.constants, flat.plan.constants);
    assert.equal(emitted.plan.constants.OPT_SECONDARY_RANGE, false);
    const code = await readFile(join(dir, "flat/runtime.js"), "utf8");
    assert.doesNotMatch(
      code,
      /parse__statement|secondary__range|prepare__sql__metadata/,
    );
    await mkdir(join(dir, "consumer"));
    await writeFile(
      join(dir, "moon.work"),
      'members = ["library","consumer"]\n',
    );
    await writeFile(
      join(dir, "consumer/moon.mod"),
      'name = "test/user"\nversion = "0.0.0"\nimport { "test/selected@0.0.0" }\n',
    );
    await writeFile(
      join(dir, "consumer/moon.pkg"),
      'import { "test/selected/aot" }\n',
    );
    await writeFile(
      join(dir, "consumer/main_test.mbt"),
      `test "selected" { let artifact=${JSON.stringify(emitted.artifact)}; let db = @aot.Connection::open(artifact); let add = db.prepare("add"); add.bind(index=1,1L);add.bind(index=2,21L);ignore(add.step());add.finalize();let q=db.prepare("q");q.bind(index=1,1L);assert_true(q.step());let v : Int64=q.column(index=0);assert_eq(v,42L);q.finalize();db.close();let raw=@aot.aot_open(artifact,"");let image=@aot.aot_export_sqlite(raw);assert_true(@aot.sqlite_data(image).length()>512); let pager=@aot.sqlite_pager_open(); let batch=@aot.aot_pager_prepare(raw,pager); assert_true(!@aot.sqlite_pager_info(batch).contains("error")); assert_eq(@aot.sqlite_pager_page(batch,0)[0:16], b"SQLite format 3\\x00"); assert_eq(@aot.sqlite_pager_ack(pager,batch),"{}") }\n`,
    );
    for (const target of ["js", "wasm-gc"]) {
      const log = execFileSync(
        "moon",
        ["-C", dir, "test", "consumer", "--target", target],
        { encoding: "utf8", stdio: "pipe", timeout: 90000 },
      );
      assert.match(log, /passed: 1, failed: 0/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
