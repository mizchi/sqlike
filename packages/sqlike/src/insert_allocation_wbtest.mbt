///|
test "explicit insert does not snapshot every existing row to allocate an unused rowid" {
  let db = database_open()
  ignore(
    database_exec(
      db, "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)", "[]", false,
    ),
  )
  ignore(database_exec(db, "INSERT INTO t VALUES(1,1)", "[]", false))
  let table = get_table(db.store, "t")
  ignore(primary_index(db.store, table))
  let owned = table.rows.own_page(0).rows
  guard parse_statement(lex("INSERT INTO t VALUES(2,2),(3,3)"))
    is Insert(insert) else {
    fail("INSERT")
  }
  ignore(insert_rows(db.store, insert, []))
  assert_true(physical_equal(owned, table.rows.pages[0].rows))
}

///|
test "derived maximum follows deletes, rowid changes, empty and negative tables" {
  let db = database_open()
  ignore(
    database_exec(
      db, "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)", "[]", false,
    ),
  )
  ignore(database_exec(db, "INSERT INTO t VALUES(-3,1),(-2,2)", "[]", false))
  let table = get_table(db.store, "t")
  assert_eq(maximum_rowid(db.store, table), -2L)
  ignore(database_exec(db, "DELETE FROM t WHERE id=-2", "[]", false))
  assert_eq(maximum_rowid(db.store, table), -3L)
  ignore(database_exec(db, "UPDATE t SET id=100 WHERE id=-3", "[]", false))
  assert_eq(maximum_rowid(db.store, table), 100L)
  ignore(database_exec(db, "DELETE FROM t", "[]", false))
  assert_eq(maximum_rowid(db.store, table), 0L)
}
