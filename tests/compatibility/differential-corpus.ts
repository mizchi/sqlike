import { auditFixCorpus } from "./audit-fix-corpus.ts";
import { datum } from "./differential-core.ts";
import type {
  DifferentialCase,
  DifferentialOperation,
} from "./differential-contract.ts";
import type { Value } from "../../src/contract.ts";
const op = (sql: string, ...params: Value[]): DifferentialOperation => ({
  sql,
  params: params.map(datum),
});
export function differentialCorpus(seed = 0x51a17e): DifferentialCase[] {
  const cases: DifferentialCase[] = [];
  const ids = new Map<string, number>();
  const add = (
    family: string,
    c: Omit<DifferentialCase, "id" | "family" | "scope"> & {
      scope?: DifferentialCase["scope"];
    },
  ) => {
    const n = (ids.get(family) ?? 0) + 1;
    ids.set(family, n);
    cases.push({
      id: `${family}/${String(n).padStart(3, "0")}`,
      family,
      scope: "supported",
      ...c,
    });
  };
  const read = (family: string, sql: string, ...params: Value[]) =>
    add(family, {
      schema: [],
      steps: [op(sql, ...params)],
      scope: /<<|>>|round\(|1e999|unicode\(|quote\(/i.test(sql)
        ? "exploratory"
        : "supported",
    });
  read(
    "format",
    "SELECT format(),printf(NULL),format('%d/%u/%x/%o',-42,-1,-1,8),printf('%04d:%Q',42,'a''b')",
  );
  read(
    "format",
    "SELECT format('%s|%q|%Q|%w',NULL,NULL,NULL,NULL),format('%!.2s|%.3c|%n%d','あいう','😀',9),format('%#08x|%0,8d',42,-1234)",
  );
  read(
    "format",
    "SELECT format('%.*Q|%*d',2,NULL,-5,7),format('%c',NULL),format('%lld',9007199254740993)",
  );
  add("aggregate-representative", {
    schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,g TEXT,n INTEGER,s TEXT)"],
    seed: [
      op(
        "INSERT INTO t VALUES(1,'a',2,'low'),(2,'a',9,'high'),(3,'b',NULL,'same'),(4,'b',NULL,'same')",
      ),
    ],
    steps: [
      op("SELECT g,s,max(n),sum(n),count(*) FROM t GROUP BY g ORDER BY g"),
      op("SELECT id,s,min(n*?1) FROM t", -1n),
      op("SELECT id,s,max(n),max(n) FROM t WHERE 0"),
    ],
  });
  add("in-select-cache", {
    schema: [
      "CREATE TABLE t(id INTEGER PRIMARY KEY,n NUMERIC,s TEXT COLLATE NOCASE)",
      "CREATE TABLE r(n NUMERIC,s TEXT COLLATE NOCASE)",
    ],
    seed: [
      op(
        "INSERT INTO t VALUES(1,1,'A'),(2,2,'b'),(3,NULL,'x'),(4,9007199254740993,'hi')",
      ),
      op("INSERT INTO r VALUES(1,'a'),(NULL,'b'),(9007199254740993,'hi')"),
    ],
    steps: [
      op(
        "SELECT n IN(SELECT n FROM r WHERE n>=?1 OR n IS NULL),(n,s) IN(SELECT n,s FROM r) FROM t ORDER BY id",
        0n,
      ),
      op(
        "SELECT count(*),sum(id),avg(id),total(id) FROM t WHERE (n,s) IN(SELECT n,s FROM r)",
      ),
      op(
        "SELECT id FROM t WHERE n IN(SELECT n FROM r WHERE s=t.s) ORDER BY id",
      ),
      op("DELETE FROM r WHERE n=1"),
      op(
        "SELECT id FROM t WHERE n IN(SELECT n FROM r WHERE n>=?1) ORDER BY id",
        2n,
      ),
    ],
  });
  add("in-select-general-source", {
    schema: [
      "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)",
      "CREATE TABLE r(n INTEGER)",
      "CREATE VIEW v AS SELECT * FROM t",
    ],
    seed: [
      op("INSERT INTO t VALUES(1,1),(2,2),(3,NULL)"),
      op("INSERT INTO r VALUES(1),(NULL)"),
    ],
    steps: [
      op(
        "SELECT v.id,v.n IN(SELECT n FROM r),r.n IN(SELECT n FROM t) FROM v LEFT JOIN r ON v.n=r.n ORDER BY v.id",
      ),
      op(
        "WITH c AS(SELECT * FROM t) SELECT id,(n,0) IN(SELECT n,0 FROM r) FROM c ORDER BY id",
      ),
    ],
  });
  add("schema-affinity", {
    schema: ['CREATE TABLE "3"(a)', 'CREATE VIEW v AS SELECT a FROM "3"'],
    steps: [
      op(
        "SELECT name,name=3,tbl_name=3,name IN(3) FROM sqlite_schema WHERE name=3",
      ),
      op("SELECT 3 IN(SELECT name FROM sqlite_master)"),
    ],
  });
  add("schema-name-namespace", {
    schema: [
      "CREATE TABLE t(a)",
      "CREATE TABLE audit(a)",
      "CREATE TRIGGER t AFTER INSERT ON t BEGIN INSERT INTO audit VALUES(new.a); END",
      "CREATE TABLE IF NOT EXISTS t(b)",
      "CREATE VIEW IF NOT EXISTS t AS SELECT 1",
    ],
    steps: [
      op("INSERT INTO t VALUES(7)"),
      op("SELECT * FROM audit ORDER BY a"),
      op("SELECT type,name,tbl_name FROM sqlite_schema ORDER BY type,name"),
    ],
  });
  add("default-expression", {
    schema: [
      "CREATE TABLE t(id INTEGER PRIMARY KEY,n INT DEFAULT((1+2)*3),v TEXT DEFAULT(lower('HELLO')),previous DEFAULT(last_insert_rowid()))",
    ],
    steps: [
      op("INSERT INTO t(id) VALUES(1),(2),(3) RETURNING *"),
      op("SELECT *,typeof(n),typeof(v) FROM t ORDER BY id"),
      op("PRAGMA table_info(t)"),
    ],
  });
  add("default-unused-error", {
    schema: [
      "CREATE TABLE t(id INTEGER PRIMARY KEY,n DEFAULT(abs(-9223372036854775808)))",
    ],
    steps: [
      op("INSERT INTO t VALUES(1,7)"),
      op("INSERT INTO t(id) VALUES(2),(3)"),
    ],
    observe: [op("SELECT * FROM t ORDER BY id")],
  });
  add("create-table-as", {
    schema: [
      "CREATE TABLE t AS SELECT CAST(7 AS INTEGER) AS id,lower('HELLO') AS v",
    ],
    steps: [
      op("SELECT rowid,* FROM t"),
      op("PRAGMA table_info(t)"),
      op("INSERT INTO t DEFAULT VALUES RETURNING rowid,*"),
    ],
  });
  read(
    "in-exact-real",
    "SELECT CAST(9007199254740993 AS REAL) IN (9007199254740993),CAST(9223372036854775807 AS REAL) IN (9223372036854775807)",
  );
  read(
    "subquery-affinity",
    "SELECT (SELECT '1' UNION ALL SELECT CAST('2' AS TEXT))=1,(SELECT CAST('1' AS TEXT) UNION ALL SELECT '2')=1,CAST(9007199254740993 AS REAL) IN(SELECT 9007199254740993)",
  );
  read(
    "derived-affinity",
    "SELECT v,typeof(v),(v,0) IN((9007199254740993,0)) FROM(SELECT CAST(9007199254740993 AS REAL) AS v UNION ALL SELECT CAST(2 AS REAL))q",
  );
  const inParameters = Array.from({ length: 32 }, (_, i) => `?${i + 1}`).join(
    ",",
  );
  const rowParameters = Array.from(
    { length: 16 },
    (_, i) => `(?${i * 2 + 1},?${i * 2 + 2})`,
  ).join(",");
  add("large-in-list", {
    schema: ["CREATE TABLE t(n NUMERIC,s TEXT COLLATE NOCASE)"],
    seed: [op("INSERT INTO t VALUES(1,'A'),(2,'b'),(NULL,NULL)")],
    steps: [
      op(
        `SELECT n IN(${inParameters}),s IN(${inParameters}) FROM t ORDER BY rowid`,
        ...Array.from({ length: 32 }, (_, i) => (i % 2 ? "a" : 1n)),
      ),
      op(
        `SELECT count(*),count(n),sum(n),avg(n),total(n) FROM t WHERE n IN(${inParameters})`,
        ...Array.from({ length: 32 }, (_, i) => (i % 2 ? "a" : 1n)),
      ),
      op(
        `SELECT count(*),count(n),sum(n),avg(n),total(n) FROM t WHERE (n,s) IN(${rowParameters})`,
        ...Array.from({ length: 32 }, (_, i) => (i % 2 ? "a" : null)),
      ),
      op(
        `SELECT (n,s) IN(${rowParameters}) FROM t ORDER BY rowid`,
        ...Array.from({ length: 32 }, (_, i) => (i % 2 ? "a" : null)),
      ),
    ],
  });
  add("json-table", {
    schema: [],
    steps: [
      op(
        `SELECT rowid,* FROM json_tree('{"a":[1,2.0],"a.b":true,"empty":[]}')`,
      ),
    ],
  });
  add("json-table", {
    schema: [],
    steps: [
      op(`SELECT rowid,* FROM json_each('{"a":[10,20]}','$.a')`),
      op(
        `SELECT key,value,id,parent,fullkey,path FROM json_tree('[10,[20,30]]','$[1]')`,
      ),
    ],
  });
  add("json-table", {
    schema: ["CREATE TABLE docs(id INTEGER PRIMARY KEY,doc TEXT)"],
    seed: [
      op(`INSERT INTO docs VALUES(1,'[1,2]'),(2,'{bad'),(3,NULL),(4,'[]')`),
    ],
    steps: [
      op(
        "SELECT docs.id,j.key,j.value,j.id FROM docs LEFT JOIN json_each(docs.doc) j ON 1 WHERE json_valid(docs.doc) ORDER BY docs.id,j.rowid",
      ),
    ],
  });
  add("json-table", {
    schema: ["CREATE TABLE target(id INTEGER PRIMARY KEY,n INT)"],
    steps: [
      op(
        "INSERT INTO target SELECT key+1,value FROM json_each('[3,4]') RETURNING *",
      ),
      op(
        "UPDATE target SET n=j.value FROM json_each('[10,20]') j WHERE target.id=j.key+1 RETURNING *",
      ),
    ],
    observe: [op("SELECT * FROM target ORDER BY id")],
  });
  for (const sql of [
    "UPDATE t SET n=t.n-s.n FROM s WHERE t.id=s.id RETURNING id,n",
    "UPDATE t SET n=t.n-daily.n FROM (SELECT id,sum(n) AS n FROM sales GROUP BY id) AS daily WHERE t.id=daily.id RETURNING id,n",
    "UPDATE t AS dst SET n=src.n+100 FROM t AS src WHERE dst.id=src.id+1 RETURNING id,n",
    "UPDATE t SET n=s.n FROM s WHERE t.id=s.id RETURNING id,n",
  ])
    add("update-from", {
      schema: [
        "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)",
        "CREATE TABLE s(id INTEGER PRIMARY KEY,n INTEGER)",
        "CREATE TABLE sales(id INTEGER,n INTEGER)",
        "CREATE TABLE audit(id INTEGER,n INTEGER)",
        "CREATE TRIGGER changed AFTER UPDATE ON t BEGIN INSERT INTO audit VALUES(NEW.id,NEW.n); UPDATE s SET n=n+100; END",
      ],
      seed: [
        op("INSERT INTO t VALUES(1,100),(2,200),(3,300)"),
        op("INSERT INTO s VALUES(1,10),(2,20)"),
        op("INSERT INTO sales VALUES(1,3),(1,4),(2,5)"),
      ],
      steps: [op(sql)],
      observe: [
        op("SELECT * FROM t ORDER BY id"),
        op("SELECT * FROM s ORDER BY id"),
        op("SELECT * FROM audit ORDER BY id"),
      ],
    });
  for (const sql of [
    "UPDATE generated SET n=n+1 WHERE id=1 RETURNING *",
    "SELECT id,v,label FROM generated WHERE label='ALPHA' ORDER BY v DESC,id",
    "UPDATE generated SET n=CASE id WHEN 1 THEN 9 ELSE -1 END RETURNING id,v",
  ])
    add("generated-columns", {
      schema: [
        "CREATE TABLE generated(id INTEGER PRIMARY KEY,v INT AS(n*2) UNIQUE CHECK(v>=0),n INT,raw TEXT,label TEXT COLLATE NOCASE AS(lower(raw)))",
        "CREATE INDEX by_generated ON generated(v DESC,id)",
      ],
      seed: [op("INSERT INTO generated VALUES(1,2,'Alpha'),(2,3,'Beta')")],
      steps: [op(sql)],
      observe: [op("SELECT * FROM generated ORDER BY id")],
    });
  add("generated-columns", {
    schema: [
      "CREATE TABLE generated(k TEXT PRIMARY KEY,doc TEXT,n INT AS(json_extract(doc,'$.n'))) WITHOUT ROWID",
    ],
    seed: [
      op("INSERT INTO generated VALUES('b','{\"n\":2}'),('a','{\"n\":1}')"),
    ],
    steps: [
      op("UPDATE generated SET doc='{\"n\":3}' WHERE k='a' RETURNING *"),
      op("SELECT k,n FROM generated ORDER BY k"),
    ],
  });
  for (const sql of [
    "SELECT id FROM cursor_rows WHERE (s,id)>(?,?) ORDER BY s,id LIMIT 3",
    "SELECT (n,id)=(1,1),(n,id) IS (NULL,2),(n,id) BETWEEN (0,0) AND (2,4) FROM cursor_rows ORDER BY id",
    "SELECT ('1',0) IN ((1,0),(s,1)),(1,0) IN (('1',0),(n,1)) FROM cursor_rows ORDER BY id",
    "SELECT id,CASE (n,id) WHEN (1,1) THEN 'first' ELSE 'other' END,(n,id) IN (SELECT n,id FROM cursor_rows other WHERE other.id<cursor_rows.id) FROM cursor_rows ORDER BY id",
  ])
    add("row-values", {
      schema: [
        "CREATE TABLE cursor_rows(id INTEGER PRIMARY KEY,s TEXT COLLATE NOCASE,n NUMERIC)",
        "CREATE INDEX cursor_ix ON cursor_rows(s,id)",
      ],
      seed: [
        op(
          "INSERT INTO cursor_rows VALUES(1,'a',1),(2,'A',NULL),(3,'b',2),(4,'c',1)",
        ),
      ],
      steps: [sql.includes("?") ? op(sql, "a", 1n) : op(sql)],
    });
  for (const sql of [
    "SELECT group_concat(v ORDER BY n DESC NULLS FIRST,id),string_agg(v,':' ORDER BY n,id DESC) FROM ordered",
    "SELECT group_concat(DISTINCT k ORDER BY k),json_group_array(DISTINCT k ORDER BY id DESC) FROM ordered",
    "SELECT json_group_array(json(v) ORDER BY n,id),json_group_object(k,json(v) ORDER BY id DESC) FILTER(WHERE n>1) FROM ordered",
    "SELECT k,sum(n ORDER BY id DESC) FILTER(WHERE n>1),count(n ORDER BY n),group_concat(v ORDER BY id) FROM ordered GROUP BY k ORDER BY k",
  ])
    add("aggregate-order", {
      schema: [
        "CREATE TABLE ordered(id INTEGER PRIMARY KEY,k TEXT COLLATE NOCASE,v TEXT,n INTEGER)",
      ],
      seed: [
        op(
          `INSERT INTO ordered VALUES(1,'a','1',3),(2,'A','{"x":2}',1),(3,'b','"s"',2),(4,'a',NULL,NULL)`,
        ),
      ],
      steps: [op(sql)],
    });
  // Literal and bound values deliberately retain different SQLite storage classes.
  for (const [a, b] of [
    ["9223372036854775807", "1"],
    ["-9223372036854775808", "1"],
    ["3037000500", "3037000500"],
    ["-1", "64"],
    ["1", "-1"],
    ["1", "64"],
    ["-1", "-64"],
    ["5.5", "2"],
    ["5", "2.0"],
    ["-9223372036854775808", "-1"],
  ] as const)
    for (const operator of ["+", "-", "*", "/", "%", "<<", ">>"])
      read(
        "numeric-boundary",
        `SELECT ${a}${operator}(${b}),typeof(${a}${operator}(${b}))`,
      );
  for (const value of [
    "0x10",
    "0x1p2",
    "1e2x",
    "  1.5x",
    "12e+",
    "1_000",
    "0b10",
    "0o10",
    "Inf",
    "nan",
    "9223372036854775808",
    "-9223372036854775809",
    "1\0x",
  ])
    read(
      "numeric-text",
      "SELECT ?+0,typeof(?+0),CAST(? AS INTEGER),CAST(? AS REAL)",
      value,
      value,
      value,
      value,
    );
  for (const sql of [
    "SELECT CAST(1e100 AS INTEGER),CAST(-1e100 AS INTEGER)",
    "SELECT -(-9223372036854775808),typeof(-(-9223372036854775808))",
    "SELECT abs(-9223372036854775808)",
    "SELECT round(2.675,2),round(-2.675,2)",
    "SELECT 1e999,typeof(1e999)",
  ])
    read("numeric-boundary", sql);
  for (const text of ["a\0b", "a\0c", "A\0b", "a\0B", "\0x", "é😀"])
    for (const [sql, args] of [
      ["SELECT length(?)", [text]],
      ["SELECT hex(?)", [text]],
      ["SELECT instr(?,?)", [text, "b"]],
      ["SELECT substr(?,2,2)", [text]],
      ["SELECT quote(?)", [text]],
      ["SELECT unicode(?)", [text]],
    ] as const)
      read("text-scalar", sql, ...args);

  for (const [a, b] of [
    ["a\0b", "a\0c"],
    ["A\0b", "a\0c"],
    ["a\0", "a"],
    ["a ", "a"],
    ["É", "é"],
  ] as const)
    read(
      "collation",
      "SELECT ?=? COLLATE NOCASE,?=? COLLATE RTRIM,?=? COLLATE BINARY",
      a,
      b,
      a,
      b,
      a,
      b,
    );
  for (const ddl of [
    "CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT)",
    "CREATE TABLE t(id INTEGER PRIMARY KEY DESC,v TEXT)",
    "CREATE TABLE t(id INTEGER,v TEXT,PRIMARY KEY(id DESC))",
  ]) {
    add("rowid", {
      schema: [ddl],
      seed: [op("INSERT INTO t VALUES(-2,'a'),(-1,'b')")],
      steps: [
        op(
          "INSERT INTO t(v) VALUES('auto') RETURNING rowid AS physical_id,id AS declared_id",
        ),
        op("SELECT rowid,id,v FROM t ORDER BY rowid"),
      ],
      observe: [op("SELECT last_insert_rowid(),changes()")],
    });
    add("primary-desc", {
      schema: [ddl],
      steps: [
        op(
          "INSERT INTO t VALUES(NULL,'a') RETURNING rowid AS physical_id,id AS declared_id",
        ),
        op(
          "INSERT INTO t VALUES(NULL,'b') RETURNING rowid AS physical_id,id AS declared_id",
        ),
        op("SELECT rowid,id,v FROM t ORDER BY rowid"),
      ],
    });
  }
  add("rowid", {
    schema: ["CREATE TABLE t(v TEXT)"],
    steps: [
      op("INSERT INTO t(rowid,v) VALUES(-1,'a')"),
      op("INSERT INTO t(v) VALUES('b')"),
      op("SELECT rowid,v FROM t ORDER BY rowid"),
    ],
  });
  for (const command of ["ROLLBACK", "ROLLBACK TO s"])
    add("transaction-metadata", {
      schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY)"],
      steps: [
        op("INSERT INTO t VALUES(1)"),
        op(command === "ROLLBACK" ? "BEGIN" : "SAVEPOINT s"),
        op("INSERT INTO t VALUES(7)"),
        op(command),
        op("SELECT last_insert_rowid(),changes()"),
        ...(command === "ROLLBACK" ? [] : [op("RELEASE s")]),
      ],
      observe: [op("SELECT * FROM t ORDER BY id")],
    });
  add("replace-not-null", {
    schema: [
      "CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT NOT NULL DEFAULT 'fallback')",
    ],
    seed: [op("INSERT INTO t VALUES(1,'old')")],
    steps: [op("INSERT OR REPLACE INTO t VALUES(1,NULL) RETURNING id,v")],
    observe: [op("SELECT * FROM t ORDER BY id")],
  });
  add("replace-not-null", {
    schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT NOT NULL)"],
    seed: [op("INSERT INTO t VALUES(1,'old')")],
    steps: [op("INSERT OR REPLACE INTO t VALUES(1,NULL)")],
    observe: [op("SELECT * FROM t ORDER BY id")],
  });
  for (const conflict of ["", "OR IGNORE", "OR REPLACE"])
    add("statement-atomicity", {
      schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT NOT NULL)"],
      seed: [op("INSERT INTO t VALUES(1,'keep')")],
      steps: [
        op(`INSERT ${conflict} INTO t VALUES(2,'first'),(3,NULL)`),
        op(`INSERT ${conflict} INTO t VALUES(2,'first'),(1,'duplicate')`),
      ],
      observe: [
        op("SELECT * FROM t ORDER BY id"),
        op("SELECT changes(),last_insert_rowid()"),
      ],
    });
  add("fk-definition-order", {
    schema: [
      "CREATE TABLE c(id INTEGER PRIMARY KEY,p INTEGER REFERENCES p(id))",
      "CREATE TABLE p(id INTEGER PRIMARY KEY)",
    ],
    steps: [op("INSERT INTO p VALUES(1)"), op("INSERT INTO c VALUES(2,1)")],
    observe: [op("SELECT * FROM c ORDER BY id")],
  });
  add("fk-parent-collation", {
    schema: [
      "CREATE TABLE p(k TEXT COLLATE BINARY)",
      "CREATE UNIQUE INDEX uq ON p(k COLLATE NOCASE)",
      "CREATE TABLE c(k TEXT REFERENCES p(k))",
    ],
    steps: [op("INSERT INTO p VALUES('a')"), op("INSERT INTO c VALUES('a')")],
    observe: [op("SELECT * FROM c")],
  });
  add("fk-set-default", {
    schema: [
      "CREATE TABLE p(id INTEGER PRIMARY KEY)",
      "CREATE TABLE c(id INTEGER PRIMARY KEY,p INTEGER DEFAULT 1 REFERENCES p(id) ON DELETE SET DEFAULT)",
    ],
    seed: [op("INSERT INTO p VALUES(1),(2)"), op("INSERT INTO c VALUES(3,2)")],
    steps: [op("DELETE FROM p WHERE id=2"), op("DELETE FROM p WHERE id=1")],
    observe: [
      op("SELECT * FROM p ORDER BY id"),
      op("SELECT * FROM c ORDER BY id"),
    ],
  });
  for (const type of ["INT", "INTEGER", "REAL", "TEXT", "BLOB", "ANY"])
    for (const value of [
      "0x10",
      "0b10",
      "0o10",
      "1_000",
      "01",
      "1.0",
      1n,
      1,
      1.5,
      new Uint8Array([1]),
      null,
    ]) {
      add("strict-affinity", {
        schema: [`CREATE TABLE t(id INTEGER PRIMARY KEY,v ${type}) STRICT`],
        steps: [
          op("INSERT INTO t VALUES(1,?)", value),
          op("UPDATE t SET v=? WHERE id=1", value),
        ],
        observe: [op("SELECT v,typeof(v) FROM t ORDER BY id")],
      });
    }
  for (const kind of ["LEFT", "RIGHT", "FULL", "INNER"])
    for (const lt of ["INTEGER", "TEXT", "BLOB", "ANY"])
      for (const rt of ["INTEGER", "TEXT", "BLOB"]) {
        add("join-affinity", {
          schema: [
            `CREATE TABLE a(k ${lt},v TEXT) STRICT`,
            `CREATE TABLE b(k ${rt},w TEXT)`,
          ],
          seed: [
            op(
              `INSERT INTO a VALUES(${lt === "BLOB" ? "x'31'" : lt === "TEXT" ? "'01'" : 1},'a'),(NULL,'n')`,
            ),
            op("INSERT INTO b VALUES('1','b'),('2','c'),(NULL,'z')"),
          ],
          steps: [
            op(
              `SELECT k,typeof(k),a.k,b.k,k=1,k='1',k=2,k='2' FROM a ${kind} JOIN b USING(k) ORDER BY a.v,b.w`,
            ),
          ],
        });
      }
  for (const kind of ["LEFT", "RIGHT", "FULL", "INNER"])
    add("join-collation", {
      schema: [
        "CREATE TABLE a(k ANY) STRICT",
        "CREATE TABLE b(k TEXT COLLATE NOCASE)",
      ],
      seed: [op("INSERT INTO a VALUES('a')"), op("INSERT INTO b VALUES('A')")],
      steps: [
        op(`SELECT a.k,b.k FROM a ${kind} JOIN b USING(k) ORDER BY a.k,b.k`),
      ],
    });
  add("join-hidden-rowid", {
    schema: ["CREATE TABLE a(v INTEGER)", "CREATE TABLE b(w INTEGER)"],
    seed: [op("INSERT INTO a VALUES(1)"), op("INSERT INTO b VALUES(2)")],
    steps: [op("SELECT * FROM a FULL JOIN b USING(rowid)")],
  });
  add("join-chain", {
    schema: [
      "CREATE TABLE a(k INTEGER)",
      "CREATE TABLE b(k INTEGER)",
      "CREATE TABLE c(k INTEGER)",
    ],
    seed: [
      op("INSERT INTO a VALUES(1),(2)"),
      op("INSERT INTO b VALUES(2),(3)"),
      op("INSERT INTO c VALUES(3),(4)"),
    ],
    steps: [
      op(
        "SELECT k,a.k,b.k,c.k FROM a FULL JOIN b USING(k) FULL JOIN c USING(k) ORDER BY k",
      ),
    ],
  });
  for (const collation of ["BINARY", "NOCASE", "RTRIM"])
    for (const table of ["", " WITHOUT ROWID"])
      for (const key of ["a", "A", "a ", "a\0b", "a\0c", 1n, 1, null]) {
        add("primary-lookup", {
          schema: [
            `CREATE TABLE t(k TEXT COLLATE ${collation},n INT,v TEXT,PRIMARY KEY(k,n))${table}`,
          ],
          seed: [
            op(
              "INSERT INTO t VALUES(?,?,?),(?,?,?)",
              "a",
              1n,
              "a",
              "a\0b",
              2n,
              "nul",
            ),
          ],
          steps: [
            op("SELECT v FROM t WHERE k=? AND n=? ORDER BY v", key, 1n),
            op("SELECT v FROM t WHERE +k=? AND n=? ORDER BY v", key, 1n),
            op(
              "UPDATE t SET v='changed' WHERE k=? AND n=? RETURNING v",
              key,
              2n,
            ),
          ],
          observe: [op("SELECT k,n,v FROM t ORDER BY k,n")],
        });
      }
  for (const collation of ["BINARY", "NOCASE"])
    add("unique-nul", {
      schema: [`CREATE TABLE t(k TEXT COLLATE ${collation} PRIMARY KEY)`],
      steps: [
        op("INSERT INTO t VALUES(?)", "a\0b"),
        op("INSERT INTO t VALUES(?)", "a\0c"),
      ],
      observe: [op("SELECT hex(k) FROM t ORDER BY hex(k)")],
    });
  for (const sql of [
    "SELECT count(*),sum(v),total(v),avg(v),min(v),max(v) FROM t",
    "SELECT sum(v),typeof(sum(v)),total(v) FROM t",
    "SELECT v COLLATE NOCASE,count(*) FROM t GROUP BY v COLLATE NOCASE ORDER BY v COLLATE NOCASE",
    "SELECT min(v COLLATE NOCASE),max(v COLLATE NOCASE) FROM t",
    "SELECT group_concat(v) FROM t",
    "SELECT count(DISTINCT v) FROM t",
  ])
    for (const values of [
      [],
      [1n, 2n, 3n],
      [9223372036854775807n, 1n],
      [9223372036854775807n, "bad", 1n],
      ["a", "A", "b"],
      [null, null],
    ])
      add("aggregate", {
        schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,v)"],
        seed: values.map((v, i) =>
          op("INSERT INTO t VALUES(?,?)", BigInt(i + 1), v),
        ),
        steps: [op(sql)],
      });
  for (const sql of [
    "SELECT json_extract('{\"a\":1,\"a\":2}','$.a')",
    'SELECT json(\'{"a":1,"a":2}\')',
    "SELECT json_object('a',json('true'),'b',json('null'))",
    "SELECT json_set('[1,2]','$[#]',3)",
    "SELECT json_extract('[1,2,3]','$[#-1]')",
    "SELECT json_remove('{\"a\":1,\"b\":2}','$.a')",
    "SELECT json_extract('{bad}','$.a')",
    "SELECT json_valid('{bad}')",
  ])
    read("json", sql);
  for (const sql of [
    "SELECT date('2024-02-30'),julianday('2024-02-30')",
    "SELECT date('2024-01-31','+1 month')",
    "SELECT date('2000-02-29','+1 year')",
    "SELECT datetime(0,'unixepoch'),unixepoch('1970-01-01 00:00:00')",
    "SELECT strftime('%Y-%m-%d %H:%M:%f','2024-02-29 12:34:56.789')",
    "SELECT date('1900-02-29'),date('2000-02-29')",
  ])
    read("datetime", sql);
  for (const query of [
    "SELECT id,n,sum(n) OVER(ORDER BY n) FROM t ORDER BY id",
    "SELECT id,n,last_value(n) OVER(ORDER BY n) FROM t ORDER BY id",
    "SELECT id,n,rank() OVER(ORDER BY n),dense_rank() OVER(ORDER BY n) FROM t ORDER BY id",
    "SELECT id,n,sum(n) OVER(ORDER BY n ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) FROM t ORDER BY id",
  ])
    add("window", {
      schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)"],
      seed: [op("INSERT INTO t VALUES(1,1),(2,1),(3,2),(4,NULL)")],
      steps: [op(query)],
    });
  add("migration-default", {
    dynamicOnly: true,
    schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY) STRICT"],
    seed: [op("INSERT INTO t VALUES(1)")],
    steps: [
      op("ALTER TABLE t ADD COLUMN v INT DEFAULT 'bad'"),
      op("PRAGMA table_info(t)"),
    ],
    observe: [op("SELECT * FROM t ORDER BY id")],
  });
  add("migration-fk", {
    dynamicOnly: true,
    schema: [
      "CREATE TABLE p(id INTEGER PRIMARY KEY)",
      "CREATE TABLE c(id INTEGER PRIMARY KEY,p INTEGER REFERENCES p(id))",
    ],
    seed: [op("INSERT INTO p VALUES(1)"), op("INSERT INTO c VALUES(2,1)")],
    steps: [op("ALTER TABLE p RENAME TO q"), op("DELETE FROM q WHERE id=1")],
    observe: [op("SELECT * FROM c ORDER BY id")],
  });
  // A deterministic stream of successful and failing writes exercises warm
  // primary caches, statement rollback and uniqueness after each operation.
  let state = seed >>> 0;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  for (let sample = 0; sample < 128; sample++) {
    const steps: DifferentialOperation[] = [];
    for (let i = 0; i < 24; i++) {
      const id = BigInt((random() % 9) - 2),
        v = [null, "a", "A", "b", "b ", String(random() % 4)][random() % 6]!;
      switch (random() % 4) {
        case 0:
          steps.push(
            op(
              "INSERT INTO t VALUES(?,?,?)",
              id,
              v,
              BigInt((random() % 7) - 2),
            ),
          );
          break;
        case 1:
          steps.push(
            op(
              "UPDATE t SET k=?,n=? WHERE id=?",
              v,
              BigInt((random() % 7) - 2),
              id,
            ),
          );
          break;
        case 2:
          steps.push(op("DELETE FROM t WHERE id=?", id));
          break;
        default:
          steps.push(
            op("SELECT id,k,n FROM t WHERE id=? ORDER BY id", String(id)),
          );
      }
    }
    add("mutation-sequence", {
      schema: [
        "CREATE TABLE t(id INTEGER PRIMARY KEY,k TEXT COLLATE NOCASE UNIQUE,n INTEGER NOT NULL CHECK(n>=0))",
      ],
      steps,
      observe: [
        op("SELECT id,k,n FROM t ORDER BY id"),
        op("SELECT changes(),last_insert_rowid()"),
      ],
    });
  }
  return cases.concat(auditFixCorpus());
}
