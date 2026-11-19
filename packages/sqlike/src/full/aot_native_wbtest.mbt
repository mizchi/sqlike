///|
test "native AOT prepared values reuse a statement and clear transient state" {
  let (db, connection, _, bindings) = aot_bench_fixture()
  let query = aot_prepare_values(db, "point")
  assert_eq(connection.statements, 1)
  let rows = aot_prepared_values(query, bindings).unwrap()
  assert_true(rows == [[Integer(500L), Integer(499L), Text("note")]])
  let statement = query.statement.unwrap()
  assert_true(statement.rows.is_empty())
  assert_true(statement.parameters.all(v => v is Null))
  assert_true(aot_prepared_values(query, "[]") is Err(_))
  assert_true(aot_prepared_values(query, bindings).unwrap() == rows)
  assert_eq(connection.statements, 1)
  assert_eq(aot_finalize_values(query), "{}")
  assert_eq(connection.statements, 0)
  assert_true(query.statement is None)
  assert_true(aot_prepared_values(query, bindings) is Err(_))
  assert_eq(aot_finalize_values(query), "{}")
}

///|
test "native AOT results reject writes before creating a statement" {
  let program = compile_program(
    (
      #|{"schema":["CREATE TABLE t(id INTEGER PRIMARY KEY)"],"queries":[{"name":"add","sql":"INSERT INTO t VALUES(?) RETURNING id"}]}
    ),
  )
  let db = aot_open(program, "")
  let (connection, _) = db.ready()
  let before = aot_dump(db)
  let query = aot_prepare_values(db, "add")
  assert_true(aot_prepared_values(query, "[]") is Err(_))
  assert_eq(connection.statements, 0)
  assert_eq(aot_dump(db), before)
}

///|
test "native bindings share statement cleanup and atomic writes without JSON conversion" {
  let program = compile_program(
    (
      #|{"schema":["CREATE TABLE t(id INTEGER PRIMARY KEY,b BLOB,n INTEGER CHECK(n>0))"],"queries":[{"name":"add","sql":"INSERT INTO t VALUES(?,?,?) RETURNING id,b,n"},{"name":"q","sql":"SELECT b,n*2 FROM t WHERE id=?"},{"name":"set","sql":"UPDATE t SET n=? WHERE id=?"}]}
    ),
  )
  let db = aot_open(program, "")
  let bytes = b"\x01\xff"
  let result = aot_native_execute(db, "add", [
    Integer(1L),
    Blob(bytes),
    Integer(3L),
  ]).unwrap()
  assert_true(result.rows == [[Integer(1L), Blob(bytes), Integer(3L)]])
  assert_eq(result.changes, 1)
  let query = aot_prepare_values(db, "q")
  assert_true(
    aot_native_values(query, [Integer(1L)]).unwrap() ==
    [[Blob(bytes), Integer(6L)]],
  )
  assert_true(aot_native_values(query, []) is Err(_))
  assert_true(
    aot_native_execute(db, "set", [Integer(-1L), Integer(1L)]) is Err(_),
  )
  assert_true(
    aot_native_values(query, [Integer(1L)]).unwrap() ==
    [[Blob(bytes), Integer(6L)]],
  )
  let statement = query.statement.unwrap()
  assert_true(statement.rows.is_empty())
  assert_true(statement.parameters.all(v => v is Null))
  ignore(aot_finalize_values(query))
  let (connection, _) = db.ready()
  assert_eq(connection.statements, 0)
}
