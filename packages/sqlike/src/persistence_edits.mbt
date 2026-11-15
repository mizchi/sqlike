///|
fn apply_materialized_edits(
  store : Store,
  edits : Array[RowEdit],
) -> Unit raise SqlError {
  for edit in edits {
    match edit {
      AppendRow(name, row) => {
        let table = get_table(store, name)
        flush_row(store, table, row, None)
        append_table_row(store, table, row)
        guard table.rows.length() <= 100000 else { fail("flush table limit") }
      }
      ReplaceRow(name, id, row) => {
        let table = get_table(store, name)
        guard table_row_by_id(store, table, id) is Some(previous) else {
          fail("missing flush row")
        }
        flush_row(store, table, row, Some(id))
        replace_table_row(store, table, previous, row)
      }
      DeleteRow(name, id) => {
        let table = get_table(store, name)
        guard table_row_by_id(store, table, id) is Some(row) else {
          fail("missing flush row")
        }
        remove_table_row(store, table, row)
      }
      PatchRow(name, id, next_id, columns) => {
        let table = get_table(store, name)
        guard table_row_by_id(store, table, id) is Some(previous) else {
          fail("missing flush row")
        }
        let values = previous.values.copy()
        let mut last = -1
        for (index, value) in columns {
          guard index > last && index < values.length() else {
            fail("invalid flush column index")
          }
          values[index] = value
          last = index
        }
        let row = { id: next_id, values, }
        flush_row(store, table, row, Some(id))
        replace_table_row(store, table, previous, row)
      }
    }
  }
}
