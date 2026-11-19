///|
fn sql_prepare_fixture() -> (Database, SqlPrepared, String, String) raise {
  let (_, connection, _, bindings) = aot_bench_fixture()
  let sql = "SELECT id,n,title FROM t WHERE id=?"
  let query = database_prepare(connection.database, sql)
  assert_false(
    database_prepared_exec(query, bindings, true, true).contains("error"),
  )
  (connection.database, query, sql, bindings)
}

///|
test "SQL phase parse" (b : @bench.T) {
  let (_, _, sql, _) = sql_prepare_fixture()
  b.bench(fn() {
    b.keep(parse_statement(lex(sql))) catch {
      _ => abort("parse phase")
    }
  })
}

///|
test "SQL phase prepare metadata" (b : @bench.T) {
  let (_, query, _, _) = sql_prepare_fixture()
  b.bench(fn() {
    query.epoch = -1L
    try {
      prepare_sql_metadata(query)
      b.keep(query)
    } catch {
      _ => abort("prepare phase")
    }
  })
}

///|
test "SQL phase bind decode" (b : @bench.T) {
  let (_, _, _, bindings) = sql_prepare_fixture()
  b.bench(fn() {
    try {
      let values : Array[Json] = @json.from_json(@json.parse(bindings))
      b.keep(values.map(json_value))
    } catch {
      _ => abort("bind phase")
    }
  })
}

///|
test "SQL phase prepared execution" (b : @bench.T) {
  let (_, query, _, _) = sql_prepare_fixture()
  b.bench(fn() {
    b.keep(prepared_sql_rows(query, [Integer(500L)])) catch {
      _ => abort("execute phase")
    }
  })
}

///|
test "SQL phase result JSON" (b : @bench.T) {
  let (_, query, _, _) = sql_prepare_fixture()
  let rows = prepared_sql_rows(query, [Integer(500L)])
  b.bench(fn() { b.keep(positional_result_json(rows, true)) })
}

///|
test "SQL phase uncached JSON ABI" (b : @bench.T) {
  let (db, _, sql, bindings) = sql_prepare_fixture()
  b.bench(fn() { b.keep(database_query_values(db, sql, bindings)) })
}

///|
test "SQL phase prepared JSON ABI" (b : @bench.T) {
  let (_, query, _, bindings) = sql_prepare_fixture()
  b.bench(fn() { b.keep(database_prepared_exec(query, bindings, true, true)) })
}
