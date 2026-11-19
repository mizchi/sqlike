///|
test "prepared row metadata is immutable while values and bindings stay live" {
  let db = database_open()
  assert_false(
    database_exec(
      db, "CREATE TABLE t(id INTEGER PRIMARY KEY,s TEXT COLLATE NOCASE,n INT)", "[]",
      false,
    ).contains("error"),
  )
  assert_false(
    database_exec(db, "INSERT INTO t VALUES(1,'A',3),(2,'b',NULL)", "[]", false).contains(
      "error",
    ),
  )
  guard parse_statement(
      lex(
        "SELECT (s,n)=(?1,?2) AS equal FROM t WHERE (s,id)>(?3,?4) ORDER BY id",
      ),
    )
    is Select(select) else {
    fail("selection")
  }
  let plan = prepare_selection(db.store, select, 4)
  assert_true(plan.row_metadata.length() >= 4)
  guard select.projections[0].expression is Binary(_, left, _) else {
    fail("comparison")
  }
  let layout = row_environment(
    get_table(db.store, "t"),
    get_table(db.store, "t").rows[0],
    "t",
  )
  let ctx = {
    ..evaluation(
      db.store,
      [Text("a"), Integer(3L), Text(""), Integer(0L)],
      layout,
    ),
    row_metadata: plan.row_metadata,
  }
  let cached = row_value(left, ctx, false)
  assert_true(
    plan.row_metadata.any(entry => {
      physical_equal(entry.metadata, cached.metadata)
    }),
  )
  assert_eq(cached.metadata[0].collation, "nocase")
  assert_eq(cached.metadata[1].affinity, "integer")
  assert_true(ctx.nested().row_metadata.is_empty())
  guard bind_expression(select.projections[0].expression, ctx)
    is BoundOriginal(_, metadata) else {
    fail("row bound plan")
  }
  assert_true(metadata.length() == 2)
  let read = fn(params : Array[Value]) raise {
    select_rows(db.store, select, params, 0, prepared=Some(plan)).map(row => {
      row[0].value
    })
  }
  assert_true(
    read([Text("a"), Integer(3L), Text(""), Integer(0L)]) ==
    [Integer(1L), Integer(0L)],
  )
  assert_true(read([Text("b"), Integer(3L), Text("a"), Integer(1L)]) == [Null])
}
