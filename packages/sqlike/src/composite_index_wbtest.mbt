///|
test "mixed direction composite index narrows equality prefixes and scans both ways" {
  let db = database_open()
  assert_false(
    database_exec(
      db, "CREATE TABLE t(id INTEGER PRIMARY KEY,tenant TEXT COLLATE NOCASE,n INTEGER,body TEXT)",
      "[]", false,
    ).contains("error"),
  )
  assert_false(
    database_exec(
      db, "CREATE INDEX feed ON t(tenant COLLATE NOCASE ASC,n DESC,id ASC)", "[]",
      false,
    ).contains("error"),
  )
  ignore(
    database_exec(
      db, "INSERT INTO t VALUES(1,'a',20,'yes'),(2,'A',10,'no'),(3,'a',20,'yes'),(4,'b',30,'yes'),(5,'a',NULL,'yes')",
      "[]", false,
    ),
  )
  let table = get_table(db.store, "t")
  let read = fn(sql : String) raise {
    guard parse_statement(lex(sql)) is Select(select) else { fail("select") }
    guard secondary_range(
        select,
        evaluation(db.store, [Text("a"), Integer(10L), Integer(30L)], []),
        table,
        "t",
      )
      is Some(range) else {
      fail("expected composite plan")
    }
    range
  }
  let forward = read(
    "SELECT id,n FROM t WHERE tenant=? AND n>=? AND n<? ORDER BY n DESC,id ASC",
  )
  assert_false(forward.reverse)
  assert_eq(forward.rows[forward.start:forward.end].to_owned().map(r => r.id), [
    1L, 3L, 2L,
  ])
  let reverse = read(
    "SELECT id,n FROM t WHERE tenant=? AND n>=? AND n<? ORDER BY n ASC,id DESC",
  )
  assert_true(reverse.reverse)
  assert_eq(reverse.start, forward.start)
  assert_eq(reverse.end, forward.end)
  assert_eq(db.store.indexes.length(), 1)
  let cached = forward.rows
  ignore(database_exec(db, "UPDATE t SET n=25 WHERE id=2", "[]", false))
  let next = read(
    "SELECT id,n FROM t WHERE tenant=? AND n>=? AND n<? ORDER BY n DESC,id ASC",
  )
  assert_true(physical_equal(cached, next.rows))
  assert_eq(next.rows[next.start:next.end].to_owned().map(r => r.id), [
    2L, 1L, 3L,
  ])
}

///|
test "unique index uses its declared collations instead of column defaults" {
  let db = database_open()
  ignore(
    database_exec(
      db, "CREATE TABLE t(id INTEGER PRIMARY KEY,a TEXT,b TEXT COLLATE NOCASE)",
      "[]", false,
    ),
  )
  assert_false(
    database_exec(
      db, "CREATE UNIQUE INDEX uq ON t(a COLLATE NOCASE,b COLLATE BINARY DESC)",
      "[]", false,
    ).contains("error"),
  )
  assert_false(
    database_exec(
      db, "INSERT INTO t VALUES(1,'A','x'),(2,'a','X')", "[]", false,
    ).contains("error"),
  )
  let before = database_dump(db)
  assert_true(
    database_exec(db, "INSERT INTO t VALUES(3,'a','x')", "[]", false).contains(
      "UNIQUE",
    ),
  )
  assert_eq(database_dump(db), before)
  assert_true(
    database_exec(db, "UPDATE t SET b='x' WHERE id=2", "[]", false).contains(
      "UNIQUE",
    ),
  )
  assert_eq(database_dump(db), before)
  let restored = database_open()
  assert_eq(database_restore(restored, before), "{}")
  assert_eq(database_dump(restored), before)
}
