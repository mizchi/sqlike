import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { sqlikePaths } from "./compatibility/sqlike-paths.ts";

test("named SQL parameters compile into shared, case-sensitive positional slots", async () => {
  const cases: {
    sql: string;
    native: Record<string, bigint>;
    values: (bigint | null)[];
    positional?: (bigint | null)[];
  }[] = [
    {
      sql: "SELECT :x,:x,@x,$x",
      native: { ":x": 11n, "@x": 22n, $x: 33n },
      values: [11n, 22n, 33n],
    },
    {
      sql: "SELECT :x,:X,:x,@日本語,$0",
      native: { ":x": 11n, ":X": 22n, "@日本語": 33n, $0: 44n },
      values: [11n, 22n, 33n, 44n],
    },
    { sql: "SELECT :x + (SELECT :x),$tail", native: { ":x": 11n, $tail: 22n }, values: [11n, 22n] },
    {
      sql: "SELECT :x::y(foo),@x::y(foo),$x::y(foo)",
      native: { ":x::y(foo)": 11n, "@x::y(foo)": 22n, "$x::y(foo)": 33n },
      values: [11n, 22n, 33n],
    },
    {
      sql: "SELECT ?3,:x,?1,@x,:x,?",
      native: { ":x": 44n, "@x": 55n },
      values: [11n, null, 33n, 44n, 55n, 66n],
      positional: [11n, null, 33n, 66n],
    },
    { sql: "SELECT :x,?1,:x,:y", native: { ":x": 11n, ":y": 22n }, values: [11n, 22n] },
  ];
  const paths = await sqlikePaths(
    [],
    cases.map((q, i) => ({ name: String(i), sql: q.sql })),
  );
  const native = new DatabaseSync(":memory:");
  try {
    for (const [i, q] of cases.entries()) {
      const stmt = native.prepare(q.sql);
      stmt.setReadBigInts(true);
      stmt.setReturnArrays(true);
      stmt.setAllowBareNamedParameters(false);
      const expected = stmt.all(q.native, ...(q.positional ?? []));
      for (const path of paths) assert.deepEqual(path.exec(String(i), q.values), expected);
    }
  } finally {
    native.close();
  }
});
