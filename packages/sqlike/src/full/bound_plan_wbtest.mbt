///|
test "AOT lowers UPDATE expressions and key access into a separate execution plan" {
  let artifact = compile_program(
    "{\"schema\":[\"CREATE TABLE t(id INTEGER PRIMARY KEY,n REAL,body TEXT COLLATE NOCASE)\"],\"queries\":[{\"name\":\"set\",\"sql\":\"UPDATE t SET n=n+? WHERE id=? AND body=? RETURNING id,n,body\"},{\"name\":\"get\",\"sql\":\"SELECT id,n,body FROM t WHERE id=? AND body=?\"}]}",
  )
  let program = Program::load(artifact)
  let update = program.query("set").update.unwrap()
  assert_true(update.access is BoundRowid(_, _))
  assert_true(update.predicate is BoundBinary("and", _, _))
  assert_true(
    update.setters[0].expression
    is BoundBinary("+", BoundColumn(1, _), BoundParameter(0)),
  )
  assert_true(update.returning.values[0] is BoundColumn(0, false))
  let selection = program.query("get").selection.unwrap()
  assert_true(selection.point is Some(_))
}

///|
test "fully bound expressions do not materialize an evaluation environment" {
  let artifact = compile_program(
    "{\"schema\":[\"CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)\"],\"queries\":[{\"name\":\"set\",\"sql\":\"UPDATE t SET n=n+? WHERE id=? RETURNING n\"}]}",
  )
  let plan = Program::load(artifact).query("set").update.unwrap()
  let input : BoundInput = {
    store: database_open().store,
    params: [Integer(2L), Integer(1L)],
    row: { id: 1L, values: [Integer(1L), Integer(3L)], },
    layout: plan.layout,
    context: None,
    joined: None,
    in_lists: [],
  }
  assert_true(evaluate_bound(plan.predicate, input) == Integer(1L))
  assert_true(evaluate_bound(plan.setters[0].expression, input) == Integer(5L))
  assert_true(input.context is None)
}

///|
test "scalar point projections retain primary access without flattening every row" {
  let program = Program::load(
    compile_program(
      (
        #|{"schema":["CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER,s TEXT)"],"queries":[{"name":"get","sql":"SELECT n*2,upper(s),id IS TRUE FROM t WHERE id=? AND n>?"},{"name":"aggregate","sql":"SELECT count(*) FROM t WHERE id=?"},{"name":"window","sql":"SELECT row_number() OVER() FROM t WHERE id=?"}]}
      ),
    ),
  )
  assert_true(program.query("get").selection.unwrap().point is Some(_))
  assert_true(program.query("aggregate").selection.unwrap().point is None)
  assert_true(program.query("window").selection.unwrap().point is None)
}
