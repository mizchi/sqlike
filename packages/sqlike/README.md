# mizchi/sqlike

A SQLite subset for MoonBit, with dynamic SQL, precompiled statements and SQLite image import/export. Supports JS and Wasm GC without a dependency on Litestream.

Tested with MoonBit `0.10.21+06da1ed44`; older core libraries lack the required JSON decoding API.

```sh
moon add mizchi/sqlike@0.2.0
```

Import `"mizchi/sqlike"` from `moon.pkg`:

```moonbit
let db = @sqlike.Connection::open(":memory:")
let statement = db.prepare("SELECT ?")
statement.bind(index=1, 9007199254740993L)
if statement.step() {
  let value : Int64 = statement.column(index=0)
  assert_eq(value, 9007199254740993L)
}
statement.finalize()
db.close()
```

Bind indices start at 1; column indices start at 0. Public interfaces include `Connection`, `Statement`, `Bind`, `Column` and `Value`.

| Package | Purpose |
| --- | --- |
| `mizchi/sqlike` | Baseline SQL and typed values: CRUD, RETURNING, JOINs, aggregates, indexes, transactions, FK and STRICT |
| `mizchi/sqlike/full` | All implemented SQL features, including JSON, CTEs, triggers and windows |
| `mizchi/sqlike/aot` | Programs and named prepared statements without the SQL parser; JS/Wasm GC |
| `mizchi/sqlike/compiler` | Build-time schema and SQL compilation |
| `mizchi/sqlike/fts` | Optional full-text search, separate from the SQL runtime |

When upgrading from 0.1.2, imports using JSON, CTEs, triggers or windows must move to `mizchi/sqlike/full`. Entry types are independent; do not pass a `Connection` or `Statement` between entries. AOT connections open compiled program text and prepare queries by their registered name.

SQLite compatibility is a tested subset. Unsupported SQL is rejected explicitly. [Supported SQL](https://github.com/mizchi/sqlike/blob/main/docs/sql.md) · [Source generation and build targets](https://github.com/mizchi/sqlike/blob/main/docs/build-targets.md).

JavaScript/TypeScript users can install `@mizchi/sqlike`. [Getting started](https://github.com/mizchi/sqlike) · [Predefined schemas and IndexedDB](https://github.com/mizchi/sqlike/blob/main/docs/prepared.md). MIT.
