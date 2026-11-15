///|
/// Phase probes use the existing Statement/JSON ABI. Setup is outside each
/// timed closure; reset/finalize is included where needed. The phase timings
/// are independent microbenchmarks, not additive parts of the full call.
fn aot_bench_fixture() -> (AotDatabase, Connection, Program, String) raise {
  let artifact = compile_program(
    "{\"schema\":[\"CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER,title TEXT)\"],\"queries\":[{\"name\":\"point\",\"sql\":\"SELECT id,n,title FROM t WHERE id=?\"}]}",
  )
  let db = aot_open(artifact, "")
  let (connection, program) = db.ready()
  let values = Array::makei(1000, i => "(\{i + 1},\{i},'note')")
  let result = database_exec(
    connection.database,
    "INSERT INTO t VALUES" + values.join(","),
    "[]",
    false,
  )
  assert_false(result.contains("error"))
  (db, connection, program, "[{\"t\":\"integer\",\"v\":\"500\"}]")
}

///|
test "AOT phase prepare and finalize" (b : @bench.T) {
  let (_, connection, program, _) = aot_bench_fixture()
  b.bench(fn() {
    try {
      let statement = connection.prepare_compiled(program.query("point"))
      b.keep(statement)
      statement.finalize()
    } catch {
      _ => abort("AOT phase failed")
    }
  })
}

///|
test "AOT phase decode bind and reset" (b : @bench.T) {
  let (_, connection, program, bindings) = aot_bench_fixture()
  let statement = connection.prepare_compiled(program.query("point"))
  b.bench(fn() {
    try {
      let values : Array[Json] = @json.from_json(@json.parse(bindings))
      let params = values.map(json_value)
      for i, value in params {
        statement.bind(index=i + 1, value)
      }
      b.keep(statement)
      statement.reset(clear_bindings=true)
    } catch {
      _ => abort("AOT phase failed")
    }
  })
  statement.finalize()
}

///|
test "AOT phase execute and reset" (b : @bench.T) {
  let (_, connection, program, _) = aot_bench_fixture()
  let statement = connection.prepare_compiled(program.query("point"))
  statement.bind(index=1, 500L)
  b.bench(fn() {
    try {
      while statement.step() {
        b.keep(statement)
      }
      statement.reset()
    } catch {
      _ => abort("AOT phase failed")
    }
  })
  statement.finalize()
}

///|
test "AOT phase columns and JSON marshal" (b : @bench.T) {
  let (_, connection, program, _) = aot_bench_fixture()
  let query = program.query("point")
  let statement = connection.prepare_compiled(query)
  statement.bind(index=1, 500L)
  assert_true(statement.step())
  b.bench(fn() {
    try {
      let row : Array[Json] = []
      for index in 0..<statement.column_count() {
        let value : Value = statement.column(index~)
        row.push(value_json(value))
      }
      b.keep(
        (
          {
            "names": query.plan.names,
            "rows": [Json::array(row)],
            "readonly": true,
            "changes": connection_changes(connection.database.store),
          } : Json).stringify(),
      )
    } catch {
      _ => abort("AOT phase failed")
    }
  })
  statement.finalize()
}

///|
test "AOT phase full JSON ABI" (b : @bench.T) {
  let (db, _, _, bindings) = aot_bench_fixture()
  b.bench(fn() { b.keep(aot_execute(db, "point", bindings)) })
}
