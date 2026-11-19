///|
test "identifier matching folds only ASCII and accepts a normalized lookup key" {
  for
    (stored, requested, expected) in [
      ("id", "id", true),
      ("ID", "id", true),
      ("Mixed", "MIXED", true),
      ("日本語A", "日本語a", true),
      ("Ä", "ä", false),
      ("İ", "i", false),
      ("name", "other", false),
    ] {
    assert_eq(matches_identifier(stored, identifier(requested)), expected)
  }
}

///|
test "column lookup preserves projected priority, ambiguity and excluded scope" {
  let table_a = { ..binding("ID", Integer(1L)), qualifier: "A", }
  let table_b = { ..binding("id", Integer(2L)), qualifier: "b", }
  let projected = binding("Id", Integer(3L))
  let excluded = { ..binding("id", Integer(4L)), qualifier: "EXCLUDED", }
  assert_true(
    find_binding([table_a], "a", "id") is Some(b) && b.value is Integer(1L),
  )
  assert_true(
    find_binding([table_a, projected, table_b], "", "id") is Some(b) &&
    b.value is Integer(3L),
  )
  assert_true(
    find_binding([table_a, table_b], "b", "ID") is Some(b) &&
    b.value is Integer(2L),
  )
  assert_true(find_binding([excluded], "", "id") is None)
  assert_true(
    find_binding([excluded], "excluded", "id") is Some(b) &&
    b.value is Integer(4L),
  )
  assert_true(find_binding([table_a], "", "missing") is None)
  let ambiguous = try {
    ignore(find_binding([table_a, table_b], "", "id"))
    false
  } catch {
    _ => true
  }
  assert_true(ambiguous)
}

///|
test "row values reuse a layout without changing metadata or shadowed rowid columns" {
  let db = database_open()
  ignore(
    database_exec(
      db, "CREATE TABLE t(id INTEGER PRIMARY KEY,ROWID TEXT,body BLOB)", "[]", false,
    ),
  )
  ignore(
    database_exec(
      db, "INSERT INTO t VALUES(7,'shadow',x'00ff'),(9,'next',NULL)", "[]", false,
    ),
  )
  let table = get_table(db.store, "t")
  let layout = row_environment(
    table,
    { id: 0L, values: [Null, Null, Null], },
    "alias",
  )
  let first = row_environment_from(layout, table.rows[0])
  let second = row_environment_from(layout, table.rows[1])
  assert_eq(first.length(), 5)
  assert_eq(first[1].name, "ROWID")
  assert_eq(first[1].qualifier, "alias")
  assert_false(first[1].hidden)
  assert_true(first[1].value is Text("shadow"))
  assert_true(second[1].value is Text("next"))
  assert_true(first[2].value is Blob(b"\x00\xff"))
  assert_eq(first[3].name, "_rowid_")
  assert_true(first[3].hidden && first[3].value is Integer(7L))
  assert_true(second[3].value is Integer(9L))
  assert_true(layout[0].value is Null && layout[3].value is Integer(0L))
}

///|
test "database snapshots remain isolated through DML and schema changes" {
  let db = database_open()
  ignore(
    database_exec(
      db, "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER UNIQUE)", "[]", false,
    ),
  )
  ignore(database_exec(db, "INSERT INTO t VALUES(1,10),(2,20)", "[]", false))
  let before = database_clone(db)
  let image = database_dump(before)
  ignore(database_exec(db, "UPDATE t SET n=30 WHERE id=1", "[]", false))
  ignore(
    database_exec(
      db, "ALTER TABLE t ADD COLUMN body TEXT DEFAULT 'new'", "[]", false,
    ),
  )
  ignore(
    database_exec(db, "ALTER TABLE t RENAME COLUMN n TO value", "[]", false),
  )
  ignore(database_exec(db, "DELETE FROM t WHERE id=2", "[]", false))
  assert_eq(database_dump(before), image)
  let current = database_dump(db)
  ignore(database_exec(before, "INSERT INTO t VALUES(3,40)", "[]", false))
  assert_eq(database_dump(db), current)
  let stable = database_dump(before)
  let failure = database_exec(before, "UPDATE t SET n=10", "[]", false)
  assert_true(failure.contains("UNIQUE constraint"))
  assert_eq(database_dump(before), stable)
}

///|
test "simple projection binds stored columns and constants before visiting rows" {
  let db = database_open()
  ignore(
    database_exec(
      db, "CREATE TABLE t(id INTEGER PRIMARY KEY,rowid TEXT,n INTEGER)", "[]", false,
    ),
  )
  ignore(database_exec(db, "INSERT INTO t VALUES(7,'shadow',20)", "[]", false))
  let parser = lex("SELECT rowid,n AS label,42,NULL,t.* FROM t")
  guard parse_statement(parser) is Select(select) else {
    fail("expected SELECT")
  }
  let table = get_table(db.store, "t")
  guard simple_projection(select, table, "t") is Some(plan) else {
    fail("expected simple projection")
  }
  let output = selection_template(select, evaluation(db.store, [], []))
  let row = project_stored_row(plan, output, table.rows[0])
  assert_eq(row.length(), 7)
  assert_true(row[0].value is Text("shadow"))
  assert_eq(row[1].name, "label")
  assert_true(row[1].value is Integer(20L))
  assert_true(row[2].value is Integer(42L))
  assert_true(row[3].value is Null)
  assert_true(row[4].value is Integer(7L))
  assert_true(output[0].value is Null)
}

