///|
fn index_rows(
  store : Store,
  table : Table,
  name : String,
  column : Int32,
) -> Array[StoredRow] raise SqlError {
  index_rows_for_fields(
    store,
    table,
    name,
    [{ column, collation: table.columns[column].collation, descending: false, }],
    None,
  )
}

///|
fn index_bound(
  store : Store,
  rows : Array[StoredRow],
  column : Int32,
  collation : String,
  value : Value,
  after_equal : Bool,
) -> Int32 {
  index_prefix_bound(
    store,
    rows,
    [{ column, collation, descending: false, }],
    [value],
    after_equal,
  )
}

///|
test "secondary index sorts by value then rowid and updates without rebuilding" {
  let db = database_open()
  ignore(
    database_exec(
      db, "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)", "[]", false,
    ),
  )
  ignore(database_exec(db, "CREATE INDEX ix ON t(n)", "[]", false))
  ignore(
    database_exec(db, "INSERT INTO t VALUES(3,20),(1,10),(2,10)", "[]", false),
  )
  let table = get_table(db.store, "t")
  let rows = index_rows(db.store, table, "ix", 1)
  assert_eq(rows.map(r => r.id), [1L, 2L, 3L])
  assert_eq(db.store.indexes.length(), 1)
  let image = database_dump(db)
  ignore(index_rows(db.store, table, "ix", 1))
  assert_eq(database_dump(db), image)
  let clone = database_clone(db)
  assert_eq(clone.store.indexes.length(), 0)
  ignore(database_exec(db, "UPDATE t SET n=5 WHERE id=3", "[]", false))
  assert_eq(db.store.indexes.length(), 1)
  assert_true(physical_equal(rows, index_rows(db.store, table, "ix", 1)))
  assert_eq(
    index_rows(db.store, get_table(db.store, "t"), "ix", 1).map(r => r.id),
    [3L, 1L, 2L],
  )
  assert_eq(
    index_rows(clone.store, get_table(clone.store, "t"), "ix", 1).map(r => r.id),
    [1L, 2L, 3L],
  )
  ignore(database_exec(db, "DROP INDEX ix", "[]", false))
  assert_eq(db.store.indexes.length(), 0)
}

///|
test "range boundaries handle duplicate values, exclusivity and empty intersections" {
  let db = database_open()
  ignore(
    database_exec(
      db, "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)", "[]", false,
    ),
  )
  ignore(database_exec(db, "CREATE INDEX ix ON t(n)", "[]", false))
  ignore(
    database_exec(
      db, "INSERT INTO t VALUES(5,30),(4,20),(3,20),(2,10),(1,NULL)", "[]", false,
    ),
  )
  let table = get_table(db.store, "t")
  let sorted = index_rows(db.store, table, "ix", 1)
  assert_eq(index_bound(db.store, sorted, 1, "binary", Integer(20L), false), 2)
  assert_eq(index_bound(db.store, sorted, 1, "binary", Integer(20L), true), 4)
  assert_eq(index_bound(db.store, sorted, 1, "binary", Integer(0L), false), 1)
  assert_eq(index_bound(db.store, sorted, 1, "binary", Integer(40L), false), 5)
}

///|
test "declared secondary range plans binary-search bounds and preserve null comparison" {
  let db = database_open()
  ignore(
    database_exec(
      db, "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)", "[]", false,
    ),
  )
  ignore(database_exec(db, "CREATE INDEX ix ON t(n)", "[]", false))
  ignore(
    database_exec(
      db, "INSERT INTO t VALUES(5,30),(4,20),(3,20),(2,10),(1,NULL)", "[]", false,
    ),
  )
  let table = get_table(db.store, "t")
  let parser = lex("SELECT id,n FROM t WHERE n>=? AND n<? ORDER BY n")
  guard parse_statement(parser) is Select(select) else {
    fail("expected select")
  }
  guard secondary_range(
      select,
      evaluation(db.store, [Integer(20L), Integer(30L)], []),
      table,
      "t",
    )
    is Some(range) else {
    fail("expected index plan")
  }
  assert_eq(range.rows[range.start:range.end].to_owned().map(r => r.id), [
    3L, 4L,
  ])
  guard secondary_range(
      select,
      evaluation(db.store, [Null, Integer(30L)], []),
      table,
      "t",
    )
    is Some(empty) else {
    fail("expected empty index plan")
  }
  assert_eq(empty.start, empty.end)
  assert_eq(db.store.indexes.length(), 1)
}

///|
test "secondary cache retains at most four indexes and is absent from stored JSON" {
  let db = database_open()
  ignore(
    database_exec(
      db, "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)", "[]", false,
    ),
  )
  for i in 0..<6 {
    ignore(
      database_exec(
        db,
        "CREATE INDEX ix" + i.to_string() + " ON t(n)",
        "[]",
        false,
      ),
    )
  }
  let image = database_dump(db)
  let table = get_table(db.store, "t")
  for i in 0..<6 {
    ignore(index_rows(db.store, table, "ix" + i.to_string(), 1))
    assert_true(db.store.indexes.length() <= 4)
  }
  assert_eq(database_dump(db), image)
  let restored : Store = @json.from_json(@json.to_json(db.store))
  assert_eq(restored.indexes.length(), 0)
  assert_eq(@json.to_json(restored), @json.to_json(db.store))
}

