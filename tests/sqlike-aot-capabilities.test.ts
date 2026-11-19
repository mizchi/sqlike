import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { createBuildPlan } from "../src/sqlike-build-plan.ts";
import { defineSqlike, fullSqlike } from "../src/sqlike-features.ts";
import { selectedAotExports } from "../src/sqlike-build-graph.ts";
import { buildSqlikeRuntime } from "../scripts/build-sqlike-runtime.ts";
import { emitSqlikeMoonbit } from "../scripts/emit-sqlike-moonbit.ts";
import { aotBindings } from "../src/aot-values.ts";
import { buildCatalog } from "../scripts/aot-compiler.ts";
import {
  openAotExecutor,
  aotExecutorWasm,
} from "../src/sqlike-aot-executor.ts";
import { openPortableCompiled } from "../src/sqlike-portable-aot.ts";

const core = ["aot_execute", "aot_info", "aot_open", "aot_set_clock"];
test("AOT API dependencies select exports separately from SQL semantics", () => {
  const profile = defineSqlike({ mode: "aot" });
  const minimal = createBuildPlan(profile, { apiCapabilities: [] });
  assert.deepEqual(minimal.apiCapabilities, ["execute"]);
  assert.deepEqual(selectedAotExports(minimal.selected), core);
  assert.equal(minimal.constants.CAP_API_SNAPSHOT, false);
  assert.equal(
    selectedAotExports(createBuildPlan(profile).selected).length,
    15,
  );
  const native = createBuildPlan(profile, { apiBackend: "native" });
  assert.equal(native.constants.CAP_API_SNAPSHOT, true);
  assert.equal(native.selected.includes("api/delta"), false);
  assert.equal(selectedAotExports(native.selected, "native").length, 14);
  for (const capability of [
    "prepared",
    "snapshot",
    "snapshotChunks",
    "transaction",
    "delta",
  ] as const) {
    const plan = createBuildPlan(profile, { apiCapabilities: [capability] });
    assert.ok(plan.selected.includes("api/execute"));
    assert.ok(plan.selected.includes(`api/${capability}`));
    assert.ok(selectedAotExports(plan.selected).length > core.length);
  }
  assert.throws(
    () => createBuildPlan(profile, { apiCapabilities: ["bad"] as never }),
    /unknown/,
  );
  assert.throws(
    () => createBuildPlan(fullSqlike(), { apiCapabilities: [] }),
    /AOT/,
  );
});

