///|
test "large rowid order cache bounds deletion shifts and keeps ordered rows" {
  let db = database_open()
  ignore(
    database_exec(
      db, "CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)", "[]", false,
    ),
  )
  let table = get_table(db.store, "t")
  table.rows = row_pages(
    Array::makei(10000, i => {
      id: (i + 1).to_int64(),
      values: [Integer((i + 1).to_int64()), Integer(i.to_int64())],
    }),
  )
  let index = ordered_rowid_rows(db.store, table)
  assert_true(index.blocks.length() > 1)
  assert_true(index.blocks.all(block => block.length() <= 256))
  for id in 1..<301 {
    let bindings =
      $|[{"t":"integer","v":"\{id}"}]
    ignore(database_exec(db, "DELETE FROM t WHERE id=?", bindings, false))
  }
  assert_eq(index.length(), 9700)
  assert_eq(index[0].id, 301L)
  assert_eq(index[index.length() - 1].id, 10000L)
  assert_true(index.blocks.all(block => block.length() <= 256))
}
