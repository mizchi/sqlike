///|
test "IN SELECT aggregate filters use physical slots with the same execution frame" {
  let db = database_open()
  ignore(database_exec(db, "CREATE TABLE t(n INTEGER)", "[]", false))
  ignore(database_exec(db, "CREATE TABLE r(n INTEGER)", "[]", false))
  ignore(database_exec(db, "INSERT INTO r VALUES(1)", "[]", false))
  guard parse_statement(
      lex("SELECT count(*) FROM t WHERE n IN(SELECT n FROM r)"),
    )
    is Select(select) else {
    fail("select")
  }
  let plan = prepare_selection(db.store, select, 0)
  let ctx = {
    ..evaluation(db.store, [], []),
    in_selects: in_select_frames(plan.in_selects),
  }
  guard in_select_aggregate_filter(select, ctx) is Some(filter) else {
    fail("slot filter")
  }
  assert_true(filter({ id: 1L, values: [Integer(1L)], }))
  assert_false(filter({ id: 2L, values: [Integer(2L)], }))
}

///|
test "cache admission failure leaves no RHS in a frame and keeps NULL/empty semantics" {
  let db = database_open()
  ignore(database_exec(db, "CREATE TABLE t(n INTEGER)", "[]", false))
  ignore(database_exec(db, "CREATE TABLE r(n INTEGER)", "[]", false))
  ignore(database_exec(db, "INSERT INTO r VALUES(1),(NULL)", "[]", false))
  guard parse_statement(lex("SELECT n IN(SELECT n FROM r) FROM t"))
    is Select(select) else {
    fail("select")
  }
  let plan = prepare_selection(db.store, select, 0)
  let frames = in_select_frames(
    plan.in_selects,
    budget=in_cache_budget(entries=0, bytes=0),
  )
  let table = get_table(db.store, "t")
  let context = {
    ..evaluation(
      db.store,
      [],
      row_environment(table, { id: 1L, values: [Integer(1L)], }, "t"),
    ),
    in_selects: frames,
  }
  assert_true(
    evaluate(select.projections[0].expression, context) == Integer(1L),
  )
  assert_true(frames[0].disabled && frames[0].lookup is None)
  let other = {
    ..context,
    row: row_environment(table, { id: 2L, values: [Integer(2L)], }, "t"),
  }
  assert_true(evaluate(select.projections[0].expression, other) is Null)
}

///|
test "prepared UPDATE collects immutable IN list facts for predicate SET and RETURNING" {
  let db = database_open()
  ignore(
    database_exec(
      db, "CREATE TABLE t(id INTEGER PRIMARY KEY,n NUMERIC)", "[]", false,
    ),
  )
  let list = Array::make(16, "?").join(",")
  guard parse_statement(
      lex(
        "UPDATE t SET n=n IN(" +
        list +
        ") WHERE id IN(" +
        list +
        ") RETURNING n IN(" +
        list +
        ")",
      ),
    )
    is Update(name, setters, predicate, returning) else {
    fail("update")
  }
  let (plan, _) = prepare_update(
    db.store,
    name,
    setters,
    predicate,
    returning,
    48,
  )
  assert_eq(plan.in_lists.length(), 3)
}

///|
test "IN SELECT caches are lazy, non-correlated and scoped to one execution" {
  let db = database_open()
  ignore(database_exec(db, "CREATE TABLE t(n NUMERIC)", "[]", false))
  ignore(
    database_exec(db, "CREATE TABLE r(n TEXT COLLATE NOCASE)", "[]", false),
  )
  ignore(
    database_exec(db, "INSERT INTO r VALUES('1'),('a'),(NULL)", "[]", false),
  )
  guard parse_statement(lex("SELECT n IN(SELECT n FROM r WHERE n<>?) FROM t"))
    is Select(select) else {
    fail("select")
  }
  let plan = prepare_selection(db.store, select, 1)
  assert_eq(plan.in_selects.length(), 1)
  let frames = in_select_frames(plan.in_selects)
  assert_true(frames[0].lookup is None)
  let table = get_table(db.store, "t")
  let context = {
    ..evaluation(
      db.store,
      [Text("a")],
      row_environment(table, { id: 1L, values: [Integer(1L)], }, "t"),
    ),
    in_selects: frames,
  }
  assert_true(
    evaluate(select.projections[0].expression, context) == Integer(1L),
  )
  assert_true(frames[0].lookup is Some(_))
  let fresh = in_select_frames(plan.in_selects)
  let other = { ..context, params: [Text("1")], in_selects: fresh, }
  assert_true(evaluate(select.projections[0].expression, other) == Integer(0L))
  assert_true(context.nested().in_selects.is_empty())
  guard parse_statement(
      lex("SELECT n IN(SELECT n FROM r WHERE r.n=t.n) FROM t"),
    )
    is Select(correlated) else {
    fail("select")
  }
  assert_true(prepare_selection(db.store, correlated, 0).in_selects.is_empty())
}

///|
test "IN cache budgets reject retained entries rather than changing results" {
  let budget = in_cache_budget(entries=2, bytes=64)
  assert_true(reserve_in_cache(budget, 1, 32))
  assert_false(reserve_in_cache(budget, 2, 1))
  assert_false(reserve_in_cache(budget, 1, 33))
  assert_true(reserve_in_cache(budget, 1, 32))
}
