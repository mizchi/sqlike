///|
test "partial cache membership changes incrementally and implication stays conservative" {
  let db = database_open()
  ignore(
    database_exec(
      db, "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)", "[]", false,
    ),
  )
  ignore(
    database_exec(db, "CREATE INDEX ix ON t(n DESC) WHERE n>=0", "[]", false),
  )
  ignore(
    database_exec(db, "INSERT INTO t VALUES(1,-1),(2,2),(3,3)", "[]", false),
  )
  let read = fn() raise {
    guard parse_statement(
        lex("SELECT id FROM t WHERE n>=0 AND n<10 ORDER BY n DESC"),
      )
      is Select(select) else {
      fail("select")
    }
    guard secondary_range(
        select,
        evaluation(db.store, [], []),
        get_table(db.store, "t"),
        "t",
      )
      is Some(range) else {
      fail("partial plan")
    }
    range.rows
  }
  let rows = read()
  assert_eq(rows.map(r => r.id), [3L, 2L])
  ignore(database_exec(db, "UPDATE t SET n=4 WHERE id=1", "[]", false))
  assert_true(physical_equal(rows, read()))
  assert_eq(rows.map(r => r.id), [1L, 3L, 2L])
  ignore(database_exec(db, "UPDATE t SET n=-2 WHERE id=3", "[]", false))
  assert_eq(rows.map(r => r.id), [1L, 2L])
  guard parse_statement(lex("SELECT id FROM t ORDER BY n DESC"))
    is Select(select) else {
    fail("select")
  }
  assert_true(
    secondary_range(
      select,
      evaluation(db.store, [], []),
      get_table(db.store, "t"),
      "t",
    )
    is None,
  )
}

///|
test "invalid index expressions fail before publication and excluded rows do not evaluate keys" {
  let db = database_open()
  ignore(
    database_exec(
      db, "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER,live INTEGER)", "[]",
      false,
    ),
  )
  let before = database_dump(db)
  for
    sql in [
      "CREATE INDEX x ON t(changes())", "CREATE INDEX x ON t(?)", "CREATE INDEX x ON t((SELECT 1))",
      "CREATE INDEX x ON t(sum(n))", "CREATE INDEX x ON t(n) WHERE last_insert_rowid()>0",
    ] {
    assert_true(database_exec(db, sql, "[]", false).contains("error"))
    assert_eq(database_dump(db), before)
  }
  assert_false(
    database_exec(db, "CREATE INDEX x ON t(abs(n)) WHERE live=1", "[]", false).contains(
      "error",
    ),
  )
  assert_false(
    database_exec(
      db, "INSERT INTO t VALUES(1,-9223372036854775808,0)", "[]", false,
    ).contains("error"),
  )
  let stable = database_dump(db)
  assert_true(
    database_exec(db, "UPDATE t SET live=1 WHERE id=1", "[]", false).contains(
      "error",
    ),
  )
  assert_eq(database_dump(db), stable)
}
