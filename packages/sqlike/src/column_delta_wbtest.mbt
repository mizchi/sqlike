///|
test "flush updates omit unchanged large values and preserve ordered edits" {
  let db = database_open()
  ignore(
    database_exec(
      db, "CREATE TABLE t(id INTEGER PRIMARY KEY,n BLOB,body BLOB)", "[]", false,
    ),
  )
  ignore(
    database_exec(
      db, "INSERT INTO t VALUES(1,1.0,zeroblob(4096)),(2,2.0,zeroblob(4096))", "[]",
      false,
    ),
  )
  let restored = database_open()
  assert_eq(database_apply_delta(restored, database_delta(db, true)), "{}")
  assert_eq(database_ack_delta(db, database_serial(db)), "{}")
  ignore(database_exec(db, "UPDATE t SET n=n+1.0", "[]", false))
  let delta = database_delta(db, false)
  assert_true(
    @json.parse(delta) is { "format": "sqlike-flush@2", "full": False, .. },
  )
  assert_true(delta.length() < 512)
  assert_eq(database_apply_delta(restored, delta), "{}")
  assert_eq(database_dump(restored), database_dump(db))
  assert_eq(database_ack_delta(db, database_serial(db)), "{}")
  // No-op updates still publish counters/serials, but need no row values.
  ignore(database_exec(db, "UPDATE t SET n=n,body=body", "[]", false))
  assert_true(
    @json.parse(database_delta(db, false)) is { "edits": Array([]), .. },
  )
  assert_eq(database_apply_delta(restored, database_delta(db, false)), "{}")
  assert_eq(database_dump(restored), database_dump(db))
}

///|
test "column dirtiness distinguishes INTEGER REAL and the sign of zero" {
  let db = database_open()
  ignore(database_exec(db, "CREATE TABLE t(v BLOB,keep TEXT)", "[]", false))
  ignore(database_exec(db, "INSERT INTO t VALUES(0,'same')", "[]", false))
  let restored = database_open()
  assert_eq(database_apply_delta(restored, database_delta(db, true)), "{}")
  let table = get_table(db.store, "t")
  let values : Array[Value] = [
    Real(0.0),
    Real(-0.0),
    Integer(0L),
    Null,
    Blob(b""),
    Text(""),
  ]
  for value in values {
    assert_eq(database_ack_delta(db, database_serial(db)), "{}")
    replace_table_row(db.store, table, table.rows[0], {
      id: table.rows[0].id,
      values: [value, Text("same")],
    })
    db.serial += 1
    let delta = database_delta(db, false)
    assert_false(@json.parse(delta) is { "edits": Array([]), .. })
    assert_eq(database_apply_delta(restored, delta), "{}")
    let actual = get_table(restored.store, "t").rows[0].values[0]
    if value is Real(expected) && actual is Real(number) {
      assert_eq(
        expected.reinterpret_as_uint64(),
        number.reinterpret_as_uint64(),
      )
    } else {
      assert_true(actual == value)
    }
    let snapshot = database_open()
    assert_eq(database_apply_delta(snapshot, database_delta(db, true)), "{}")
    if value is Real(expected) &&
      get_table(snapshot.store, "t").rows[0].values[0] is Real(number) {
      assert_eq(
        expected.reinterpret_as_uint64(),
        number.reinterpret_as_uint64(),
      )
    }
  }
}
