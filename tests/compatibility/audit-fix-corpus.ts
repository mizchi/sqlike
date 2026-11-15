import type { DifferentialCase } from "./differential-contract.ts";
export function auditFixCorpus(): DifferentialCase[] {
  const cases: DifferentialCase[] = [];
  function add(schema: string[], steps: string[]) {
    cases.push({
      id: `audit-regression/${cases.length}`,
      family: "audit-regression",
      scope: "supported",
      schema,
      steps: steps.map((sql) => ({ sql })),
    });
  }
  for (const values of [
    "(9223372036854775807),(1),(0.0)",
    "(9223372036854775807),(1),('x')",
    "(1e16),(1.0),(-1e16)",
    "(9223372036854775807),(-9223372036854775808),(0.0)",
    "(1e999),(-1e999)",
    "(NULL),(NULL)",
    "(9223372036854775807),(1)",
  ]) {
    add(
      ["CREATE TABLE t(v)"],
      [
        `INSERT INTO t VALUES${values}`,
        "SELECT sum(v),total(v),avg(v),count(v),count(*) FROM t",
        "SELECT sum(v),total(v),avg(v) FROM t WHERE 1",
        "SELECT sum(v) OVER () FROM t",
      ],
    );
  }
  add(
    [],
    [
      `SELECT json_remove('{"a":1,"a":2}','$.a'),json_set('{"a":1,"a":2}','$.a',3),json_patch('{"a":1,"a":2}','{"a":null}')`,
      `SELECT json('{"a":{"b":1,"b":2},"a":3}'),json_extract('{"a":{"b":1,"b":2},"a":3}','$.a.b'),json_object('a',1,'a',2)`,
      "SELECT json_valid('[1,]'),json_valid('{\"a\":1,}'),json_valid('{\"a\":1,\"a\":2}')",
    ],
  );
  for (const value of [
    2.675, 1.005, 0.49999999999999994, 0.5, -0.5, 999.995, 1e-20, 1e16,
  ])
    for (const n of [-1, 0, 1, 2, 15, 30])
      add([], [`SELECT round(${value},${n}),round(${-value},${n})`]);
  add(
    ["CREATE TABLE t(id INTEGER PRIMARY KEY,v)"],
    [
      "INSERT INTO t(_rowid_,v) VALUES(-2,'a')",
      "INSERT INTO t(oid,v) VALUES(NULL,'b')",
      "SELECT rowid,id,v FROM t ORDER BY rowid",
      "INSERT INTO t(rowid,v) VALUES(-2,'duplicate')",
      "SELECT rowid,id,v FROM t ORDER BY rowid",
    ],
  );
  add(
    ["CREATE TABLE t(id INTEGER PRIMARY KEY DESC,v)"],
    [
      "INSERT INTO t(rowid,id,v) VALUES(5,NULL,'a'),(3,NULL,'b')",
      "SELECT rowid,id,v FROM t ORDER BY rowid",
    ],
  );

  for (const policy of ["", "OR IGNORE", "OR REPLACE"])
    add(
      ["CREATE TABLE t(v)"],
      [
        "INSERT INTO t(rowid,v) VALUES(2,'old')",
        `INSERT ${policy} INTO t(rowid,v) VALUES(2,'new')`,
        "SELECT rowid,v FROM t ORDER BY rowid",
      ],
    );

  add(
    [],
    [
      "SELECT quote(1.2345678901234567),quote(1.0),quote(-0.0),quote(x'00abff'),quote(NULL),quote(1e999)",
    ],
  );
  add(
    ["CREATE TABLE t(id INTEGER PRIMARY KEY)"],
    [
      "INSERT INTO t VALUES(1)",
      "SELECT * FROM t WHERE id=1",
      "BEGIN",
      "INSERT INTO t VALUES(7)",
      "SELECT * FROM t WHERE id=7",
      "ROLLBACK",
      "SELECT * FROM t WHERE id=7",
      "SELECT * FROM t WHERE id=1",
    ],
  );
  add(
    ["CREATE TABLE t(id INTEGER PRIMARY KEY)"],
    [
      "INSERT INTO t VALUES(1)",
      "SAVEPOINT s",
      "DELETE FROM t WHERE id=1",
      "SELECT * FROM t WHERE id=1",
      "ROLLBACK TO s",
      "SELECT * FROM t WHERE id=1",
      "RELEASE s",
    ],
  );
  for (const depth of [1000, 1001]) {
    const json = "[".repeat(depth) + "0" + "]".repeat(depth);
    add([], [`SELECT json_valid('${json}')`]);
  }
  return cases;
}