const catalog = {
  schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER CHECK(n>0))"],
  queries: [
    { name: "add", sql: "INSERT INTO t VALUES(?,?)" },
    { name: "bad", sql: "INSERT INTO t VALUES(2,2),(3,-1)" },
    { name: "get", sql: "SELECT id,n FROM t ORDER BY id" },
    { name: "update", sql: "UPDATE t SET n=? WHERE id=? RETURNING id,n" },
    { name: "erase", sql: "DELETE FROM t WHERE id=?" },
  ],
};
test("execute-only JS/Wasm omit public storage APIs but preserve atomic writes and strict host contracts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sqlike-executor-"));
  try {
    const built = await buildSqlikeRuntime(defineSqlike({ mode: "aot" }), {
      outDir: join(dir, "flat"),
      catalog,
      apiCapabilities: [],
      minify: false,
    });
    assert.deepEqual(built.exports, core);
    const js = await import(pathToFileURL(join(dir, "flat/runtime.js")).href);
    const wasm = (
      await WebAssembly.instantiate(
        await readFile(join(dir, "flat/runtime.wasm")),
        {},
        {
          builtins: ["js-string"],
          importedStringConstants: "_",
        },
      )
    ).instance.exports;
    const program = buildCatalog(catalog).artifact;
    for (const runtime of [js, aotExecutorWasm(wasm)]) {
      const db = openAotExecutor(runtime, program, { clock: () => 0 });
      db.execute("add", [1n, 1n]);
      assert.throws(() => db.execute("bad"), /CHECK/);
      assert.deepEqual(db.execute("get").rows, [[1n, 1n]]);
      assert.throws(() => db.execute("add", [1n, 99n]), /UNIQUE/);
      assert.throws(() => db.execute("update", [-1n, 1n]), /CHECK/);
      assert.throws(() => db.execute("get", "" as never), /array/);
      assert.deepEqual(db.execute("update", [9n, 1n]).rows, [[1n, 9n]]);
      assert.deepEqual(db.execute("get").rows, [[1n, 9n]]);
      db.execute("erase", [1n]);
      assert.deepEqual(db.execute("get").rows, []);
      assert.equal("transaction" in db, false);
      assert.equal("dump" in db, false);
      db.close();
      db.close();
      assert.throws(() => db.execute("get"), /closed/);
      assert.match(
        runtime.aot_info(runtime.aot_open(program, "not an image")),
        /snapshot.*disabled/i,
      );
    }
    let opened = false;
    assert.throws(
      () =>
        openAotExecutor(
          {
            ...js,
            aot_execute: undefined,
            aot_open() {
              opened = true;
            },
          } as never,
          program,
        ),
      /missing.*aot_execute/,
    );
    assert.equal(opened, false);
    assert.throws(
      () => openPortableCompiled(js, program),
      /missing portable AOT export/,
    );
    const code = await readFile(join(dir, "flat/runtime.js"), "utf8");
    assert.equal(
      /function [^\n]*(aot__dump|aot__restore|aot__delta|parse__statement|prepare__sql__metadata)\(/.test(
        code,
      ),
      false,
    );
    const hostPath = relative(
      dir,
      resolve("src/sqlike-aot-executor.ts"),
    ).replaceAll("\\", "/");
    await writeFile(
      join(dir, "consumer.ts"),
      `import * as runtime from './flat/runtime.js';\nimport {openAotExecutor} from '${hostPath}';\nconst db=openAotExecutor(runtime,'');db.execute('get',[1n]);\n// @ts-expect-error storage is not exposed\ndb.dump();\n// @ts-expect-error execute-only open cannot restore an image\nruntime.aot_open('','image');\n`,
    );
    await writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          allowImportingTsExtensions: true,
          target: "ESNext",
          module: "NodeNext",
          types: [],
          lib: ["ESNext", "DOM"],
        },
        files: ["consumer.ts"],
      }),
    );
    execFileSync("pnpm", ["exec", "tsc", "-p", join(dir, "tsconfig.json")], {
      stdio: "pipe",
      timeout: 60000,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("MoonBit source output shares the execute-only API plan and rejects omitted public methods", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sqlike-executor-source-"));
  try {
    const result = await emitSqlikeMoonbit(defineSqlike({ mode: "aot" }), {
      outDir: join(dir, "lib"),
      catalog,
      moduleName: "test/executor",
      apiCapabilities: [],
    });
    assert.deepEqual(selectedAotExports(result.plan.selected), core);
    const source = await readFile(join(dir, "lib/src/aot/engine.mbt"), "utf8");
    assert.equal(/pub fn Connection::prepare/.test(source), false);
    assert.equal(/pub fn aot_dump/.test(source), false);
    await mkdir(join(dir, "consumer"));
    await writeFile(join(dir, "moon.work"), 'members = ["lib","consumer"]\n');
    await writeFile(
      join(dir, "consumer/moon.mod"),
      'name = "test/user"\nversion = "0.0.0"\nimport { "test/executor@0.0.0" }\n',
    );
    await writeFile(
      join(dir, "consumer/moon.pkg"),
      'import { "test/executor/aot" }\n',
    );
    const bindings = JSON.stringify([
      { t: "integer", v: "1" },
      { t: "integer", v: "9" },
    ]);
    await writeFile(
      join(dir, "consumer/main_test.mbt"),
      `test "execute" { let db=@aot.aot_open(${JSON.stringify(result.artifact)},"");ignore(@aot.aot_execute(db,"add",${JSON.stringify(bindings)}));assert_true(@aot.aot_execute(db,"get","[]").contains("9")) }\n`,
    );
    for (const target of ["js", "wasm-gc"]) {
      const log = execFileSync(
        "moon",
        ["-C", dir, "test", "consumer", "--target", target],
        { stdio: "pipe", encoding: "utf8", timeout: 90000 },
      );
      assert.match(log, /passed: 1, failed: 0/);
    }
    await writeFile(
      join(dir, "consumer/forbidden_test.mbt"),
      'test "hidden" { ignore(@aot.aot_dump(@aot.aot_open("",""))) }\n',
    );
    assert.throws(() =>
      execFileSync("moon", ["-C", dir, "check", "consumer", "--target", "js"], {
        stdio: "pipe",
        timeout: 90000,
      }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("binary logical snapshots are opt-in and share the portable JS/Wasm/MoonBit build graph", async () => {
  const profile = defineSqlike({ mode: "aot" });
  assert.equal(
    createBuildPlan(profile).selected.includes("api/snapshotChunks"),
    false,
  );
  const plan = createBuildPlan(profile, {
    apiCapabilities: ["snapshotChunks"],
  });
  assert.ok(plan.selected.includes("api/snapshot"));
  assert.ok(selectedAotExports(plan.selected).includes("aot_snapshot_open"));
  assert.throws(
    () =>
      createBuildPlan(profile, {
        apiBackend: "native",
        apiCapabilities: ["snapshotChunks"],
      }),
    /portable/,
  );
  const dir = await mkdtemp(join(tmpdir(), "sqlike-chunk-capability-"));
  try {
    const built = await buildSqlikeRuntime(profile, {
      outDir: join(dir, "flat"),
      catalog,
      apiCapabilities: ["snapshotChunks"],
    });
    const js = await import(pathToFileURL(join(dir, "flat/runtime.js")).href);
    const wasm = (
      await WebAssembly.instantiate(
        await readFile(join(dir, "flat/runtime.wasm")),
        {},
        { builtins: ["js-string"], importedStringConstants: "_" },
      )
    ).instance.exports as any;
    const program = buildCatalog(catalog).artifact;
    assert.equal(built.exports.length, 16);
    for (const r of [js, wasm]) {
      const db = r.aot_open(program, "");
      assert.equal(
        JSON.parse(r.aot_execute(db, "add", aotBindings([1n, 2n]))).error,
        undefined,
      );
      const snapshot = r.aot_snapshot_open(db),
        h = JSON.parse(r.aot_snapshot_info(snapshot));
      assert.equal(h.error, undefined);
      assert.equal(h.parts, 1);
      const target = r.aot_open(program, ""),
        reader = r.aot_snapshot_restore(target, JSON.stringify(h));
      const part = r.aot_snapshot_chunk(snapshot, 0);
      assert.deepEqual(JSON.parse(r.sqlite_info(part)), {});
      assert.deepEqual(
        JSON.parse(
          r.aot_snapshot_supply_base64(reader, r.sqlite_data_base64(part)),
        ),
        {},
      );
      assert.deepEqual(JSON.parse(r.aot_snapshot_finish(reader)), {});
      assert.deepEqual(
        JSON.parse(r.aot_execute(target, "get", "[]")),
        JSON.parse(r.aot_execute(db, "get", "[]")),
      );
    }
    await emitSqlikeMoonbit(profile, {
      outDir: join(dir, "source"),
      catalog,
      apiCapabilities: ["snapshotChunks"],
    });
    assert.ok(
      (await readFile(join(dir, "source/src/aot/moon.pkg"), "utf8")).includes(
        "aot_snapshot_open",
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("incremental snapshot capability stays optional and compiles reusable frames on JS/Wasm/MoonBit", async () => {
  const profile = defineSqlike({ mode: "aot" });
  assert.equal(
    createBuildPlan(profile).selected.includes("api/snapshotIncremental"),
    false,
  );
  const dir = await mkdtemp(join(tmpdir(), "sqlike-incremental-cap-"));
  try {
    const result = await buildSqlikeRuntime(profile, {
      outDir: join(dir, "flat"),
      catalog,
      apiCapabilities: ["snapshotIncremental"],
    });
    assert.equal(result.exports.length, 18);
    const js = await import(pathToFileURL(join(dir, "flat/runtime.js")).href);
    const wasm = (
      await WebAssembly.instantiate(
        await readFile(join(dir, "flat/runtime.wasm")),
        {},
        { builtins: ["js-string"], importedStringConstants: "_" },
      )
    ).instance.exports as any;
    for (const r of [js, wasm]) {
      const db = r.aot_open(buildCatalog(catalog).artifact, "");
      for (let i = 1; i <= 65; i++)
        assert.equal(
          JSON.parse(r.aot_execute(db, "add", aotBindings([BigInt(i), 1n])))
            .error,
          undefined,
        );
      const before = r.aot_snapshot_incremental(db);
      r.aot_execute(db, "update", aotBindings([9n, 1n]));
      const next = r.aot_snapshot_incremental(db);
      assert.equal(r.aot_snapshot_reuse(next, before, 0), -1);
      assert.equal(r.aot_snapshot_reuse(next, before, 1), 1);
    }
    await emitSqlikeMoonbit(profile, {
      outDir: join(dir, "moon"),
      catalog,
      apiCapabilities: ["snapshotIncremental"],
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
