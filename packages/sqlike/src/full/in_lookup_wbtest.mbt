///|
test "aggregate row IN slot filters preserve collation and nullable tuple residuals" {
  let db = database_open()
  ignore(
    database_exec(
      db, "CREATE TABLE t(n NUMERIC,s TEXT COLLATE NOCASE)", "[]", false,
    ),
  )
  guard parse_statement(
      lex(
        "SELECT count(*) FROM t WHERE (n,s) IN (" +
        Array::make(16, "(?,?)").join(",") +
        ")",
      ),
    )
    is Select(select) else {
    fail("select")
  }
  let prepared = prepare_selection(db.store, select, 32)
  let params : Array[Value] = []
  for _ in 0..<8 {
    params.push(Integer(1L))
    params.push(Text("a"))
    params.push(Null)
    params.push(Text("b"))
  }
  let context = {
    ..evaluation(db.store, params, []),
    in_lists: in_list_frames(prepared.in_lists),
  }
  guard in_list_aggregate_filter(select, context) is Some(filter) else {
    fail("missing row slot filter")
  }
  assert_true(filter({ id: 1L, values: [Integer(1L), Text("A")], }))
  assert_false(filter({ id: 2L, values: [Integer(2L), Text("A")], }))
  assert_false(filter({ id: 3L, values: [Integer(2L), Text("B")], }))
  assert_false(filter({ id: 4L, values: [Null, Text("A")], }))
}

///|
test "aggregate IN filters read physical slots and share only per-execution RHS state" {
  let db = database_open()
  ignore(database_exec(db, "CREATE TABLE t(n NUMERIC)", "[]", false))
  guard parse_statement(
      lex(
        "SELECT count(*),sum(n) FROM t WHERE n IN (" +
        Array::make(16, "?").join(",") +
        ")",
      ),
    )
    is Select(select) else {
    fail("select")
  }
  let prepared = prepare_selection(db.store, select, 16)
  let context = {
    ..evaluation(db.store, Array::make(16, Integer(1L)), []),
    in_lists: in_list_frames(prepared.in_lists),
  }
  guard in_list_aggregate_filter(select, context) is Some(filter) else {
    fail("missing slot filter")
  }
  assert_true(filter({ id: 1L, values: [Integer(1L)], }))
  assert_false(filter({ id: 2L, values: [Integer(2L)], }))
  assert_false(filter({ id: 3L, values: [Null], }))
  let other = {
    ..context,
    params: Array::make(16, Integer(2L)),
    in_lists: in_list_frames(prepared.in_lists),
  }
  guard in_list_aggregate_filter(select, other) is Some(filter) else {
    fail("missing slot filter")
  }
  assert_false(filter({ id: 1L, values: [Integer(1L)], }))
  assert_true(filter({ id: 2L, values: [Integer(2L)], }))
}

///|
test "integer IN hash keys preserve exact equality at floating-point boundaries" {
  for
    n in [
      0L, 1L, -1L, 9007199254740993L, -9223372036854775808L, 9223372036854775807L,
    ] {
    assert_eq(in_list_integer_key(Integer(n)), Some(n))
  }
  assert_eq(in_list_integer_key(Real(-0.0)), Some(0L))
  assert_eq(
    in_list_integer_key(Real(9007199254740992.0)),
    Some(9007199254740992L),
  )
  assert_eq(
    in_list_integer_key(Real(-9223372036854775808.0)),
    Some(-9223372036854775808L),
  )
  let noninteger : Array[Value] = [
    Real(9223372036854775808.0),
    Real(1.5),
    Text("1"),
    Blob(b"1"),
    Null,
  ]
  for value in noninteger {
    assert_eq(in_list_integer_key(value), None)
  }
}

///|
test "IN lookups are lazy and owned by each execution, never the prepared query" {
  let db = database_open()
  assert_false(
    database_exec(db, "CREATE TABLE t(n INTEGER)", "[]", false).contains(
      "error",
    ),
  )
  let placeholders = Array::make(16, "?").join(",")
  guard parse_statement(
      lex("SELECT n FROM t WHERE n IN (" + placeholders + ")"),
    )
    is Select(select) else {
    fail("select")
  }
  let plan = prepare_selection(db.store, select, 16)
  assert_eq(plan.in_lists.length(), 1)
  let first = in_list_frames(plan.in_lists)
  let second = in_list_frames(plan.in_lists)
  assert_true(first[0].lookup is None && second[0].lookup is None)
  let table = get_table(db.store, "t")
  let row = row_environment(table, { id: 1L, values: [Integer(1L)], }, "t")
  let one = {
    ..evaluation(db.store, Array::make(16, Integer(1L)), row),
    in_lists: first,
  }
  let two = {
    ..evaluation(db.store, Array::make(16, Integer(2L)), row),
    in_lists: second,
  }
  assert_true(evaluate(select.predicate, one) == Integer(1L))
  assert_true(first[0].lookup is Some(_))
  assert_true(second[0].lookup is None)
  assert_true(evaluate(select.predicate, two) == Integer(0L))
  assert_true(one.nested().in_lists.is_empty())
}

///|
test "row IN lookup plans retain schema facts and build nullable tuples per execution" {
  let db = database_open()
  assert_false(
    database_exec(
      db, "CREATE TABLE t(n NUMERIC,s TEXT COLLATE NOCASE)", "[]", false,
    ).contains("error"),
  )
  let tuples = Array::make(16, "(?,?)").join(",")
  guard parse_statement(lex("SELECT n FROM t WHERE (n,s) IN (" + tuples + ")"))
    is Select(select) else {
    fail("select")
  }
  let plan = prepare_selection(db.store, select, 32)
  assert_eq(plan.in_lists.length(), 1)
  assert_true(plan.in_lists[0].row is Some(_))
  let frames = in_list_frames(plan.in_lists)
  let params : Array[Value] = []
  for _ in 0..<16 {
    params.push(Null)
    params.push(Text("a"))
  }
  let table = get_table(db.store, "t")
  let ctx = {
    ..evaluation(
      db.store,
      params,
      row_environment(table, { id: 1L, values: [Integer(1L), Text("A")], }, "t"),
    ),
    in_lists: frames,
  }
  assert_true(evaluate(select.predicate, ctx) is Null)
  assert_true(frames[0].lookup is Some(_))
}
