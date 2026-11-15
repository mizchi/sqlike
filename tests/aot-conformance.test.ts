import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as compiler from "../_build/js/release/build/mizchi/sqlike/compiler/compiler.js";
import * as runtime from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import * as defined from "../_build/js/release/build/mizchi/sqlike/defined/defined.js";
import { definedWasm } from "../adapters/defined-wasm.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import {
  parseLogicTest,
  verifyLogicResult,
} from "./compatibility/sqllogictest.ts";
import { nativeValues } from "./compatibility/native-values.ts";
import { aotValue } from "../src/aot-values.ts";
import type { Cell } from "../src/contract.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defineSqlike, primaryKeyIndex } from "../src/sqlike-features.ts";
import { buildSqlikeRuntime } from "../scripts/build-sqlike-runtime.ts";

test("all 1000 original select1 queries match native SQLite through JSON/binary and feature-selected JS/Wasm", async () => {
  const selectedDir = await mkdtemp(
    join(tmpdir(), "sqlike-conformance-selected-"),
  );
  await buildSqlikeRuntime(
    defineSqlike({ mode: "defined", features: [primaryKeyIndex] }),
    { outDir: selectedDir },
  );
  const selectedJS = await import(
    pathToFileURL(join(selectedDir, "runtime.js")).href
  );
  const selectedWasm = definedWasm(
    (
      await WebAssembly.instantiate(
        readFileSync(join(selectedDir, "runtime.wasm")),
        {},
        { builtins: ["js-string"], importedStringConstants: "_" },
      )
    ).instance.exports,
  );
  const source = readFileSync(
      "tests/fixtures/sqllogictest/select1.test",
      "utf8",
    ),
    provenance = JSON.parse(
      readFileSync("tests/fixtures/sqllogictest/upstream.json", "utf8"),
    );
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    provenance.sha256,
  );
  const records = parseLogicTest(source),
    statements = records.filter((r) => r.kind === "statement"),
    queries = records.filter((r) => r.kind === "query");
  assert.equal(statements.length, 31);
  assert.equal(queries.length, 1000);
  const schema = statements.filter((s) => /^CREATE TABLE /i.test(s.sql)),
    seeds = statements.filter((s) => !schema.includes(s));
  assert.equal(schema.length, 1);
  assert.ok(statements.every((s) => !s.error));
  const { instance } = await WebAssembly.instantiate(
    readFileSync(
      "_build/wasm-gc/release/build/mizchi/litestream-example/runtime/runtime.wasm",
    ),
    {},
    { builtins: ["js-string"], importedStringConstants: "_" },
  );
  const wasm = instance.exports as unknown as typeof runtime,
    native = new NodeDatabase(":memory:");
  const binaryWasm = definedWasm(
    (
      await WebAssembly.instantiate(
        readFileSync(
          "_build/wasm-gc/release/build/mizchi/sqlike/defined/defined.wasm",
        ),
        {},
        { builtins: ["js-string"], importedStringConstants: "_" },
      )
    ).instance.exports,
  );
  try {
    for (const statement of statements) native.run(statement.sql);
    // Bound each application artifact to the documented runtime resource limit.
    for (let offset = 0; offset < queries.length; offset += 100) {
      const batch = queries.slice(offset, offset + 100),
        catalog = {
          schema: schema.map((s) => s.sql),
          queries: [
            ...seeds.map((s, i) => ({ name: `seed${i}`, sql: s.sql })),
            ...batch.map((q, i) => ({ name: `query${i}`, sql: q.sql })),
          ],
        };
      const artifact = compiler.compile_program(JSON.stringify(catalog));
      assert.equal(JSON.parse(artifact).error, undefined);
      for (const engine of [runtime, wasm]) {
        const db = engine.aot_open(artifact, "");
        assert.equal(JSON.parse(engine.aot_info(db)).error, undefined);
        function execute(name: string) {
          const r = JSON.parse(engine.aot_execute(db, name, "[]")) as {
            error?: string;
            rows: Cell[][];
          };
          assert.equal(r.error, undefined, name);
          return r.rows.map((row) => row.map(aotValue));
        }
        seeds.forEach((_, i) => execute(`seed${i}`));
        batch.forEach((query, i) => {
          const expected = nativeValues(native, query.sql),
            actual = execute(`query${i}`);
          verifyLogicResult(query, expected);
          verifyLogicResult(query, actual);
          assert.deepEqual(
            actual,
            expected,
            `line ${query.line}: ${query.sql}`,
          );
        });
      }
      const packed = compiler.pack_program_binary(artifact);
      assert.equal(
        JSON.parse(compiler.binary_catalog_info(packed)).error,
        undefined,
      );
      for (const engine of [defined, binaryWasm, selectedJS, selectedWasm]) {
        const db = engine.defined_open(
          compiler.binary_catalog_schema(packed),
          compiler.binary_catalog_statements(packed),
          new Uint8Array(),
        );
        assert.equal(JSON.parse(engine.defined_info(db)).error, undefined);
        const execute = (name: string) => {
          const r = JSON.parse(engine.defined_execute(db, name, "[]")) as {
            error?: string;
            rows: Cell[][];
          };
          assert.equal(r.error, undefined, name);
          return r.rows.map((row) => row.map(aotValue));
        };
        seeds.forEach((_, i) => execute(`seed${i}`));
        batch.forEach((q, i) => {
          const actual = execute(`query${i}`);
          verifyLogicResult(q, actual);
          assert.deepEqual(actual, nativeValues(native, q.sql), q.sql);
        });
      }
    }
  } finally {
    native.close();
    await rm(selectedDir, { recursive: true, force: true });
  }
});
