///|
test "trigger frames restore rowid and counters and do not leak through an aborted statement" {
  let connection = Connection::open(":memory:")
  for
    sql in [
      "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)", "CREATE TABLE log(id INTEGER PRIMARY KEY,n INTEGER)",
      "CREATE TRIGGER ai AFTER INSERT ON t BEGIN INSERT INTO log VALUES(new.id+100,new.n); END",
      "CREATE TRIGGER valid BEFORE INSERT ON t WHEN new.n<0 BEGIN SELECT RAISE(ABORT,'negative'); END",
    ] {
    let s = connection.prepare(sql)
    ignore(s.step())
    s.finalize()
  }
  let s = connection.prepare("INSERT INTO t VALUES(1,2)")
  ignore(s.step())
  s.finalize()
  assert_eq(connection.changes(), 1L)
  assert_eq(connection.database.store.last_rowid, 1L)
  let before = database_dump(connection.database)
  let bad = connection.prepare("INSERT INTO t VALUES(2,-1)")
  let error = try {
    ignore(bad.step())
    None
  } catch {
    SqliteError(code~, extended~, msg~) => Some((code, extended, msg))
  }
  assert_true(error is Some((Constraint, Some(ConstraintTrigger), "negative")))
  bad.finalize() catch {
    _ => ()
  }
  assert_eq(database_dump(connection.database), before)
  assert_eq(connection.changes(), 0L)
  assert_true(connection.database.store.triggers.row.is_empty())
  assert_true(connection.database.store.triggers.active.is_empty())
  connection.close()
}

///|
test "recursive trigger default, enabled depth limit, ignore and DROP preserve state" {
  let db = database_open()
  ignore(
    database_exec(
      db, "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)", "[]", false,
    ),
  )
  ignore(database_exec(db, "INSERT INTO t VALUES(1,0)", "[]", false))
  assert_false(
    database_exec(
      db, "CREATE TRIGGER au AFTER UPDATE ON t WHEN new.n<3 BEGIN UPDATE t SET n=n+1 WHERE id=new.id; END",
      "[]", false,
    ).contains("error"),
  )
  assert_false(
    database_exec(db, "UPDATE t SET n=1", "[]", false).contains("error"),
  )
  assert_true(
    database_query_values(db, "SELECT n FROM t", "[]").contains("\"v\":\"2\""),
  )
  ignore(database_exec(db, "PRAGMA recursive_triggers=ON", "[]", false))
  ignore(database_exec(db, "UPDATE t SET n=1", "[]", false))
  assert_true(
    database_query_values(db, "SELECT n FROM t", "[]").contains("\"v\":\"3\""),
  )
  ignore(database_exec(db, "DROP TRIGGER au", "[]", false))
  ignore(
    database_exec(
      db, "CREATE TRIGGER loop AFTER UPDATE ON t BEGIN UPDATE t SET n=n+1 WHERE id=new.id; END",
      "[]", false,
    ),
  )
  let before = database_dump(db)
  assert_true(
    database_exec(db, "UPDATE t SET n=1", "[]", false).contains("recursion"),
  )
  assert_eq(database_dump(db), before)
  assert_false(
    database_query_values(db, "SELECT RAISE(IGNORE)", "[]").contains("\"rows\""),
  )
}

///|
test "outer INSERT conflict policy overrides trigger INSERT and does not escape" {
  let db = database_open()
  for
    sql in [
      "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)", "CREATE TABLE u(n INTEGER PRIMARY KEY)",
      "CREATE TRIGGER ai AFTER INSERT ON t BEGIN INSERT INTO u VALUES(new.n); END",
      "INSERT INTO t VALUES(1,1)",
    ] {
    assert_false(database_exec(db, sql, "[]", false).contains("error"))
  }
  assert_false(
    database_exec(db, "INSERT OR IGNORE INTO t VALUES(2,1)", "[]", false).contains(
      "error",
    ),
  )
  assert_false(
    database_exec(db, "INSERT OR REPLACE INTO t VALUES(3,1)", "[]", false).contains(
      "error",
    ),
  )
  let before = database_dump(db)
  assert_true(
    database_exec(db, "INSERT INTO t VALUES(4,1)", "[]", false).contains(
      "UNIQUE",
    ),
  )
  assert_eq(db.store.last_rowid, 4L)
  assert_eq(
    database_dump(db),
    before.replace_all(old="\"last_rowid\":\"3\"", new="\"last_rowid\":\"4\""),
  )
  assert_true(db.store.triggers.conflict_override is None)
}