///|
test "writes to unrelated tables retain a valid secondary index" {
  let db = database_open()
  ignore(
    database_exec(
      db, "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)", "[]", false,
    ),
  )
  ignore(
    database_exec(
      db, "CREATE TABLE outbox(id INTEGER PRIMARY KEY)", "[]", false,
    ),
  )
  ignore(database_exec(db, "CREATE INDEX ix ON t(n)", "[]", false))
  ignore(index_rows(db.store, get_table(db.store, "t"), "ix", 1))
  assert_eq(db.store.indexes.length(), 1)
  ignore(database_exec(db, "INSERT INTO outbox VALUES(1)", "[]", false))
  assert_eq(db.store.indexes.length(), 1)
}

///|
test "LIMIT zero validates names without constructing a secondary index" {
  let db = database_open()
  ignore(
    database_exec(
      db, "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)", "[]", false,
    ),
  )
  ignore(database_exec(db, "CREATE INDEX ix ON t(n)", "[]", false))
  ignore(database_exec(db, "INSERT INTO t VALUES(1,10)", "[]", false))
  let result = database_query_values(
    db, "SELECT id FROM t WHERE n>=0 ORDER BY n LIMIT 0", "[]",
  )
  assert_true(result.contains("\"rows\":[]"))
  assert_eq(db.store.indexes.length(), 0)
}

///|
test "incremental indexes retain arrays through inserts, ties, moves, non-key writes and deletes" {
  let db = database_open()
  ignore(
    database_exec(
      db, "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER,body TEXT COLLATE NOCASE)",
      "[]", false,
    ),
  )
  ignore(database_exec(db, "CREATE INDEX ix ON t(n)", "[]", false))
  ignore(database_exec(db, "CREATE INDEX body ON t(body)", "[]", false))
  ignore(
    database_exec(
      db, "INSERT INTO t VALUES(3,20,'c'),(1,10,'A'),(2,10,'a')", "[]", false,
    ),
  )
  let table = get_table(db.store, "t")
  let numbers = index_rows(db.store, table, "ix", 1)
  let text = index_rows(db.store, table, "body", 2)
  let check = fn(ids : Array[Int64], names : Array[Int64]) raise {
    assert_true(physical_equal(numbers, index_rows(db.store, table, "ix", 1)))
    assert_true(physical_equal(text, index_rows(db.store, table, "body", 2)))
    assert_eq(numbers.map(r => r.id), ids)
    assert_eq(text.map(r => r.id), names)
  }
  ignore(database_exec(db, "INSERT INTO t VALUES(4,NULL,'B')", "[]", false))
  check([4L, 1L, 2L, 3L], [1L, 2L, 4L, 3L])
  ignore(database_exec(db, "UPDATE t SET body='a ' WHERE id=3", "[]", false))
  check([4L, 1L, 2L, 3L], [1L, 2L, 3L, 4L])
  assert_true(numbers[3].values[2] == Text("a "))
  ignore(database_exec(db, "UPDATE t SET id=9 WHERE id=2", "[]", false))
  check([4L, 1L, 9L, 3L], [1L, 9L, 3L, 4L])
  ignore(
    database_exec(db, "UPDATE t SET n=NULL,body='A' WHERE id=3", "[]", false),
  )
  check([3L, 4L, 1L, 9L], [1L, 3L, 9L, 4L])
  ignore(
    database_exec(
      db, "INSERT INTO t VALUES(1,99,'Z') ON CONFLICT(id) DO UPDATE SET n=excluded.n,body=excluded.body",
      "[]", false,
    ),
  )
  check([3L, 4L, 9L, 1L], [3L, 9L, 4L, 1L])
  ignore(
    database_exec(db, "INSERT OR REPLACE INTO t VALUES(4,10,'b')", "[]", false),
  )
  check([3L, 4L, 9L, 1L], [3L, 9L, 4L, 1L])
  ignore(database_exec(db, "DELETE FROM t WHERE n IS NULL", "[]", false))
  check([4L, 9L, 1L], [9L, 4L, 1L])
  ignore(database_exec(db, "DELETE FROM t", "[]", false))
  check([], [])
  assert_eq(numbers.capacity(), 0)
  assert_eq(text.capacity(), 0)
  ignore(database_exec(db, "INSERT INTO t VALUES(6,-1,'x')", "[]", false))
  check([6L], [6L])
}

///|
test "failed multi-row writes discard modified indexes without changing a clone" {
  let db = database_open()
  ignore(
    database_exec(
      db, "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER UNIQUE)", "[]", false,
    ),
  )
  ignore(database_exec(db, "CREATE INDEX ix ON t(n)", "[]", false))
  ignore(database_exec(db, "INSERT INTO t VALUES(1,10),(2,20)", "[]", false))
  let table = get_table(db.store, "t")
  let cached = index_rows(db.store, table, "ix", 1)
  let clone = database_clone(db)
  let snapshot = index_rows(clone.store, get_table(clone.store, "t"), "ix", 1)
  assert_false(physical_equal(cached, snapshot))
  let image = database_dump(db)
  let failure = database_exec(db, "UPDATE t SET n=7", "[]", false)
  assert_true(failure.contains("UNIQUE constraint failed"))
  assert_eq(db.store.indexes.length(), 0)
  assert_eq(database_dump(db), image)
  let restored = index_rows(db.store, get_table(db.store, "t"), "ix", 1)
  assert_false(physical_equal(cached, restored))
  assert_true(restored.map(r => r.values[1]) == [Integer(10L), Integer(20L)])
  assert_true(snapshot.map(r => r.values[1]) == [Integer(10L), Integer(20L)])
  assert_eq(database_dump(clone), image)
}
