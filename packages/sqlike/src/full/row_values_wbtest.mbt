///|
test "row cursor constraints narrow the leading key and always retain the residual predicate" {
  let db = database_open()
  for
    sql in [
      "CREATE TABLE t(id INTEGER PRIMARY KEY,a INTEGER,b INTEGER)", "CREATE INDEX ix ON t(a)",
      "INSERT INTO t VALUES(1,1,9),(2,2,0),(3,2,9),(4,3,0),(5,4,1)",
    ] {
    assert_false(database_exec(db, sql, "[]", false).contains("error"))
  }
  guard parse_statement(lex("SELECT id FROM t WHERE (a,b)>(?,?) ORDER BY a"))
    is Select(select) else {
    fail("select")
  }
  guard secondary_range(
      select,
      evaluation(db.store, [Integer(2L), Integer(5L)], []),
      get_table(db.store, "t"),
      "t",
    )
    is Some(range) else {
    fail("expected cursor range")
  }
  assert_true(range.residual)
  assert_eq(range.rows.slice(range.start, range.end).map(r => r.id), [
    2L, 3L, 4L, 5L,
  ])
  assert_true(
    select_relation_in(
      select,
      evaluation(db.store, [Integer(2L), Integer(5L)], []),
      false,
    ).rows.map(row => row[0].value) ==
    [Integer(3L), Integer(4L), Integer(5L)],
  )
}

///|
test "complete tuple bounds preserve strictness NULL residuals and two-sided ranges" {
  for direction in ["ASC", "DESC"] {
    let db = database_open()
    for
      sql in [
        "CREATE TABLE t(id INTEGER PRIMARY KEY,tenant TEXT,stamp INTEGER)",
        "CREATE INDEX ix ON t(tenant,stamp " +
        direction +
        ",id " +
        direction +
        ")",
        "INSERT INTO t VALUES(1,'a',10),(2,'a',10),(3,'a',10),(4,'a',10),(5,'a',20),(6,'b',10)",
      ] {
      assert_false(database_exec(db, sql, "[]", false).contains("error"))
    }
    let read = fn(op : String, value : Value) raise {
      guard parse_statement(
          lex(
            "SELECT id FROM t WHERE tenant=? AND (stamp,id)" +
            op +
            "(?,?) ORDER BY stamp,id",
          ),
        )
        is Select(select) else {
        fail("select")
      }
      select_relation_in(
        select,
        evaluation(db.store, [Text("a"), Integer(10L), value], []),
        false,
      ).rows.map(row => {
        guard row[0].value is Integer(id) else { fail("id") }
        id
      })
    }
    assert_eq(read(">", Integer(3L)), [4L, 5L])
    assert_eq(read(">=", Integer(3L)), [3L, 4L, 5L])
    assert_eq(read("<", Integer(3L)), [1L, 2L])
    assert_eq(read("<=", Integer(3L)), [1L, 2L, 3L])
    assert_eq(read(">", Null), [5L])
    assert_eq(read("<", Null), [])
    guard parse_statement(
        lex(
          "SELECT id FROM t WHERE tenant='a' AND (stamp,id)>(10,2) AND (stamp,id)<(20,0) ORDER BY stamp,id",
        ),
      )
      is Select(select) else {
      fail("select")
    }
    assert_true(
      select_relation_in(select, evaluation(db.store, [], []), false).rows.map(row => {
        row[0].value
      }) ==
      [Integer(3L), Integer(4L)],
    )
  }
}

///|
test "row cursor seeks the complete tuple after a tenant equality prefix" {
  for direction in ["ASC", "DESC"] {
    let db = database_open()
    for
      sql in [
        "CREATE TABLE t(id INTEGER PRIMARY KEY,tenant TEXT,stamp INTEGER)",
        "CREATE INDEX ix ON t(tenant,stamp " +
        direction +
        ",id " +
        direction +
        ")",
        "INSERT INTO t VALUES(1,'a',10),(2,'a',10),(3,'a',10),(4,'a',10),(5,'a',20),(6,'b',10)",
      ] {
      assert_false(database_exec(db, sql, "[]", false).contains("error"))
    }
    guard parse_statement(
        lex(
          "SELECT id FROM t WHERE tenant=? AND (stamp,id)>(?,?) ORDER BY stamp,id",
        ),
      )
      is Select(select) else {
      fail("select")
    }
    let context = evaluation(db.store, [Text("a"), Integer(10L), Integer(3L)], [])
    guard secondary_range(select, context, get_table(db.store, "t"), "t")
      is Some(range) else {
      fail("expected full cursor range")
    }
    assert_true(range.residual)
    assert_eq(
      range.rows.slice(range.start, range.end).map(r => r.id),
      if direction == "ASC" {
        [4L, 5L]
      } else {
        [5L, 4L]
      },
    )
    assert_true(
      select_relation_in(select, context, false).rows.map(row => row[0].value) ==
      [Integer(4L), Integer(5L)],
    )
  }
}
