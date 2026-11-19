///|
test "same-value UPDATE keeps row pages but still counts and fires triggers" {
  let db = database_open()
  ignore(
    database_exec(
      db, "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER CHECK(n>=0))", "[]", false,
    ),
  )
  ignore(database_exec(db, "INSERT INTO t VALUES(1,4)", "[]", false))
  let pages = get_table(db.store, "t").rows.pages
  ignore(database_exec(db, "UPDATE t SET n=4 WHERE id=1", "[]", false))
  assert_true(physical_equal(pages, get_table(db.store, "t").rows.pages))
  assert_eq(db.store.changes, 1)
  ignore(database_exec(db, "CREATE TABLE log(n INTEGER)", "[]", false))
  ignore(
    database_exec(
      db, "CREATE TRIGGER log_update AFTER UPDATE ON t BEGIN INSERT INTO log VALUES(new.n); END",
      "[]", false,
    ),
  )
  ignore(database_exec(db, "UPDATE t SET n=4 WHERE id=1", "[]", false))
  assert_eq(get_table(db.store, "log").rows.length(), 1)
  assert_eq(db.store.changes, 1)
}

///|
test "same old value overwrites a BEFORE trigger mutation and preserves storage class" {
  let db = database_open()
  ignore(
    database_exec(db, "CREATE TABLE t(id INTEGER PRIMARY KEY,n)", "[]", false),
  )
  ignore(database_exec(db, "INSERT INTO t VALUES(1,4)", "[]", false))
  ignore(
    database_exec(
      db, "CREATE TRIGGER mutate BEFORE UPDATE ON t BEGIN UPDATE t SET n=7 WHERE id=old.id; END",
      "[]", false,
    ),
  )
  ignore(database_exec(db, "UPDATE t SET n=4 WHERE id=1", "[]", false))
  assert_true(get_table(db.store, "t").rows[0].values[1] is Integer(4L))
  ignore(database_exec(db, "DROP TRIGGER mutate", "[]", false))
  ignore(database_exec(db, "UPDATE t SET n=4.0 WHERE id=1", "[]", false))
  assert_true(get_table(db.store, "t").rows[0].values[1] is Real(4.0))
}

///|
test "BEFORE trigger changes are removed from partial indexes and replicated patches" {
  let db = database_open()
  ignore(
    database_exec(
      db, "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)", "[]", false,
    ),
  )
  ignore(database_exec(db, "CREATE INDEX ix ON t(n) WHERE n>=0", "[]", false))
  ignore(database_exec(db, "INSERT INTO t VALUES(1,-1)", "[]", false))
  ignore(
    database_exec(
      db, "CREATE TRIGGER mutate BEFORE UPDATE ON t BEGIN UPDATE t SET n=7 WHERE id=old.id; END",
      "[]", false,
    ),
  )
  assert_true(
    database_query_values(db, "SELECT id FROM t WHERE n>=0 ORDER BY n", "[]").contains(
      "\"rows\":[]",
    ),
  )
  let clone = database_clone(db)
  assert_eq(database_ack_delta(db, db.serial), "{}")
  ignore(database_exec(db, "UPDATE t SET n=-1 WHERE id=1", "[]", false))
  assert_true(
    database_query_values(db, "SELECT id FROM t WHERE n>=0 ORDER BY n", "[]").contains(
      "\"rows\":[]",
    ),
  )
  assert_eq(database_apply_delta(clone, database_delta(db, false)), "{}")
  assert_eq(database_dump(clone), database_dump(db))
}
