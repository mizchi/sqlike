///|
test "UPDATE FROM slot plans read target/source columns and rowids without allocating an Environment" {
  let db = database_open()
  ignore(
    database_exec(
      db, "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)", "[]", false,
    ),
  )
  ignore(
    database_exec(
      db, "CREATE TABLE s(id INTEGER PRIMARY KEY,n INTEGER)", "[]", false,
    ),
  )
  guard parse_statement(
      lex(
        "UPDATE t AS dst SET n=src.n+dst.n+src.rowid+dst.rowid FROM s AS src WHERE src.id=dst.id",
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
    0,
  )
  guard plan.from_plan is Some(from) && from.slots is Some(slots) else {
    fail("slot plan")
  }
  let input : BoundInput = {
    store: db.store,
    params: [],
    row: { id: 7L, values: [Integer(7L), Integer(10L)], },
    layout: slots.layout,
    joined: Some({
      source: { id: 7L, values: [Integer(7L), Integer(20L)], },
      slots: slots.columns,
    }),
    context: None,
    in_lists: [],
  }
  assert_true(evaluate_bound(slots.predicate, input) == Integer(1L))
  assert_true(evaluate_bound(slots.setters[0], input) == Integer(44L))
  assert_true(input.context is None)
}

///|
test "UPDATE FROM prepares reusable metadata and a unique source rowid lookup" {
  let db = database_open()
  for
    sql in [
      "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)", "CREATE TABLE s(id INTEGER PRIMARY KEY,n INTEGER)",
      "INSERT INTO t VALUES(1,100),(2,200)", "INSERT INTO s VALUES(1,10),(2,20)",
    ] {
    assert_false(database_exec(db, sql, "[]", false).contains("error"))
  }
  guard parse_statement(
      lex(
        "UPDATE t AS dst SET n=src.n+?1 FROM s AS src WHERE src.id=dst.id AND dst.id>=?2 RETURNING id,n",
      ),
    )
    is Update(name, setters, predicate, returning) else {
    fail("update")
  }
  let (plan, names) = prepare_update(
    db.store,
    name,
    setters,
    predicate,
    returning,
    2,
  )
  assert_eq(names, ["id", "n"])
  guard plan.from_plan is Some(from) else { fail("from metadata") }
  assert_true(from.lookup is Some(_))
  assert_true(
    from.target_layout.all(b => {
      if b.hidden {
        b.value is Integer(0L)
      } else {
        b.value is Null
      }
    }),
  )
  let run = fn(params : Array[Value]) raise {
    execute_update_from(db.store, plan, params, returning).map(row => {
      row.map(b => b.value)
    })
  }
  assert_true(
    run([Integer(1L), Integer(1L)]) ==
    [[Integer(1L), Integer(11L)], [Integer(2L), Integer(21L)]],
  )
  assert_false(
    database_exec(db, "UPDATE s SET n=n+1", "[]", false).contains("error"),
  )
  assert_true(run([Integer(2L), Integer(2L)]) == [[Integer(2L), Integer(23L)]])
  assert_true(run([Integer(9L), Integer(9L)]).is_empty())
  assert_true(
    from.target_layout.all(b => {
      if b.hidden {
        b.value is Integer(0L)
      } else {
        b.value is Null
      }
    }),
  )
  guard parse_statement(lex("UPDATE t SET n=s.n FROM s WHERE t.n=s.n"))
    is Update(name, setters, predicate, returning) else {
    fail("update")
  }
  let (fallback, _) = prepare_update(
    db.store,
    name,
    setters,
    predicate,
    returning,
    0,
  )
  assert_true(fallback.from_plan.unwrap().lookup is None)
}
