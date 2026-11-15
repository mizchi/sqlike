import { outputPolicyCases } from "./output-policy-corpus.ts";
import type { AuditFeature, AuditStep } from "./feature-audit.ts";
import { featureSetup } from "./feature-probes.ts";
const q = (sql: string, error?: string): AuditStep => ({
  kind: "query",
  sql,
  ...(error ? { error } : {}),
});
const e = (sql: string, error?: string): AuditStep => ({
  kind: "exec",
  sql,
  ...(error ? { error } : {}),
});
const extra: [string, string, string, AuditStep[]][] = [
  [
    "cast",
    "expression",
    "lang_expr.html",
    [
      q(
        "SELECT CAST('123tail' AS INTEGER),CAST(1 AS TEXT),CAST('1.5' AS REAL),CAST('a' AS BLOB)",
      ),
    ],
  ],
  [
    "bitwise",
    "expression",
    "lang_expr.html",
    [q("SELECT 7&3,4|1,1<<3,8>>2,~1")],
  ],
  [
    "is-distinct",
    "expression",
    "lang_expr.html",
    [q("SELECT NULL IS DISTINCT FROM 1,NULL IS NOT DISTINCT FROM NULL")],
  ],
  ["glob", "expression", "lang_expr.html", [q("SELECT 'abc' GLOB 'a*'")]],
  [
    "like-escape",
    "expression",
    "lang_expr.html",
    [q("SELECT 'a_b' LIKE 'a!_b' ESCAPE '!'")],
  ],
  [
    "row-values",
    "expression",
    "rowvalue.html",
    [q("SELECT (1,2)<(1,3),(1,2) IN((1,2),(2,3))")],
  ],
  [
    "numeric-hex",
    "expression",
    "lang_expr.html",
    [q("SELECT 0x7fffffffffffffff,0x8000000000000000")],
  ],
  [
    "numeric-underscore",
    "expression",
    "lang_expr.html",
    [q("SELECT 1_000,0xF_F,1.2_3e+2")],
  ],
  [
    "bind-positional",
    "expression",
    "lang_expr.html",
    [{ kind: "query", sql: "SELECT ?1,?2,?1", params: [1n, "x"] }],
  ],
  [
    "bind-named",
    "expression",
    "lang_expr.html",
    [{ kind: "query", sql: "SELECT :x,:x" }],
  ],
  [
    "null-and-affinity",
    "expression",
    "datatype3.html",
    [q("SELECT n='1',+n='1',NULL=NULL,NULL IS NULL FROM t ORDER BY id")],
  ],
  [
    "scalar-subquery",
    "expression",
    "lang_expr.html",
    [
      q(
        "SELECT id,(SELECT n FROM t AS inner_t WHERE inner_t.id=t.id) FROM t ORDER BY id",
      ),
    ],
  ],
  [
    "exists",
    "expression",
    "lang_expr.html",
    [
      q(
        "SELECT EXISTS(SELECT abs(-9223372036854775808)),EXISTS(SELECT 1 WHERE 0)",
      ),
    ],
  ],
  [
    "case-lazy",
    "expression",
    "lang_expr.html",
    [q("SELECT CASE WHEN 1 THEN 7 ELSE abs(-9223372036854775808) END")],
  ],
  [
    "int64-boundaries",
    "expression",
    "datatype3.html",
    [
      q(
        "SELECT 9223372036854775807,-9223372036854775808,9223372036854775807+1,-9223372036854775808%-1",
      ),
    ],
  ],
  [
    "overflow-error",
    "expression",
    "lang_corefunc.html#abs",
    [q("SELECT abs(-9223372036854775808)", "integer overflow")],
  ],
  ["values", "select", "lang_select.html", [q("VALUES(1,2),(3,4)")]],
  [
    "union",
    "select",
    "lang_select.html",
    [q("SELECT n FROM t UNION SELECT 7 ORDER BY 1")],
  ],
  [
    "union-all",
    "select",
    "lang_select.html",
    [q("SELECT 1 UNION ALL SELECT 1")],
  ],
  [
    "intersect",
    "select",
    "lang_select.html",
    [q("SELECT id FROM t INTERSECT SELECT 2 ORDER BY 1")],
  ],
  [
    "except",
    "select",
    "lang_select.html",
    [q("SELECT id FROM t EXCEPT SELECT 2 ORDER BY 1")],
  ],
  [
    "derived-table",
    "select",
    "lang_select.html",
    [q("SELECT x.n FROM(SELECT n FROM t) AS x ORDER BY n")],
  ],
  [
    "inner-join",
    "select",
    "lang_select.html",
    [q("SELECT a.id,b.n FROM t AS a JOIN t AS b ON a.id=b.id ORDER BY a.id")],
  ],
  [
    "left-join",
    "select",
    "lang_select.html",
    [
      q(
        "SELECT a.id,b.n FROM t AS a LEFT JOIN t AS b ON a.id=b.id+1 ORDER BY a.id",
      ),
    ],
  ],
  [
    "right-join",
    "select",
    "lang_select.html",
    [
      q(
        "SELECT a.id,b.id FROM t AS a RIGHT JOIN t AS b ON a.id=b.id+1 ORDER BY b.id",
      ),
    ],
  ],
  [
    "full-join",
    "select",
    "lang_select.html",
    [
      q(
        "SELECT a.id,b.id FROM t AS a FULL OUTER JOIN t AS b ON a.id=b.id+1 ORDER BY a.id,b.id",
      ),
    ],
  ],
  [
    "using-join",
    "select",
    "lang_select.html",
    [q("SELECT id FROM t AS a JOIN t AS b USING(id) ORDER BY id")],
  ],
  [
    "natural-join",
    "select",
    "lang_select.html",
    [q("SELECT id FROM t AS a NATURAL JOIN t AS b ORDER BY id")],
  ],
  [
    "cross-join",
    "select",
    "lang_select.html",
    [q("SELECT a.id,b.id FROM t AS a CROSS JOIN t AS b ORDER BY a.id,b.id")],
  ],
  [
    "group-collation",
    "select",
    "lang_select.html",
    [q("SELECT s,count(*) FROM t GROUP BY s ORDER BY s")],
  ],
  [
    "having",
    "select",
    "lang_select.html",
    [q("SELECT n,count(*) FROM t GROUP BY n HAVING count(*)>0 ORDER BY n")],
  ],
  [
    "aggregate-distinct",
    "select",
    "lang_aggfunc.html",
    [q("SELECT count(DISTINCT n),sum(DISTINCT n) FROM t")],
  ],
  [
    "aggregate-filter",
    "select",
    "lang_aggfunc.html",
    [q("SELECT count(*) FILTER(WHERE n>1) FROM t")],
  ],
  [
    "aggregate-order",
    "select",
    "lang_aggfunc.html",
    [q("SELECT group_concat(s,',' ORDER BY id DESC) FROM t")],
  ],
  [
    "empty-aggregate",
    "select",
    "lang_aggfunc.html",
    [q("SELECT count(*),sum(n),total(n),avg(n) FROM t WHERE 0")],
  ],
  [
    "distinct-collation",
    "select",
    "lang_select.html",
    [q("SELECT DISTINCT s FROM t ORDER BY 1")],
  ],
  [
    "nulls-order",
    "select",
    "lang_select.html",
    [q("SELECT n FROM t ORDER BY n DESC NULLS FIRST")],
  ],
  [
    "limit-offset",
    "select",
    "lang_select.html",
    [q("SELECT id FROM t ORDER BY id LIMIT 1 OFFSET 1")],
  ],
  [
    "recursive-cte",
    "select",
    "lang_with.html",
    [
      q(
        "WITH RECURSIVE r(n) AS(VALUES(1) UNION ALL SELECT n+1 FROM r WHERE n<4) SELECT n FROM r ORDER BY n",
      ),
    ],
  ],
  [
    "materialized-cte",
    "select",
    "lang_with.html",
    [q("WITH a AS MATERIALIZED(SELECT n FROM t) SELECT n FROM a ORDER BY n")],
  ],
  [
    "cte-columns",
    "select",
    "lang_with.html",
    [q("WITH a(x) AS(SELECT n FROM t) SELECT x FROM a ORDER BY x")],
  ],
  [
    "window-partition",
    "select",
    "windowfunctions.html",
    [
      q(
        "SELECT id,row_number() OVER(PARTITION BY s ORDER BY id) FROM t ORDER BY id",
      ),
    ],
  ],
  [
    "window-rows",
    "select",
    "windowfunctions.html",
    [
      q(
        "SELECT id,sum(n) OVER(ORDER BY id ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) FROM t ORDER BY id",
      ),
    ],
  ],
  [
    "window-range",
    "select",
    "windowfunctions.html",
    [
      q(
        "SELECT id,sum(n) OVER(ORDER BY n RANGE BETWEEN 1 PRECEDING AND CURRENT ROW) FROM t ORDER BY id",
      ),
    ],
  ],
  [
    "window-groups-exclude",
    "select",
    "windowfunctions.html",
    [
      q(
        "SELECT id,count(*) OVER(ORDER BY n GROUPS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW EXCLUDE TIES) FROM t ORDER BY id",
      ),
    ],
  ],
  [
    "window-named",
    "select",
    "windowfunctions.html",
    [q("SELECT id,sum(n) OVER w FROM t WINDOW w AS(ORDER BY id) ORDER BY id")],
  ],
  [
    "strict-table",
    "ddl",
    "stricttables.html",
    [
      e("CREATE TABLE strict_values(n INTEGER) STRICT"),
      e("INSERT INTO strict_values VALUES(1)"),
      e("INSERT INTO strict_values VALUES('text')", "cannot store"),
      q("SELECT n FROM strict_values"),
    ],
  ],
  [
    "generated-virtual",
    "ddl",
    "gencol.html",
    [
      e(
        "CREATE TABLE generated(a INTEGER,b INTEGER GENERATED ALWAYS AS(a+1) VIRTUAL)",
      ),
      e("INSERT INTO generated(a) VALUES(2)"),
      q("SELECT a,b FROM generated"),
    ],
  ],
  [
    "generated-stored",
    "ddl",
    "gencol.html",
    [
      e(
        "CREATE TABLE generated(a INTEGER,b INTEGER GENERATED ALWAYS AS(a+1) STORED)",
      ),
      e("INSERT INTO generated(a) VALUES(2)"),
      q("SELECT a,b FROM generated"),
    ],
  ],
  [
    "temporary-table",
    "ddl",
    "lang_createtable.html",
    [
      e("CREATE TEMP TABLE tmp(n INTEGER)"),
      e("INSERT INTO tmp VALUES(4)"),
      q("SELECT n FROM tmp"),
    ],
  ],
  [
    "create-as-select",
    "ddl",
    "lang_createtable.html",
    [
      e("CREATE TABLE copied AS SELECT id,n FROM t"),
      q("SELECT * FROM copied ORDER BY id"),
    ],
  ],
  [
    "without-rowid",
    "ddl",
    "withoutrowid.html",
    [
      e("CREATE TABLE wr(a TEXT,b INTEGER,PRIMARY KEY(a,b)) WITHOUT ROWID"),
      e("INSERT INTO wr VALUES('a',1)"),
      q("SELECT a,b FROM wr"),
    ],
  ],
  [
    "autoincrement",
    "ddl",
    "autoinc.html",
    [
      e("CREATE TABLE ai(id INTEGER PRIMARY KEY AUTOINCREMENT,n INTEGER)"),
      e("INSERT INTO ai(n) VALUES(1),(2)"),
      e("DELETE FROM ai WHERE id=2"),
      e("INSERT INTO ai(n) VALUES(3)"),
      q("SELECT id FROM ai ORDER BY id"),
    ],
  ],
  [
    "default-expression",
    "ddl",
    "lang_createtable.html",
    [
      e("CREATE TABLE defaults(n INTEGER DEFAULT(1+2))"),
      e("INSERT INTO defaults DEFAULT VALUES"),
      q("SELECT n FROM defaults"),
    ],
  ],
  [
    "partial-index",
    "ddl",
    "partialindex.html",
    [
      e("CREATE INDEX pi ON t(n) WHERE n IS NOT NULL"),
      q("SELECT n FROM t WHERE n IS NOT NULL ORDER BY n"),
    ],
  ],
  [
    "expression-index",
    "ddl",
    "expridx.html",
    [
      e("CREATE INDEX ei ON t(lower(s))"),
      q("SELECT id FROM t WHERE lower(s)='a' ORDER BY id"),
    ],
  ],
  [
    "alter-rename-table",
    "ddl",
    "lang_altertable.html",
    [
      e("ALTER TABLE t RENAME TO renamed"),
      q("SELECT id FROM renamed ORDER BY id"),
    ],
  ],
  [
    "alter-rename-column",
    "ddl",
    "lang_altertable.html",
    [
      e("ALTER TABLE t RENAME COLUMN s TO label"),
      q("SELECT label FROM t ORDER BY id"),
    ],
  ],
  [
    "alter-drop-column",
    "ddl",
    "lang_altertable.html",
    [e("ALTER TABLE t DROP COLUMN s"), q("SELECT * FROM t ORDER BY id")],
  ],
  [
    "insert-select",
    "dml",
    "lang_insert.html",
    [
      e("INSERT INTO t(id,n) SELECT id+3,n FROM t"),
      q("SELECT id,n FROM t ORDER BY id"),
    ],
  ],
  [
    "update-from",
    "dml",
    "lang_update.html",
    [
      e("CREATE TABLE changes(id INTEGER,n INTEGER)"),
      e("INSERT INTO changes VALUES(1,99)"),
      e("UPDATE t SET n=changes.n FROM changes WHERE t.id=changes.id"),
      q("SELECT n FROM t WHERE id=1"),
    ],
  ],
  [
    "upsert-target-where",
    "dml",
    "lang_upsert.html",
    [
      e("CREATE UNIQUE INDEX un ON t(n) WHERE n IS NOT NULL"),
      e(
        "INSERT INTO t(id,n) VALUES(4,1) ON CONFLICT(n) WHERE n IS NOT NULL DO UPDATE SET n=9",
      ),
      q("SELECT id,n FROM t ORDER BY id"),
    ],
  ],
  [
    "returning-insert",
    "dml",
    "lang_returning.html",
    [
      {
        kind: "returning",
        sql: "INSERT INTO t(id,n) VALUES(4,4) RETURNING id AS id,n AS n",
      },
    ],
  ],
  [
    "returning-delete",
    "dml",
    "lang_returning.html",
    [
      {
        kind: "returning",
        sql: "DELETE FROM t WHERE id=1 RETURNING id AS id,n AS n",
      },
    ],
  ],
  [
    "check-null",
    "constraint",
    "lang_createtable.html",
    [
      e("CREATE TABLE checks(n INTEGER CHECK(n>0))"),
      e("INSERT INTO checks VALUES(NULL)"),
      e("INSERT INTO checks VALUES(-1)", "CHECK constraint failed"),
      q("SELECT n FROM checks"),
    ],
  ],
  [
    "foreign-key-composite",
    "constraint",
    "foreignkeys.html",
    [
      e("CREATE TABLE parent(a INTEGER,b INTEGER,PRIMARY KEY(a,b))"),
      e(
        "CREATE TABLE child(a INTEGER,b INTEGER,FOREIGN KEY(a,b) REFERENCES parent(a,b))",
      ),
      e("INSERT INTO parent VALUES(1,2)"),
      e("INSERT INTO child VALUES(1,2)"),
      e("INSERT INTO child VALUES(1,3)", "FOREIGN KEY constraint failed"),
      q("SELECT * FROM child"),
    ],
  ],
  [
    "foreign-key-set-null",
    "constraint",
    "foreignkeys.html",
    [
      e("CREATE TABLE child(p INTEGER REFERENCES t(id) ON DELETE SET NULL)"),
      e("INSERT INTO child VALUES(1)"),
      e("DELETE FROM t WHERE id=1"),
      q("SELECT p FROM child"),
    ],
  ],
  [
    "foreign-key-update-cascade",
    "constraint",
    "foreignkeys.html",
    [
      e("CREATE TABLE child(p INTEGER REFERENCES t(id) ON UPDATE CASCADE)"),
      e("INSERT INTO child VALUES(1)"),
      e("UPDATE t SET id=4 WHERE id=1"),
      q("SELECT p FROM child"),
    ],
  ],
  [
    "foreign-key-deferred",
    "constraint",
    "foreignkeys.html",
    [
      e(
        "CREATE TABLE child(p INTEGER REFERENCES t(id) DEFERRABLE INITIALLY DEFERRED)",
      ),
      e("BEGIN"),
      e("INSERT INTO child VALUES(4)"),
      e("INSERT INTO t(id,n) VALUES(4,4)"),
      e("COMMIT"),
      q("SELECT p FROM child"),
    ],
  ],
  [
    "conflict-fail",
    "constraint",
    "lang_conflict.html",
    [
      e("CREATE TABLE u(n INTEGER UNIQUE)"),
      e("INSERT INTO u VALUES(1)"),
      e("INSERT OR FAIL INTO u VALUES(2),(1),(3)", "UNIQUE constraint failed"),
      q("SELECT n FROM u ORDER BY n"),
    ],
  ],
  [
    "conflict-rollback",
    "constraint",
    "lang_conflict.html",
    [
      e("BEGIN"),
      e("INSERT INTO t VALUES(4,4,NULL)"),
      e(
        "INSERT OR ROLLBACK INTO t VALUES(1,9,NULL)",
        "UNIQUE constraint failed",
      ),
      q("SELECT id FROM t ORDER BY id"),
    ],
  ],
  [
    "pragma-assignment",
    "pragma-behavior",
    "pragma.html",
    [e("PRAGMA user_version=42"), q("PRAGMA user_version")],
  ],
  [
    "pragma-unknown",
    "pragma-behavior",
    "pragma.html",
    [q("PRAGMA unknown_feature_audit_setting")],
  ],
  [
    "pragma-table-function",
    "pragma-behavior",
    "pragma.html",
    [q("SELECT name,type,pk FROM pragma_table_info('t') ORDER BY cid")],
  ],
  [
    "pragma-query-only",
    "pragma-behavior",
    "pragma.html",
    [
      e("PRAGMA query_only=ON"),
      e("INSERT INTO t VALUES(4,4,NULL)", "readonly"),
      q("SELECT id FROM t ORDER BY id"),
    ],
  ],
  [
    "date-modifiers",
    "date-behavior",
    "lang_datefunc.html",
    [
      q(
        "SELECT date('2024-01-31','+1 month','floor'),datetime(0,'unixepoch'),unixepoch('1970-01-01')",
      ),
    ],
  ],
  [
    "json-paths",
    "json-behavior",
    "json1.html",
    [
      q(
        `SELECT json_extract('{"a":[1,{"b":2}]}','$.a[1].b'),json_extract('[1,2]','$[#-1]')`,
      ),
    ],
  ],
  [
    "json-null",
    "json-behavior",
    "json1.html",
    [
      q(
        `SELECT json_type('{"a":null}','$.a'),typeof(json_extract('{"a":null}','$.a')),json_type('{}','$.a')`,
      ),
    ],
  ],
  [
    "json5",
    "json-behavior",
    "json1.html",
    [q(`SELECT json_valid('{a:1}',2),json('{a:1}')`)],
  ],
  [
    "jsonb-roundtrip",
    "json-behavior",
    "json1.html",
    [q(`SELECT json(jsonb('{"a":[1,2]}')),json_valid(jsonb('{"a":1}'),8)`)],
  ],
];
export function additionalFeatures(): AuditFeature[] {
  const features = extra.map(([id, category, page, steps]) => ({
    id: `behavior/${id}`,
    category,
    title: id,
    source: `https://www.sqlite.org/${page}`,
    steps: [...featureSetup, ...steps],
  }));
  const requirements: [string, string, string][] = [
    [
      "physical-sqlite-write",
      "fileformat2.html",
      "No SQLite physical B-tree / freelist / pointer-map writer exists; logical images are not SQLite files",
    ],
    [
      "wal-write-recovery",
      "wal.html",
      "No WAL writer or native hot-WAL recovery exists; LTX committed-image reading does not establish this",
    ],
    [
      "rollback-journal-recovery",
      "lockingv3.html",
      "No native rollback-journal / hot-journal crash recovery verification",
    ],
    [
      "vfs-locking",
      "vfs.html",
      "IndexedDB generation checks are not a tested implementation of SQLite VFS file locks and shared-memory methods",
    ],
    [
      "multi-connection-isolation",
      "isolation.html",
      "Native two-connection reader/writer snapshots, busy errors and lock transitions have not been differentially verified",
    ],
    [
      "backup-restore",
      "backup.html",
      "SQLite online backup/restore incremental API is not exposed or verified",
    ],
    [
      "incremental-blob",
      "c3ref/blob_open.html",
      "Incremental BLOB read/write API is not exposed or verified",
    ],
    [
      "custom-functions-collations",
      "c3ref/create_function.html",
      "User-defined scalar/aggregate/window functions and custom collations have no equivalent public registration API",
    ],
    [
      "authorizer-hooks",
      "c3ref/set_authorizer.html",
      "Native authorizer, commit/rollback/update/preupdate hooks are not exposed or verified",
    ],
    [
      "interrupt-progress-limits",
      "c3ref/interrupt.html",
      "Native interruption, progress handlers, run-time limits and error codes have not been verified",
    ],
    [
      "memory-io-faults",
      "testing.html",
      "OOM, disk-full, short-write, fsync and power-loss schedules have not been exhaustively injected",
    ],
    [
      "full-upstream-tcl",
      "testing.html",
      "Complete public Tcl suite has not run against the MoonBit API; it requires a compatible Tcl/C test binding",
    ],
    [
      "th3",
      "th3.html",
      "Proprietary TH3 harness is unavailable in this workspace; no passing result is claimed",
    ],
    [
      "dbsqlfuzz",
      "testing.html",
      "Complete proprietary dbsqlfuzz corpus and campaigns have not run against this engine",
    ],
    [
      "all-build-options",
      "compile.html",
      "All compile-time option combinations, encodings, extension builds and platforms have not been verified",
    ],
    [
      "browser-platforms",
      "wasm/doc/trunk/index.md",
      "Chromium checks do not establish Firefox/WebKit or every browser storage implementation",
    ],
    [
      "resource-limits",
      "limits.html",
      "MoonBit parser/result/image limits intentionally differ; boundary equivalence to native SQLite is not established",
    ],
  ];
  return [
    ...features,
    ...outputPolicyCases().map(
      (c, i): AuditFeature => ({
        id: `output-policy/${i}`,
        category: "output-policy",
        title: c.sql,
        source: "https://www.sqlite.org/lang_expr.html",
        steps: [
          ...c.schema.map((sql) => ({ kind: "exec" as const, sql })),
          ...c.seed.map((sql) => ({ kind: "exec" as const, sql })),
          {
            kind: /^UPDATE/.test(c.sql) ? "exec" : "query",
            sql: c.sql,
            params: c.params,
            ...(c.sql === "PRAGMA foreign_key_check(missing)"
              ? { error: "no such table" }
              : c.nativeError
                ? { error: c.nativeError }
                : {}),
          },
        ],
      }),
    ),
    ...requirements.map(([id, page, reason]) => ({
      id: `requirement/${id}`,
      category: "system-requirement",
      title: id,
      source: `https://www.sqlite.org/${page}`,
      reason,
    })),
  ];
}
