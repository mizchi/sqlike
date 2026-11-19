///|
test "clones preserve warm primary lookup state without sharing mutable wrappers" {
  let db = database_open()
  ignore(
    database_exec(
      db, "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)", "[]", false,
    ),
  )
  ignore(database_exec(db, "INSERT INTO t VALUES(1,10),(2,20)", "[]", false))
  let table = get_table(db.store, "t")
  let index = primary_index(db.store, table)
  let saved = database_clone(db)
  assert_eq(saved.store.primary_indexes.length(), 1)
  let other = primary_index(saved.store, get_table(saved.store, "t"))
  assert_false(physical_equal(index, other))
  assert_true(physical_equal(index.slots, other.slots))
  ignore(database_exec(db, "DELETE FROM t WHERE id=1", "[]", false))
  assert_true(
    database_query_values(saved, "SELECT n FROM t WHERE id=1", "[]").contains(
      "10",
    ),
  )
  assert_true(
    database_query_values(db, "SELECT n FROM t WHERE id=1", "[]").contains(
      "\"rows\":[]",
    ),
  )
}

///|
test "a checkpoint copies one 64-row page, and owned writes reuse that page" {
  let rows = row_pages(
    Array::makei(5000, i => {
      id: i.to_int64(),
      values: [Integer(i.to_int64())],
    }),
  )
  let saved = rows.fork()
  let original = rows.pages
  assert_true(physical_equal(original, saved.pages))
  rows.set_slot(2500, { id: 2500L, values: [Text("changed")], })
  let mut copied = 0
  for i in 0..<original.length() {
    if !physical_equal(original[i].rows, rows.pages[i].rows) {
      copied += original[i].rows.length()
    }
  }
  assert_eq(copied, 64)
  let owned = rows.pages[2500 / 64].rows
  rows.set_slot(2501, { id: 2501L, values: [Null], })
  assert_true(physical_equal(owned, rows.pages[2500 / 64].rows))
  assert_true(saved[2500].values[0] is Integer(2500L))
  assert_true(saved[2501].values[0] is Integer(2501L))
  let next = rows.fork()
  rows.set_slot(2500, { id: 2500L, values: [Text("again")], })
  assert_true(next[2500].values[0] is Text("changed"))
}

///|
test "row iterators retain their version across append, replacement and deletion" {
  let rows = row_pages(Array::makei(65, i => { id: i.to_int64(), values: [], }))
  let iter = rows.iter()
  rows.set_slot(0, { id: 99L, values: [], })
  ignore(rows.remove_slot(1))
  rows.push({ id: 100L, values: [], })
  assert_eq(
    iter.map(row => row.id).collect(),
    Array::makei(65, i => i.to_int64()),
  )
  assert_eq(rows[0].id, 99L)
  assert_eq(rows[1].id, 2L)
  assert_eq(rows[rows.length() - 1].id, 100L)
  assert_true(rows.get_slot(1) is None)
}

///|
test "deletes keep stable slots and eventually compact without changing snapshots" {
  let db = database_open()
  ignore(
    database_exec(
      db, "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)", "[]", false,
    ),
  )
  let table = get_table(db.store, "t")
  for i in 0..<1000 {
    append_table_row(db.store, table, {
      id: i.to_int64(),
      values: [Integer(i.to_int64()), Integer(i.to_int64())],
    })
  }
  let first = primary_index(db.store, table)
  let saved = database_clone(db)
  let root = table.rows.pages
  remove_table_row(db.store, table, table.rows[0])
  assert_eq(
    primary_index(db.store, table).slots.get(999L),
    first.slots.get(999L),
  )
  let mut copied = 0
  for i in 0..<root.length() {
    if !physical_equal(root[i].rows, table.rows.pages[i].rows) {
      copied += root[i].rows.length()
    }
  }
  assert_eq(copied, 64)
  for i in 1..<990 {
    let row = primary_row(primary_index(db.store, table), table, i.to_int64()).unwrap()
    remove_table_row(db.store, table, row)
  }
  assert_eq(
    table.rows.map(row => row.id),
    Array::makei(10, i => (990 + i).to_int64()),
  )
  assert_true(table.rows.used <= 128)
  assert_eq(get_table(saved.store, "t").rows.length(), 1000)
  assert_eq(
    primary_row(
      primary_index(saved.store, get_table(saved.store, "t")),
      get_table(saved.store, "t"),
      0L,
    ).unwrap().id,
    0L,
  )
  for i in 990..<1000 {
    remove_table_row(
      db.store,
      table,
      primary_row(primary_index(db.store, table), table, i.to_int64()).unwrap(),
    )
  }
  assert_eq(table.rows.used, 0)
  assert_eq(table.rows.pages.length(), 0)
  append_table_row(db.store, table, { id: 7L, values: [Integer(7L), Null], })
  assert_eq(primary_index(db.store, table).slots.get(7L), Some(0))
}