///|
test "unique key revalidation depends on all key fields and preserves storage classes" {
  let before : Array[Value] = [Integer(1L), Integer(10L), Text("A")]
  let after : Array[Value] = [Integer(1L), Integer(20L), Text("A")]
  assert_false(key_changed([0], before, after))
  assert_true(key_changed([1], before, after))
  assert_true(key_changed([0, 1], before, after))
  assert_false(key_changed([0, 2], before, after))
  assert_true(key_changed([0], before, [Real(1.0), Integer(10L), Text("A")]))
}

///|
test "copy-on-write shares checkpoints until mutation and preserves candidate rows" {
  let db = database_open()
  ignore(
    database_exec(
      db, "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)", "[]", false,
    ),
  )
  ignore(
    database_exec(db, "INSERT INTO t VALUES(1,10),(2,20),(3,30)", "[]", false),
  )
  let table = get_table(db.store, "t")
  let owned = table.rows.pages
  let candidates = candidate_rows(db.store, table, None)
  let checkpoint = copy_store(db.store)
  let clone = database_clone(db)
  let image = database_dump(clone)
  assert_true(physical_equal(owned, get_table(checkpoint, "t").rows.pages))
  let result = database_exec(db, "UPDATE t SET n=99 WHERE id=2", "[]", false)
  assert_false(result.contains("\"error\""))
  assert_false(physical_equal(owned, table.rows.pages))
  assert_true(table.rows[1].values[1] is Integer(99L))
  assert_true(candidates[1].values[1] is Integer(20L))
  assert_true(get_table(checkpoint, "t").rows[1].values[1] is Integer(20L))
  assert_eq(database_dump(clone), image)
  ignore(database_exec(db, "UPDATE t SET id=12 WHERE id=2", "[]", false))
  assert_false(physical_equal(owned, table.rows.pages))
  assert_eq(table.rows.map(row => row.id), [1L, 12L, 3L])
  assert_eq(candidates.map(row => row.id), [1L, 2L, 3L])
  for id in [1L, 12L, 3L] {
    let response = database_exec(
      db,
      "UPDATE t SET n=0 WHERE id=?",
      Json::array([value_json(Integer(id))]).stringify(),
      false,
    )
    assert_false(response.contains("\"error\""))
    assert_false(physical_equal(owned, table.rows.pages))
  }
  assert_true(table.rows.iter().all(row => row.values[1] is Integer(0L)))
  assert_eq(database_dump(clone), image)
}

///|
test "primary map updates independently from secondary indexes and is checkpoint-local" {
  let db = database_open()
  ignore(
    database_exec(
      db, "CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT)", "[]", false,
    ),
  )
  ignore(database_exec(db, "INSERT INTO t VALUES(1,'a'),(2,'b')", "[]", false))
  db.store.primary_indexes.clear()
  inspect(db.store.primary_indexes.length(), content="0")
  ignore(database_exec(db, "SELECT v FROM t WHERE id=1", "[]", false))
  inspect(db.store.primary_indexes.length(), content="1")
  inspect(
    primary_index(db.store, get_table(db.store, "t")).keys.length(),
    content="0",
  )
  let saved = database_clone(db)
  ignore(database_exec(db, "UPDATE t SET id=3,v='c' WHERE id=1", "[]", false))
  assert_true(
    !primary_index(db.store, get_table(db.store, "t")).slots.contains(1L),
  )
  assert_true(
    primary_index(db.store, get_table(db.store, "t")).slots.contains(3L),
  )
  assert_eq(saved.store.primary_indexes.length(), 1)
  assert_true(
    primary_index(saved.store, get_table(saved.store, "t")).slots.contains(1L),
  )
  ignore(database_exec(db, "DELETE FROM t WHERE id=3", "[]", false))
  assert_true(
    !primary_index(db.store, get_table(db.store, "t")).slots.contains(3L),
  )
}

///|
test "copy on write does not copy an untouched table" {
  let db = database_open()
  ignore(
    database_exec(
      db, "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)", "[]", false,
    ),
  )
  ignore(
    database_exec(db, "CREATE TABLE cold(id INTEGER PRIMARY KEY)", "[]", false),
  )
  ignore(database_exec(db, "INSERT INTO t VALUES(1,10)", "[]", false))
  ignore(database_exec(db, "INSERT INTO cold VALUES(1),(2),(3)", "[]", false))
  let checkpoint = copy_store(db.store)
  let cold = get_table(checkpoint, "cold").rows.pages
  assert_true(physical_equal(cold, get_table(db.store, "cold").rows.pages))
  ignore(database_exec(db, "UPDATE t SET n=11 WHERE id=1", "[]", false))
  assert_true(physical_equal(cold, get_table(db.store, "cold").rows.pages))
  assert_true(get_table(checkpoint, "t").rows[0].values[1] is Integer(10L))
  assert_true(get_table(db.store, "t").rows[0].values[1] is Integer(11L))
}
