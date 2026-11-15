import { test } from "node:test";
import assert from "node:assert/strict";
import {
  datum,
  compareTraces,
  runTrace,
} from "./compatibility/differential-core.ts";
import type {
  DifferentialCase,
  DifferentialDriver,
  SqlOutcome,
} from "./compatibility/differential-contract.ts";
test("differential comparison retains storage class, int64 and signed zero, and ignores error wording", () => {
  assert.notDeepEqual(datum(1n), datum(1));
  assert.notDeepEqual(datum(-0), datum(0));
  assert.equal(datum(9223372036854775807n).type, "integer");
  const trace = (outcome: SqlOutcome) => ({
    setup: [],
    setupFailed: false,
    steps: [{ outcome, observations: [] }],
  });
  assert.equal(
    compareTraces(
      trace({ kind: "rows", rows: [[datum(1n)]] }),
      trace({ kind: "rows", rows: [[datum(1)]] }),
    ).length,
    1,
  );
  assert.equal(
    compareTraces(
      trace({ kind: "error", category: "unique", message: "native wording" }),
      trace({ kind: "error", category: "unique", message: "Moon wording" }),
    ).length,
    0,
  );
  assert.equal(
    compareTraces(
      trace({ kind: "error", category: "unique", message: "x" }),
      trace({ kind: "rows", rows: [] }),
    ).length,
    1,
  );
});
test("failed statements are followed by state observations and cannot pass because both throw", () => {
  const c: DifferentialCase = {
    id: "atomic",
    family: "atomic",
    scope: "supported",
    schema: [],
    steps: [{ sql: "write" }],
    observe: [{ sql: "read" }],
  };
  const driver = (dirty: boolean): DifferentialDriver => ({
    close() {},
    execute: (op) =>
      op.sql === "write"
        ? { kind: "error", category: "not-null", message: "constraint" }
        : { kind: "rows", rows: dirty ? [[datum(1n)]] : [] },
  });
  const differences = compareTraces(
    runTrace(c, driver(false)),
    runTrace(c, driver(true)),
  );
  assert.equal(differences.length, 1);
  assert.equal(differences[0]!.phase, "step[0].observe[0]");
});
test("WASM oracle does not request column names for DDL or non-returning writes", async () => {
  const { sqliteWasmOracle } = await import(
    "./compatibility/differential-sqlite-wasm.ts"
  );
  const sqlite = {
    oo1: {
      DB: class {
        exec() {}
        close() {}
        prepare() {
          return {
            columnCount: 0,
            getColumnNames() {
              throw Error("out of range");
            },
            step() {
              return false;
            },
            finalize() {},
          };
        }
      },
    },
  } as unknown as import("@sqlite.org/sqlite-wasm").Sqlite3Static;
  const db = sqliteWasmOracle(sqlite);
  try {
    assert.deepEqual(db.execute({ sql: "CREATE TABLE t(v)" }), {
      kind: "rows",
      rows: [],
      columns: [],
    });
  } finally {
    db.close();
  }
});
test("WASM oracle forces integral REAL bindings through sqlite3_bind_double", async () => {
  const { sqliteWasmOracle } = await import(
    "./compatibility/differential-sqlite-wasm.ts"
  );
  const seen: number[][] = [];
  const sqlite = {
    capi: {
      sqlite3_bind_double: (...args: number[]) => {
        seen.push(args);
        return 0;
      },
    },
    oo1: {
      DB: class {
        exec() {}
        close() {}
        checkRc(rc: number) {
          assert.equal(rc, 0);
        }
        prepare() {
          return {
            pointer: 42,
            columnCount: 0,
            bind() {},
            step() {
              return false;
            },
            finalize() {},
          };
        }
      },
    },
  } as unknown as import("@sqlite.org/sqlite-wasm").Sqlite3Static;
  const db = sqliteWasmOracle(sqlite);
  try {
    assert.equal(
      db.execute({ sql: "INSERT INTO t VALUES(?)", params: [datum(1)] }).kind,
      "rows",
    );
    assert.deepEqual(seen, [[42, 1, 1]]);
  } finally {
    db.close();
  }
});
test("strict differential gate rejects omitted results, incorrect answers and corrupt SQLite exports", async () => {
  const { differentialGate } = await import(
    "./compatibility/differential-gate.ts"
  );
  const result = {
    id: "a",
    family: "test",
    scope: "supported" as const,
    target: "js",
    status: "matched" as const,
    differences: [],
  };
  assert.deepEqual(
    differentialGate({ cases: [{ id: "a" }], results: [result] }, ["js"]),
    [],
  );
  assert.ok(
    differentialGate({ cases: [{ id: "a" }], results: [] }, ["js"]).length,
  );
  assert.ok(
    differentialGate(
      { cases: [{ id: "a" }], results: [{ ...result, status: "mismatch" }] },
      ["js"],
    ).length,
  );
  assert.ok(
    differentialGate(
      {
        cases: [{ id: "a" }],
        results: [result],
        exportIntegrity: [{ id: "a", ok: false }],
      },
      ["js"],
    ).length,
  );
});
test("strict gate rejects an excluded ordinary query or a falsely matched result", async () => {
  const { differentialGate } = await import(
    "./compatibility/differential-gate.ts"
  );
  const base = {
    id: "a",
    family: "f",
    scope: "supported" as const,
    target: "js/aot",
    differences: [],
  };
  assert.ok(
    differentialGate(
      {
        cases: [{ id: "a" }],
        results: [{ ...base, status: "not-applicable" }],
      },
      ["js/aot"],
    ).length,
  );
  assert.ok(
    differentialGate(
      {
        cases: [{ id: "a" }],
        results: [
          {
            ...base,
            status: "matched",
            differences: [
              {
                phase: "x",
                expected: { kind: "rows", rows: [] },
                actual: { kind: "rows", rows: [[datum(1n)]] },
              },
            ],
          },
        ],
      },
      ["js/aot"],
    ).length,
  );
});
test("AOT compile failures remain distinct from executed matches", async () => {
  const { auditTarget } = await import(
    "./compatibility/differential-runtime.ts"
  );
  const runtime = {
    compile: () => {
      throw Error("unsupported");
    },
    sql: {},
    aot: {},
  } as unknown as import("./compatibility/differential-runtime.ts").DifferentialRuntime;
  const c: DifferentialCase = {
    id: "a",
    family: "f",
    scope: "supported",
    schema: [],
    steps: [{ sql: "SELECT 1" }],
  };
  const trace = { setup: [], setupFailed: false, steps: [] };
  assert.equal(
    auditTarget([c], { a: trace }, runtime, "aot", true)[0]!.status,
    "unsupported",
  );
  assert.equal(
    auditTarget([c], { a: trace }, runtime, "aot", true, {
      a: { kind: "error", category: "syntax", message: "invalid SQL" },
    })[0]!.status,
    "compile-rejection",
  );
});
test("generated mutation corpus is reproducible and changes with an explicit seed", async () => {
  const { differentialCorpus } = await import(
    "./compatibility/differential-corpus.ts"
  );
  assert.deepEqual(differentialCorpus(123), differentialCorpus(123));
  assert.notDeepEqual(
    differentialCorpus(123).filter((c) => c.family === "mutation-sequence"),
    differentialCorpus(124).filter((c) => c.family === "mutation-sequence"),
  );
});
