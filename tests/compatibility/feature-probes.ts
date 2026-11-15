import type {
  AuditFeature,
  AuditStep,
  OracleCapabilities,
} from "./feature-audit.ts";
export interface CatalogEntry {
  category: string;
  name: string;
  source: string;
}
export interface FeatureCatalog {
  format: number;
  counts: Record<string, number>;
  entries: CatalogEntry[];
  sources: { url: string; sha256: string; bytes: number }[];
}
const exec = (sql: string, error?: string): AuditStep => ({
  kind: "exec",
  sql,
  ...(error ? { error } : {}),
});
const query = (sql: string, unordered = false): AuditStep => ({
  kind: "query",
  sql,
  unordered,
});
export const featureSetup: AuditStep[] = [
  exec("PRAGMA foreign_keys=ON"),
  exec(
    "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER,s TEXT COLLATE NOCASE)",
  ),
  exec("INSERT INTO t VALUES(1,1,'A'),(2,2,'b'),(3,NULL,'a')"),
  exec("CREATE INDEX idx_t_n ON t(n)"),
];
const scalarArgs: Record<string, string[]> = {
  abs: ["-7"],
  changes: [],
  char: ["65", "128512"],
  coalesce: ["NULL", "2", "'x'"],
  concat: ["'a'", "NULL", "'b'"],
  concat_ws: ["':'", "'a'", "NULL", "'b'"],
  format: ["'%s-%d'", "'a'", "2"],
  glob: ["'a*'", "'abc'"],
  hex: ["x'00ff'"],
  if: ["0", "'bad'", "1", "'yes'", "'else'"],
  ifnull: ["NULL", "3"],
  iif: ["0", "'bad'", "1", "'yes'", "'else'"],
  instr: ["'abc'", "'b'"],
  last_insert_rowid: [],
  length: ["'😀a'"],
  like: ["'a!_%'", "'a_x'", "'!'"],
  likelihood: ["1", "0.5"],
  likely: ["1"],
  lower: ["'AbÇ'"],
  ltrim: ["'xyabcxy'", "'xy'"],
  max: ["1", "3", "2"],
  min: ["1", "3", "2"],
  nullif: ["1", "1"],
  octet_length: ["'😀a'"],
  printf: ["'%s-%d'", "'a'", "2"],
  quote: ["'a''b'"],
  random: [],
  randomblob: ["8"],
  replace: ["'abcabc'", "'b'", "'x'"],
  round: ["1.2345", "2"],
  rtrim: ["'xyabcxy'", "'xy'"],
  sign: ["-9"],
  soundex: ["'Robert'"],
  sqlite_compileoption_get: ["0"],
  sqlite_compileoption_used: ["'ENABLE_FTS5'"],
  sqlite_offset: ["n"],
  sqlite_source_id: [],
  sqlite_version: [],
  substr: ["'abcdef'", "2", "3"],
  substring: ["'abcdef'", "2", "3"],
  total_changes: [],
  trim: ["'xyabcxy'", "'xy'"],
  typeof: ["x'00'"],
  unhex: ["'aabb'", "' '"],
  unicode: ["'😀'"],
  unistr: ["'\\0041\\+01F600'"],
  unistr_quote: ["'hello'"],
  unlikely: ["0"],
  upper: ["'AbÇ'"],
  zeroblob: ["3"],
};
const mathArgs: Record<string, string[]> = {
  acos: ["0.5"],
  acosh: ["2"],
  asin: ["0.5"],
  asinh: ["2"],
  atan: ["1"],
  atan2: ["1", "2"],
  atanh: ["0.5"],
  ceil: ["1.2"],
  ceiling: ["1.2"],
  cos: ["1"],
  cosh: ["1"],
  degrees: ["1"],
  exp: ["1"],
  floor: ["1.8"],
  ln: ["2"],
  log: ["2", "8"],
  log10: ["100"],
  log2: ["8"],
  mod: ["7", "2"],
  pi: [],
  pow: ["2", "3"],
  power: ["2", "3"],
  radians: ["180"],
  sin: ["1"],
  sinh: ["1"],
  sqrt: ["4"],
  tan: ["1"],
  tanh: ["1"],
  trunc: ["-1.8"],
};
const aggregateArgs: Record<string, string[]> = {
  avg: ["n"],
  count: ["n"],
  group_concat: ["n", "':'"],
  max: ["n"],
  median: ["n"],
  min: ["n"],
  percentile: ["n", "50"],
  percentile_cont: ["n", "0.5"],
  percentile_disc: ["n", "0.5"],
  string_agg: ["n", "':'"],
  sum: ["n"],
  total: ["n"],
};
const windowArgs: Record<string, string[]> = {
  row_number: [],
  rank: [],
  dense_rank: [],
  percent_rank: [],
  cume_dist: [],
  ntile: ["2"],
  lag: ["n", "1", "9"],
  lead: ["n", "1", "9"],
  first_value: ["n"],
  last_value: ["n"],
  nth_value: ["n", "2"],
};
function call(
  signature: string,
  args: string[] | undefined,
): string | undefined {
  if (!args) return;
  const name = signature.split("(")[0]!;
  const inside = signature.slice(name.length + 1, -1);
  if (inside === "*") return `${name}(*)`;
  const count = !inside
    ? 0
    : inside.includes("...")
      ? args.length
      : inside.split(",").length;
  if (args.length < count)
    throw Error(`Missing sample arguments: ${signature}`);
  return `${name}(${args.slice(0, count).join(",")})`;
}
const jsonSQL: Record<string, string> = {
  json: `json('{"a":1}')`,
  jsonb: `jsonb('{"a":1}')`,
  json_array: `json_array(1,'a',NULL)`,
  jsonb_array: `jsonb_array(1,'a',NULL)`,
  json_array_insert: `json_array_insert('[1,2]','$[1]',9)`,
  jsonb_array_insert: `jsonb_array_insert('[1,2]','$[1]',9)`,
  json_array_length: `json_array_length('[1,null]')`,
  json_error_position: `json_error_position('{"x":}')`,
  json_extract: `json_extract('{"a":2}','$.a')`,
  jsonb_extract: `jsonb_extract('{"a":[1]}','$.a')`,
  "->": `'{"a":2}'->'$.a'`,
  "->>": `'{"a":2}'->>'$.a'`,
  json_object: `json_object('a',1,'b',2)`,
  jsonb_object: `jsonb_object('a',1,'b',2)`,
  json_patch: `json_patch('{"a":1}','{"b":2}')`,
  jsonb_patch: `jsonb_patch('{"a":1}','{"b":2}')`,
  json_pretty: `json_pretty('{"a":1}')`,
  json_quote: `json_quote('a"b')`,
  json_type: `json_type('{"a":1}','$.a')`,
  json_valid: `json_valid('{"a":1}')`,
};
for (const prefix of ["json", "jsonb"])
  for (const action of ["insert", "replace", "set", "remove"])
    jsonSQL[`${prefix}_${action}`] =
      `${prefix}_${action}('{"a":1}','$.a'${action === "remove" ? "" : ",2"})`;
