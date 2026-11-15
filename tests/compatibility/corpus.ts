import { statement as s } from "../../src/client.ts";
import type { Statement, Value } from "../../src/contract.ts";
import type { CompatibilityCase, CompatibilityStep } from "./contract.ts";
const write = (...statements: Statement[]): CompatibilityStep => ({
  kind: "execute",
  statements,
});
const read = (
  sql: string,
  params: Value[] = [],
  ordered = true,
): CompatibilityStep => ({ kind: "query", statement: s(sql, params), ordered });
const reject = (
  error: string,
  ...statements: Statement[]
): CompatibilityStep => ({ kind: "execute", statements, error });
export const compatibilityProfile = {
  id: "browser-sqlite@1",
  oracle: "native node:sqlite",
  scope:
    "ordinary tables and the cases/features listed here; not all possible SQLite programs",
  nonGoals: [
    "native extensions",
    "ATTACH",
    "transaction-control SQL",
    "virtual tables",
    "triggers",
    "query-plan equivalence",
    "unspecified row order",
  ],
};
export function compatibilityCorpus(seeds = 32): CompatibilityCase[] {
  const cases: CompatibilityCase[] = [
    {
      id: "typed-values",
      features: ["int64", "blob", "null", "unicode", "real"],
      steps: [
        write(
          s(
            "CREATE TABLE typed(id INTEGER PRIMARY KEY,n INTEGER,r REAL,t TEXT,b BLOB)",
          ),
          s("INSERT INTO typed VALUES(?,?,?,?,?)", [
            1n,
            9223372036854775807n,
            1.25,
            "日本語😀\u0000",
            new Uint8Array([0, 255, 128]),
          ]),
          s("INSERT INTO typed VALUES(?,?,?,?,?)", [
            2n,
            -9223372036854775808n,
            -0.25,
            "",
            new Uint8Array(),
          ]),
        ),
        read("SELECT id,n,typeof(n),r,typeof(r),t,b FROM typed ORDER BY id"),
        read(
          "SELECT n<9223372036854775808.0 AS below,n=9223372036854775808.0 AS equal FROM typed WHERE id=1",
        ),
      ],
    },
    {
      id: "affinity-and-null",
      features: ["affinity", "three-valued-logic", "ordering"],
      steps: [
        write(
          s(
            "CREATE TABLE affinity(id INTEGER PRIMARY KEY,n NUMERIC,t TEXT,b BLOB)",
          ),
          s(
            "INSERT INTO affinity VALUES(1,'3.0e+5',123,123),(2,'001','A',NULL),(3,NULL,NULL,x'00'),(4,'not-number','a',x'ff')",
          ),
        ),
        read(
          "SELECT id,n,typeof(n),t,typeof(t),b,typeof(b) FROM affinity ORDER BY id",
        ),
        read("SELECT id FROM affinity WHERE n=? ORDER BY id", ["300000"]),
        read(
          "SELECT NULL=NULL AS eq,NULL IS NULL AS is_null,NOT NULL AS neg,1 OR NULL AS or_null,0 AND NULL AS and_null",
        ),
        read("SELECT id FROM affinity ORDER BY n,id"),
        read("SELECT id FROM affinity ORDER BY t COLLATE NOCASE,id"),
      ],
    },
    {
      id: "unicode-sort",
      features: ["binary-collation", "unicode"],
      steps: [
        write(
          s("CREATE TABLE words(v TEXT PRIMARY KEY NOT NULL)"),
          s("INSERT INTO words VALUES(?),(?),(?),(?)", [
            "😀",
            "\ue000",
            "a",
            "A",
          ]),
        ),
        read("SELECT v FROM words ORDER BY v COLLATE BINARY"),
      ],
    },
    {
      id: "constraints-and-rollback",
      features: [
        "unique",
        "check",
        "not-null",
        "atomic-batch",
        "or-ignore",
        "returning",
      ],
      steps: [
        write(
          s(
            "CREATE TABLE constraints_test(id INTEGER PRIMARY KEY,v TEXT NOT NULL UNIQUE,n INTEGER CHECK(n>=0))",
          ),
          s("INSERT INTO constraints_test VALUES(1,'one',0)"),
        ),
        reject(
          "constraint-unique",
          s("UPDATE constraints_test SET n=7 WHERE id=1"),
          s("INSERT INTO constraints_test VALUES(2,'one',1)"),
        ),
        read("SELECT * FROM constraints_test ORDER BY id"),
        reject(
          "constraint-not-null",
          s("INSERT INTO constraints_test VALUES(2,NULL,1)"),
        ),
        reject(
          "constraint-check",
          s("UPDATE constraints_test SET n=-1 WHERE id=1"),
        ),
        write(s("INSERT OR IGNORE INTO constraints_test VALUES(2,'one',9)")),
        read("SELECT * FROM constraints_test ORDER BY id"),
        write(
          s("UPDATE constraints_test SET n=n+1 WHERE id=1 RETURNING id,v,n"),
        ),
        read("SELECT * FROM constraints_test ORDER BY id"),
      ],
    },
    {
      id: "foreign-keys",
      features: ["foreign-keys", "cascade", "atomic-batch"],
      steps: [
        write(
          s("CREATE TABLE parent(id INTEGER PRIMARY KEY)"),
          s(
            "CREATE TABLE child(id INTEGER PRIMARY KEY,pid INTEGER NOT NULL REFERENCES parent(id) ON DELETE CASCADE)",
          ),
          s("INSERT INTO parent VALUES(1)"),
          s("INSERT INTO child VALUES(1,1)"),
        ),
        reject("constraint-foreign-key", s("INSERT INTO child VALUES(2,999)")),
        read("SELECT * FROM child ORDER BY id"),
        write(s("DELETE FROM parent WHERE id=1")),
        read("SELECT * FROM child ORDER BY id"),
      ],
    },
    {
      id: "composite-without-rowid",
      features: [
        "composite-primary-key",
        "without-rowid",
        "upsert",
        "unique-index",
      ],
      steps: [
        write(
          s(
            "CREATE TABLE composite(a TEXT NOT NULL,b INTEGER NOT NULL,v TEXT,PRIMARY KEY(a,b)) WITHOUT ROWID",
          ),
          s("INSERT INTO composite VALUES('a',1,'x'),('b',2,'y')"),
          s(
            "INSERT INTO composite VALUES('a',1,'z') ON CONFLICT(a,b) DO UPDATE SET v=excluded.v",
          ),
        ),
        read("SELECT * FROM composite ORDER BY a,b"),
        write(s("CREATE UNIQUE INDEX composite_v ON composite(v)")),
        reject(
          "constraint-unique",
          s("UPDATE composite SET v='z' WHERE a='b'"),
        ),
        read("SELECT * FROM composite ORDER BY a,b"),
      ],
    },
    {
      id: "joins-and-aggregates",
      features: ["join", "group-by", "aggregate", "window", "cte"],
      steps: [
        write(
          s("CREATE TABLE people(id INTEGER PRIMARY KEY,name TEXT)"),
          s(
            "CREATE TABLE events(id INTEGER PRIMARY KEY,person INTEGER,n INTEGER)",
          ),
          s("INSERT INTO people VALUES(1,'one'),(2,'two'),(3,'empty')"),
          s("INSERT INTO events VALUES(1,1,2),(2,1,4),(3,2,NULL)"),
        ),
        read(
          "SELECT p.id,p.name,COUNT(e.id) AS count,SUM(e.n) AS total,AVG(e.n) AS avg FROM people p LEFT JOIN events e ON p.id=e.person GROUP BY p.id,p.name ORDER BY p.id",
        ),
        read(
          "WITH totals AS (SELECT person,SUM(n) AS n FROM events GROUP BY person) SELECT person,n,row_number() OVER(ORDER BY person) AS position FROM totals ORDER BY person",
        ),
      ],
    },
    {
      id: "ddl-and-json",
      features: ["alter-table", "default", "json", "view"],
      steps: [
        write(
          s("CREATE TABLE documents(id INTEGER PRIMARY KEY,body TEXT)"),
          s('INSERT INTO documents VALUES(1,\'{"n":7,"v":null}\')'),
          s(
            "ALTER TABLE documents ADD COLUMN score INTEGER NOT NULL DEFAULT 3",
          ),
          s(
            "CREATE VIEW document_values AS SELECT id,json_extract(body,'$.n') AS n,score FROM documents",
          ),
        ),
        read("SELECT * FROM document_values ORDER BY id"),
        write(
          s("DROP VIEW document_values"),
          s("ALTER TABLE documents RENAME COLUMN score TO value"),
        ),
        read("SELECT * FROM documents ORDER BY id"),
      ],
    },
    {
      id: "missing-table-rollback",
      features: ["atomic-batch", "missing-table"],
      steps: [
        reject(
          "missing-table",
          s("INSERT INTO notes(id,title) VALUES('rollback','never')"),
          s("INSERT INTO absent VALUES(1)"),
        ),
        read("SELECT id,title FROM notes ORDER BY id"),
      ],
    },
    {
      id: "policy-boundary",
      features: ["reserved-metadata", "transaction-ownership"],
      steps: [
        reject("sql-policy", s("DELETE FROM _bls_state")),
        reject("sql-policy", s("COMMIT")),
        read("SELECT id,title FROM notes ORDER BY id"),
      ],
    },
  ];
  for (let seed = 0; seed < seeds; seed++) {
    let n = seed + 1;
    const random = () => {
      n = (Math.imul(n, 1664525) + 1013904223) >>> 0;
      return n;
    };
    const table = `generated_${seed}`;
    const steps: CompatibilityStep[] = [
      write(
        s(
          `CREATE TABLE ${table}(id INTEGER PRIMARY KEY,n INTEGER NOT NULL,t TEXT,b BLOB)`,
        ),
      ),
    ];
    for (let i = 0; i < 12; i++) {
      const id = random() % 5;
      const delta = Number(random() % 101) - 50;
      const t = [null, "", String(delta), "日本語😀", "0001"][random() % 5]!;
      const b = new Uint8Array([random() % 256, random() % 256]);
      steps.push(
        write(
          s(
            `INSERT INTO ${table}(id,n,t,b) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET n=n+excluded.n,t=excluded.t,b=excluded.b`,
            [id, delta, t, b],
          ),
        ),
      );
      steps.push(
        read(
          `SELECT id,n,typeof(n),t,typeof(t),hex(b) AS b FROM ${table} WHERE n>=? OR t IS NULL ORDER BY n DESC,id LIMIT 4`,
          [Number(random() % 31) - 15],
        ),
      );
    }
    cases.push({
      id: `seed-${seed}`,
      features: [
        "generated",
        "upsert",
        "bind",
        "ordering",
        "limit",
        "blob",
        "null",
      ],
      steps,
    });
  }
  return cases;
}
