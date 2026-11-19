///|
test "generated cells are cached privately and excluded from logical snapshots and column patches" {
  let db = database_open()
  for
    sql in [
      "CREATE TABLE t(id INTEGER PRIMARY KEY,n INT,v INT AS(n*2))", "INSERT INTO t VALUES(1,3)",
    ] {
    assert_false(database_exec(db, sql, "[]", false).contains("error"))
  }
  assert_true(
    db.store.tables[0].rows[0].values == [Integer(1L), Integer(3L), Integer(6L)],
  )
  let image = database_dump(db)
  guard @json.parse(image) is { "state": state, .. } else { fail("image") }
  let decoded : Store = @json.from_json(state)
  assert_true(
    decoded.tables[0].rows[0].values == [Integer(1L), Integer(3L), Null],
  )
  assert_false(database_restore(db, image).contains("error"))
  assert_true(
    db.store.tables[0].rows[0].values == [Integer(1L), Integer(3L), Integer(6L)],
  )
  assert_eq(database_ack_delta(db, database_serial(db)), "{}")
  let mirror = database_clone(db)
  assert_false(
    database_exec(db, "UPDATE t SET n=4 WHERE id=1", "[]", false).contains(
      "error",
    ),
  )
  guard db.store.dirty.edits is [PatchRow("t", 1L, 1L, [(1, Integer(4L))])] else {
    fail("only base cells belong in patches")
  }
  assert_eq(database_apply_delta(mirror, database_delta(db, false)), "{}")
  assert_true(
    mirror.store.tables[0].rows[0].values ==
    [Integer(1L), Integer(4L), Integer(8L)],
  )
}

///|
test "binary snapshots carry NULL virtual slots and reject forged generated patches atomically" {
  let artifact = compile_program(
    "{\"schema\":[\"CREATE TABLE t(id INTEGER PRIMARY KEY,n INT,v INT AS(n*2))\"],\"queries\":[{\"name\":\"add\",\"sql\":\"INSERT INTO t VALUES(1,3)\"},{\"name\":\"change\",\"sql\":\"UPDATE t SET n=4\"}]}",
  )
  let catalog = pack_program_binary(artifact)
  assert_eq(catalog.error, "")
  let db = defined_open(catalog.schema, catalog.statements, b"")
  assert_false(defined_execute(db, "add", "[]").contains("error"))
  let snapshot = defined_snapshot(db)
  let r = binary_reader(snapshot.data, 4, 67108864)
  let _schema : String = Binary::read(r)
  let _serial : Int32 = Binary::read(r)
  let _changes : Int32 = Binary::read(r)
  let _rowid : Int64 = Binary::read(r)
  let _foreign : Bool = Binary::read(r)
  assert_eq(r.length(), 1)
  let _sequence : Int64 = Binary::read(r)
  let _present : Bool? = Binary::read(r)
  let rows : Array[StoredRow] = Binary::read(r)
  r.finish()
  assert_true(rows[0].values == [Integer(1L), Integer(3L), Null])
  let mirror = defined_open(catalog.schema, catalog.statements, snapshot.data)
  assert_eq(defined_ack_delta(db, snapshot.serial), "{}")
  assert_false(defined_execute(db, "change", "[]").contains("error"))
  assert_eq(defined_apply_delta(mirror, defined_delta(db, false).data), "{}")
  let (connection, _) = mirror.core.ready()
  assert_true(
    connection.database.store.tables[0].rows[0].values ==
    [Integer(1L), Integer(4L), Integer(8L)],
  )
  let before = defined_snapshot(mirror).data
  let store = copy_store(connection.database.store)
  let rejected = try {
    apply_materialized_edits(store, [
      PatchRow("t", 1L, 1L, [(2, Integer(999L))]),
    ])
    false
  } catch {
    _ => true
  }
  assert_true(rejected)
  assert_eq(defined_snapshot(mirror).data, before)
}