function jsonSteps(name: string): AuditStep[] | undefined {
  if (jsonSQL[name]) return [query(`SELECT ${jsonSQL[name]}`)];
  if (/group_array$/.test(name))
    return [query(`SELECT ${name}(n ORDER BY id) FROM t`)];
  if (/group_object$/.test(name))
    return [query(`SELECT ${name}(id,n ORDER BY id) FROM t`)];
  if (/_(each|tree)$/.test(name))
    return [
      query(`SELECT key,value,type FROM ${name}('[1,null]') ORDER BY id`),
    ];
}
const language: Record<string, AuditStep[]> = {
  "aggregate functions": [query("SELECT count(*),sum(n),avg(n) FROM t")],
  "ALTER TABLE": [
    exec("ALTER TABLE t ADD COLUMN extra INTEGER DEFAULT 7"),
    query("SELECT id,extra FROM t ORDER BY id"),
  ],
  ANALYZE: [
    exec("ANALYZE"),
    query("SELECT tbl,idx,stat FROM sqlite_stat1 ORDER BY tbl,idx"),
  ],
  "ATTACH DATABASE": [
    exec("ATTACH DATABASE ':memory:' AS aux"),
    exec("CREATE TABLE aux.attached(n)"),
    exec("INSERT INTO aux.attached VALUES(7)"),
    query("SELECT n FROM aux.attached"),
  ],
  "BEGIN TRANSACTION": [
    exec("BEGIN"),
    exec("INSERT INTO t VALUES(4,4,NULL)"),
    exec("ROLLBACK"),
    query("SELECT id FROM t ORDER BY id"),
  ],
  comment: [query("SELECT /* block */ 1 AS n -- line\n")],
  "COMMIT TRANSACTION": [
    exec("BEGIN"),
    exec("INSERT INTO t VALUES(4,4,NULL)"),
    exec("COMMIT"),
    query("SELECT id FROM t ORDER BY id"),
  ],
  "core functions": [query("SELECT abs(-2),length('abc'),coalesce(NULL,3)")],
  "CREATE INDEX": [
    exec("CREATE UNIQUE INDEX ix_s ON t(s COLLATE BINARY)"),
    query("PRAGMA index_info(ix_s)"),
  ],
  "CREATE TABLE": [
    exec("CREATE TABLE other(a INTEGER,b TEXT,UNIQUE(a,b))"),
    exec("INSERT INTO other VALUES(1,'x')"),
    query("SELECT * FROM other"),
  ],
  "CREATE TRIGGER": [
    exec("CREATE TABLE log(n INTEGER)"),
    exec(
      "CREATE TRIGGER tr AFTER INSERT ON t BEGIN INSERT INTO log VALUES(new.id); END",
    ),
    exec("INSERT INTO t VALUES(4,4,NULL)"),
    query("SELECT n FROM log"),
  ],
  "CREATE VIEW": [
    exec("CREATE VIEW v AS SELECT id,n FROM t WHERE n IS NOT NULL"),
    query("SELECT * FROM v ORDER BY id"),
  ],
  "CREATE VIRTUAL TABLE": [
    exec("CREATE VIRTUAL TABLE vt USING fts5(body)"),
    exec("INSERT INTO vt VALUES('hello world')"),
    query("SELECT rowid FROM vt WHERE vt MATCH 'hello'"),
  ],
  "date and time functions": [query("SELECT date('2024-02-29','+1 day')")],
  DELETE: [
    exec("DELETE FROM t WHERE id=2"),
    query("SELECT id FROM t ORDER BY id"),
  ],
  "DETACH DATABASE": [
    exec("ATTACH DATABASE ':memory:' AS aux"),
    exec("DETACH DATABASE aux"),
    query("PRAGMA database_list"),
  ],
  "DROP INDEX": [
    exec("DROP INDEX idx_t_n"),
    query("SELECT name FROM sqlite_schema WHERE type='index' ORDER BY name"),
  ],
  "DROP TABLE": [
    exec("DROP TABLE t"),
    query("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name"),
  ],
  "DROP TRIGGER": [
    exec("CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END"),
    exec("DROP TRIGGER tr"),
    query("SELECT name FROM sqlite_schema WHERE type='trigger'"),
  ],
  "DROP VIEW": [
    exec("CREATE VIEW v AS SELECT n FROM t"),
    exec("DROP VIEW v"),
    query("SELECT name FROM sqlite_schema WHERE type='view'"),
  ],
  "END TRANSACTION": [
    exec("BEGIN"),
    exec("UPDATE t SET n=7 WHERE id=1"),
    exec("END"),
    query("SELECT n FROM t WHERE id=1"),
  ],
  EXPLAIN: [query("EXPLAIN SELECT n FROM t WHERE id=1")],
  expression: [
    query("SELECT CASE 1 WHEN 1 THEN 7 END,1 BETWEEN 0 AND 2,NULL IS NULL"),
  ],
  "INDEXED BY": [
    query("SELECT n FROM t INDEXED BY idx_t_n WHERE n>0 ORDER BY n"),
  ],
  INSERT: [
    exec("INSERT INTO t(id,n,s) VALUES(4,4,NULL),(5,5,NULL)"),
    query("SELECT id FROM t ORDER BY id"),
  ],
  "JSON functions": [query(`SELECT json_extract('{"a":2}','$.a')`)],
  keywords: [
    exec('CREATE TABLE "select"("from" INTEGER)'),
    exec('INSERT INTO "select" VALUES(1)'),
    query('SELECT "from" FROM "select"'),
  ],
  "math functions": [query("SELECT sqrt(4),pow(2,3)")],
  "ON CONFLICT clause": [
    exec("INSERT OR IGNORE INTO t VALUES(1,9,'x')"),
    query("SELECT n FROM t WHERE id=1"),
  ],
  PRAGMA: [query("PRAGMA table_info(t)")],
  REINDEX: [exec("REINDEX idx_t_n"), query("SELECT n FROM t ORDER BY n")],
  "RELEASE SAVEPOINT": [
    exec("SAVEPOINT s"),
    exec("INSERT INTO t VALUES(4,4,NULL)"),
    exec("RELEASE s"),
    query("SELECT id FROM t ORDER BY id"),
  ],
  REPLACE: [
    exec("REPLACE INTO t VALUES(1,9,'x')"),
    query("SELECT n,s FROM t WHERE id=1"),
  ],
  "RETURNING clause": [
    {
      kind: "returning",
      sql: "UPDATE t SET n=8 WHERE id=1 RETURNING id AS id,n AS n",
    },
  ],
  "ROLLBACK TRANSACTION": [
    exec("BEGIN"),
    exec("UPDATE t SET n=9"),
    exec("ROLLBACK"),
    query("SELECT n FROM t ORDER BY id"),
  ],
  SAVEPOINT: [
    exec("SAVEPOINT s"),
    exec("UPDATE t SET n=9"),
    exec("ROLLBACK TO s"),
    exec("RELEASE s"),
    query("SELECT n FROM t ORDER BY id"),
  ],
  SELECT: [query("SELECT id,n,s FROM t WHERE n IS NOT NULL ORDER BY id")],
  UPDATE: [
    exec("UPDATE t SET n=n+1 WHERE n IS NOT NULL"),
    query("SELECT n FROM t ORDER BY id"),
  ],
  UPSERT: [
    exec(
      "INSERT INTO t(id,n) VALUES(1,9) ON CONFLICT(id) DO UPDATE SET n=excluded.n",
    ),
    query("SELECT n FROM t WHERE id=1"),
  ],
  VACUUM: [exec("VACUUM"), query("SELECT id,n,s FROM t ORDER BY id")],
  "window functions": [
    query("SELECT id,row_number() OVER(ORDER BY id) FROM t ORDER BY id"),
  ],
  "WITH clause": [
    query("WITH a AS(SELECT id FROM t WHERE n>0) SELECT id FROM a ORDER BY id"),
  ],
};
function catalogFeature(e: CatalogEntry): AuditFeature {
  const feature: AuditFeature = {
    id: `${e.category}/${e.name}`,
    category: e.category,
    title: e.name,
    source: e.source,
  };
  const name = e.name.split("(")[0]!;
  if (e.category === "language") feature.steps = language[e.name];
  else if (["scalar", "math", "aggregate", "window"].includes(e.category)) {
    if (name === "load_extension") {
      feature.reason =
        "Requires native loadable extension ABI and a controlled extension fixture; not exercised";
      return feature;
    }
    const args = (
      {
        scalar: scalarArgs,
        math: mathArgs,
        aggregate: aggregateArgs,
        window: windowArgs,
      } as const
    )[e.category as "scalar" | "math" | "aggregate" | "window"][name];
    const expression = call(e.name, args);
    feature.oracleRequirement = { kind: "function", name };
    if (expression) {
      const sql =
        name === "random"
          ? "SELECT typeof(random())"
          : name === "randomblob"
            ? "SELECT typeof(randomblob(8)),length(randomblob(8))"
            : `SELECT ${expression}${e.category === "aggregate" ? " FROM t" : e.category === "window" ? " OVER(ORDER BY id) FROM t ORDER BY id" : ""}`;
      feature.steps = [query(sql)];
    }
  } else if (e.category === "date") {
    feature.oracleRequirement = { kind: "function", name };
    feature.steps = [
      query(
        name === "timediff"
          ? "SELECT timediff('2024-03-01','2024-02-29')"
          : name === "strftime"
            ? "SELECT strftime('%Y-%m-%d %H:%M:%f','2024-02-29 12:34:56.789')"
            : `SELECT ${name}('2024-02-29 12:34:56','+1 day')`,
      ),
    ];
  } else if (e.category === "json") {
    feature.steps = jsonSteps(name);
    if (!["->", "->>"].includes(name) && !/_(each|tree)$/.test(name))
      feature.oracleRequirement = { kind: "function", name };
  } else if (e.category === "pragma") {
    feature.oracleRequirement = { kind: "pragma", name };
    if (name === "data_store_directory" || name === "temp_store_directory") {
      feature.reason =
        "Process-global filesystem setting requires a separate process fixture";
      return feature;
    }
    const argument = [
      "table_info",
      "table_xinfo",
      "foreign_key_list",
      "foreign_key_check",
      "index_list",
      "integrity_check",
      "quick_check",
    ].includes(name)
      ? "(t)"
      : name === "index_info" || name === "index_xinfo"
        ? "(idx_t_n)"
        : "";
    feature.steps = [
      query(
        `PRAGMA ${name}${["integrity_check", "quick_check"].includes(name) ? "" : argument}`,
        [
          "collation_list",
          "function_list",
          "module_list",
          "pragma_list",
          "compile_options",
        ].includes(name),
      ),
    ];
  } else if (e.category === "api-function") feature.exportName = name;
  else if (e.category.startsWith("api-"))
    feature.reason =
      "C object layout / compile-time constant ABI is not exposed or verified by the JS database contract";
  else if (e.category === "extension") {
    const extension = extensionProbes[e.name];
    if (extension) Object.assign(feature, extension);
    else
      feature.reason =
        "No installed extension fixture or complete API/format verification";
  }
  if (feature.steps) feature.steps = [...featureSetup, ...feature.steps];
  if (!feature.steps && !feature.reason && !feature.exportName)
    feature.reason = "No executable probe for this documented entry point";
  return feature;
}
const extensionProbes: Record<string, Partial<AuditFeature>> = {
  "JSON Functions": {
    steps: [query(`SELECT json_valid('{"a":1}'),json('{"a": 1}')`)],
  },
  "FTS5 - Full Text Search": {
    oracleRequirement: { kind: "module", name: "fts5" },
    steps: [
      exec("CREATE VIRTUAL TABLE ft USING fts5(body)"),
      exec("INSERT INTO ft VALUES('hello world')"),
      query("SELECT rowid FROM ft WHERE ft MATCH 'hello'"),
    ],
  },
  "FTS3 - Full Text Search": {
    oracleRequirement: { kind: "module", name: "fts3" },
    steps: [
      exec("CREATE VIRTUAL TABLE ft USING fts3(body)"),
      exec("INSERT INTO ft VALUES('hello world')"),
      query("SELECT rowid FROM ft WHERE ft MATCH 'hello'"),
    ],
  },
  "R-Tree Module": {
    oracleRequirement: { kind: "module", name: "rtree" },
    steps: [
      exec("CREATE VIRTUAL TABLE rt USING rtree(id,x0,x1,y0,y1)"),
      exec("INSERT INTO rt VALUES(1,0,1,0,1)"),
      query("SELECT id FROM rt WHERE x0>=0"),
    ],
  },
  "Dbstat Virtual Table": {
    oracleRequirement: { kind: "module", name: "dbstat" },
    steps: [
      query("SELECT name,pagetype FROM dbstat WHERE name='t' ORDER BY pageno"),
    ],
  },
  generate_series: {
    oracleRequirement: { kind: "module", name: "generate_series" },
    steps: [query("SELECT value FROM generate_series(1,3) ORDER BY value")],
  },
  "The Percentile Extension": {
    oracleRequirement: { kind: "function", name: "percentile" },
    steps: [query("SELECT percentile(n,50) FROM t")],
  },
};
export function catalogFeatures(catalog: FeatureCatalog): AuditFeature[] {
  return catalog.entries.map(catalogFeature);
}

