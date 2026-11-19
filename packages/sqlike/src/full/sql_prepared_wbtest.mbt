///|
test "dynamic prepared plans follow schema epochs through rollback ABA and restore" {
  let db = database_open()
  for
    sql in ["CREATE TABLE t(id INTEGER PRIMARY KEY)", "INSERT INTO t VALUES(1)"] {
    assert_false(database_exec(db, sql, "[]", false).contains("error"))
  }
  let query = database_prepare(db, "SELECT * FROM t WHERE id=?")
  let params = "[{\"t\":\"integer\",\"v\":\"1\"}]"
  assert_false(
    database_prepared_exec(query, params, true, false).contains("error"),
  )
  for sql in ["BEGIN", "ALTER TABLE t ADD COLUMN b TEXT DEFAULT 'old'"] {
    assert_false(database_exec(db, sql, "[]", false).contains("error"))
  }
  assert_true(
    database_prepared_exec(query, params, true, false).contains("\"b\""),
  )
  let previous = query.epoch
  let cookie = db.store.cookie
  for sql in ["ROLLBACK", "ALTER TABLE t ADD COLUMN c TEXT DEFAULT 'new'"] {
    assert_false(database_exec(db, sql, "[]", false).contains("error"))
  }
  assert_eq(db.store.cookie, cookie)
  assert_true(db.schema_epoch != previous)
  let result = database_prepared_exec(query, params, true, false)
  assert_true(result.contains("\"c\""))
  assert_false(result.contains("\"b\""))
  assert_eq(query.epoch, db.schema_epoch)
  let snapshot = database_dump(db)
  assert_eq(database_restore(db, snapshot), "{}")
  assert_true(db.schema_epoch != query.epoch)
  assert_eq(database_prepared_exec(query, params, true, false), result)
  assert_eq(query.epoch, db.schema_epoch)
}
