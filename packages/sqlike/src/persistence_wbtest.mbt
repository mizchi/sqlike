///|
test "flush records materialized row edits, preserves order and excludes untouched rows" {
  let db = database_open()
  ignore(
    database_exec(
      db, "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)", "[]", false,
    ),
  )
  ignore(
    database_exec(db, "INSERT INTO t VALUES(1,10),(2,20),(3,30)", "[]", false),
  )
  let snapshot = database_delta(db, true)
  let restored = database_open()
  assert_eq(database_apply_delta(restored, snapshot), "{}")
  assert_eq(database_dump(restored), database_dump(db))
  assert_eq(database_ack_delta(db, database_serial(db)), "{}")
  ignore(database_exec(db, "UPDATE t SET id=9,n=25 WHERE id=2", "[]", false))
  ignore(database_exec(db, "DELETE FROM t WHERE id=1", "[]", false))
  ignore(database_exec(db, "INSERT INTO t VALUES(4,40)", "[]", false))
  let delta = database_delta(db, false)
  let value = @json.parse(delta)
  assert_true(
    value is { "full": False, "edits": Array(edits), .. } && edits.length() == 3,
  )
  assert_eq(database_apply_delta(restored, delta), "{}")
  assert_eq(database_dump(restored), database_dump(db))
  assert_eq(get_table(restored.store, "t").rows.map(r => r.id), [9L, 3L, 4L])
  let stable = database_dump(restored)
  assert_true(database_apply_delta(restored, delta).contains("error"))
  assert_eq(database_dump(restored), stable)
  assert_true(database_ack_delta(db, database_serial(db) - 1).contains("error"))
  assert_eq(database_ack_delta(db, database_serial(db)), "{}")
  assert_true(
    @json.parse(database_delta(db, false)) is { "edits": Array([]), .. },
  )
}

///|
test "dirty edits roll back and schema changes require a snapshot" {
  let db = database_open()
  ignore(
    database_exec(
      db, "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER UNIQUE)", "[]", false,
    ),
  )
  ignore(database_exec(db, "INSERT INTO t VALUES(1,10),(2,20)", "[]", false))
  assert_eq(database_ack_delta(db, database_serial(db)), "{}")
  ignore(database_exec(db, "UPDATE t SET n=11 WHERE id=1", "[]", false))
  let pending = database_delta(db, false)
  assert_true(
    database_exec(db, "UPDATE t SET n=7", "[]", false).contains("error"),
  )
  assert_eq(database_delta(db, false), pending)
  let clone = database_clone(db)
  ignore(database_exec(db, "UPDATE t SET n=12 WHERE id=1", "[]", false))
  assert_eq(database_delta(clone, false), pending)
  ignore(database_exec(db, "ALTER TABLE t ADD COLUMN body TEXT", "[]", false))
  assert_true(@json.parse(database_delta(db, false)) is { "full": True, .. })
}