export function runtimeInventoryGaps(
  capabilities: OracleCapabilities,
  features: AuditFeature[],
): AuditFeature[] {
  const functions = new Set(
    features
      .filter((f) => f.oracleRequirement?.kind === "function")
      .map((f) => f.oracleRequirement!.name),
  );
  const pragmas = new Set(
    features.filter((f) => f.category === "pragma").map((f) => f.title),
  );
  const modules = new Set(
    features
      .filter((f) => f.oracleRequirement?.kind === "module")
      .map((f) => f.oracleRequirement!.name),
  );
  return [
    ...capabilities.functions
      .filter((name) => !functions.has(name))
      .map((name) => ({
        id: `runtime-function/${name}`,
        category: "runtime-function",
        title: name,
        source: "https://www.sqlite.org/pragma.html#pragma_function_list",
        reason:
          "Native build advertises this function; no context/arity-specific probe is available",
      })),
    ...capabilities.pragmas
      .filter((name) => !pragmas.has(name))
      .map((name) => ({
        id: `runtime-pragma/${name}`,
        category: "runtime-pragma",
        title: name,
        source: "https://www.sqlite.org/pragma.html#pragma_pragma_list",
        steps: [...featureSetup, query(`PRAGMA ${name}`)],
      })),
    ...capabilities.modules
      .filter((name) => !modules.has(name))
      .map((name) => ({
        id: `runtime-module/${name}`,
        category: "runtime-module",
        title: name,
        source: "https://www.sqlite.org/pragma.html#pragma_module_list",
        reason:
          "Native build advertises this module; no complete module fixture/API verification is available",
      })),
  ];
}
