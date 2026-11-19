import type { Value } from "../../src/contract.ts";
import type { OutputPolicyCase } from "./output-policy-corpus.ts";
export const outputPolicySeeds = [0x51a17e, 0x31415926, 0xdecafbad] as const;
export interface GeneratedOutputCase extends OutputPolicyCase {
  id: string;
  family: string;
}
export function generatedOutputPolicyCases(
  seed: number,
  rounds = 12,
): GeneratedOutputCase[] {
  let state = seed >>> 0;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  const pick = <T>(xs: readonly T[]) => xs[next() % xs.length]!;
  const cases: GeneratedOutputCase[] = [];
  const values: Value[] = [
    null,
    0n,
    1n,
    -1n,
    9223372036854775807n,
    -9223372036854775808n,
    1,
    -0,
    0.5,
    Number.MIN_VALUE,
    1e100,
    "1",
    " 1e2x",
    "a\0b",
    new Uint8Array([0, 255]),
  ];
  const texts = [
    "A",
    "a",
    "A\0x",
    "a\0y",
    "é😀",
    "a ",
    "",
    "\ufeffa",
    "İ",
    "a\t",
  ];
  const schema = [
    "CREATE TABLE t(id INTEGER PRIMARY KEY,g TEXT COLLATE NOCASE,v)",
  ];
  const observed = ["SELECT id,g,typeof(v),v FROM t ORDER BY id"];
  for (let i = 0; i < rounds; i++) {
    const a = next() % 1000,
      b = next() % 1000;
    const base = {
      schema,
      seed: [`INSERT INTO t VALUES(1,'A',${a}),(2,'a',${b}),(3,'B',NULL)`],
      mustReject: false,
    };
    const add = (
      family: string,
      c: Partial<OutputPolicyCase> & { sql: string },
    ) =>
      cases.push({
        ...base,
        ...c,
        id: `generated/${seed.toString(16)}/${family}/${i}`,
        family,
      });
    const v = pick(values);
    add("binding", {
      sql: "SELECT typeof(?),?,?+0,CAST(? AS TEXT)",
      params: [v, v, v, v],
      mustSucceed: !(v instanceof Uint8Array),
      mustReject: v instanceof Uint8Array,
    });
    const x = pick(texts),
      y = pick(texts),
      collation = pick(["BINARY", "NOCASE", "RTRIM"]);
    add("collation", {
      sql: `SELECT ? COLLATE ${collation}=?,? COLLATE ${collation}<?,? LIKE ?`,
      params: [x, y, x, y, x, pick(["a%", "_", "%\0x", "A_", "é%"])],
      mustSucceed: true,
    });
    add("aggregate", {
      sql: "SELECT g,sum(v),count(*),total(v),avg(v) FROM t GROUP BY g ORDER BY g",
      mustSucceed: true,
    });
    add("bare-aggregate", {
      sql: pick([
        "SELECT id,sum(v) FROM t",
        "SELECT id,max(v),min(v) FROM t",
        "SELECT count(*) FROM t HAVING id>1",
      ]),
      mustReject: true,
    });
    add("extremum-representative", {
      sql: "SELECT id,g,max(id),sum(v) FROM t",
      mustSucceed: true,
    });
    const json = `{"a":${a},"a":${b},"text":${JSON.stringify(pick(texts))}}`;
    add("json", {
      sql: "SELECT json_extract(?,'$.a'),json_set(?,'$.a',?),json_remove(?,'$.a'),json_patch(?,?)",
      params: [json, json, BigInt(next() % 1000), json, json, `{"b":${b}}`],
      mustSucceed: true,
    });
    add("invalid-text", {
      sql: "UPDATE t SET v=CASE WHEN id=1 THEN 'ok' ELSE CAST(? AS TEXT) END RETURNING id,v",
      params: [
        new Uint8Array(
          pick([
            [0x80],
            [0xc0, 0xaf],
            [0xed, 0xa0, 0x80],
            [0xf4, 0x90, 0x80, 0x80],
          ]),
        ),
      ],
      mustReject: true,
      observe: observed,
    });
    add("mutation", {
      sql: "UPDATE t SET v=? WHERE id=1 RETURNING id,typeof(v),v",
      params: [v],
      mustSucceed: true,
      observe: observed,
    });
    add("constraint", {
      schema: [
        "CREATE TABLE t(id INTEGER PRIMARY KEY,g TEXT COLLATE NOCASE UNIQUE,v)",
      ],
      seed: ["INSERT INTO t VALUES(1,'A',1),(2,'B',2)"],
      sql: "UPDATE t SET g=CASE WHEN id=1 THEN 'C' ELSE 'c' END RETURNING id,g",
      nativeError: "UNIQUE constraint failed",
      observe: observed,
    });
    const literal = pick([
      `${a}e2`,
      `+${a}`,
      `(-${b})`,
      "'a''b'",
      "x'00ff'",
      "NULL",
    ]);
    add("declaration", {
      schema: [`CREATE TABLE defaults(v DEFAULT(${literal}),n)`],
      seed: [],
      sql: "PRAGMA table_xinfo(defaults)",
      mustSucceed: true,
    });
  }
  return cases;
}
