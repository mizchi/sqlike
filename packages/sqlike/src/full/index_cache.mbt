///|
priv struct CachedIndex {
  table : String
  cookie : Int32
  fields : Array[IndexField]
  predicate : Expr?
  rows : IndexRows
}

///|
fn compare_index_rows(
  store : Store,
  fields : Array[IndexField],
  a : StoredRow,
  b : StoredRow,
) -> Int32 {
  for field in fields {
    let order = compare_stored(
      store,
      index_field_value(a, field),
      index_field_value(b, field),
      field.collation,
    )
    if order != 0 {
      return if field.descending { -order } else { order }
    }
  }
  a.id.compare(b.id)
}

///|
/// Locate a full index key, including rowid to distinguish equal column values.
fn index_row_bound(
  store : Store,
  rows : IndexRows,
  fields : Array[IndexField],
  row : StoredRow,
) -> Int32 {
  rows.bound(candidate => compare_index_rows(store, fields, candidate, row) < 0)
}

///|
/// Changed keys may still fit between the same neighbors, avoiding row shifts.
fn index_slot_accepts(
  store : Store,
  rows : IndexRows,
  fields : Array[IndexField],
  position : Int32,
  row : StoredRow,
) -> Bool {
  if position > 0 &&
    compare_index_rows(store, fields, rows[position - 1], row) >= 0 {
    return false
  }
  if position + 1 < rows.length() &&
    compare_index_rows(store, fields, row, rows[position + 1]) >= 0 {
    return false
  }
  true
}

///|
/// A row delta updates only indexes already built for this table. Immutable row
/// values can be shared, but these mutable arrays never cross store checkpoints.
fn update_table_indexes(
  store : Store,
  table : Table,
  previous : StoredRow?,
  next : StoredRow?,
) -> Unit {
  update_primary_index(store, table, previous, next)
  if store.indexes.length() == 0 {
    return
  }
  for (name, index) in store.indexes.to_array() {
    if index.table != table.name {
      continue
    }
    if index.cookie != store.cookie {
      ignore(store.indexes.remove(name))
      continue
    }
    let fields = index.fields
    let membership = Some(
      (
        previous
        .map(row => cached_index_member(store, table, index.predicate, row))
        .unwrap_or(false),
        next
        .map(row => cached_index_member(store, table, index.predicate, row))
        .unwrap_or(false),
      ),
    ) catch {
      _ => None
    }
    guard membership is Some((old_member, new_member)) else {
      ignore(store.indexes.remove(name))
      continue
    }
    let before = if old_member { previous } else { None }
    let after = if new_member { next } else { None }
    if before is Some(row) {
      let position = index_row_bound(store, index.rows, fields, row)
      if position == index.rows.length() ||
        compare_index_rows(store, fields, index.rows[position], row) != 0 {
        // An unprovable cache can always be reconstructed from the table.
        ignore(store.indexes.remove(name))
        continue
      }
      if after is Some(replacement) {
        if compare_index_rows(store, fields, row, replacement) == 0 ||
          index_slot_accepts(store, index.rows, fields, position, replacement) {
          // Publish every new row, even when its key or ordering is unchanged.
          index.rows[position] = replacement
          continue
        }
      }
      ignore(index.rows.remove(position))
    }
    if after is Some(row) {
      let position = index_row_bound(store, index.rows, fields, row)
      index.rows.insert(position, row)
    }
  }
}

///|
fn invalidate_table_indexes(store : Store, table : Table) -> Unit {
  ignore(store.primary_indexes.remove(table.name))
  if store.indexes.length() == 0 {
    return
  }
  for (name, index) in store.indexes.to_array() {
    if index.table == table.name {
      ignore(store.indexes.remove(name))
    }
  }
}

///|
/// Bulk replacement (DDL) invalidates indexes; ordinary DML supplies row deltas.
fn replace_table_rows(
  store : Store,
  table : Table,
  rows : Array[StoredRow],
) -> Unit {
  invalidate_table_indexes(store, table)
  dirty_snapshot(store)
  table.rows = row_pages(rows)
}

///|
fn append_table_row(store : Store, table : Table, row : StoredRow) -> Unit {
  update_table_indexes(store, table, None, Some(row))
  table.rows.push(row)
  dirty_edit(store, AppendRow(table.name, persistent_generated_row(table, row)))
}

///|
fn replace_table_row(
  store : Store,
  table : Table,
  previous : StoredRow,
  next : StoredRow,
) -> Unit {
  let slot = if FEATURE_PRIMARY_INDEX {
    primary_index(store, table).slots.get(previous.id)
  } else {
    None
  }
  let position = slot.unwrap_or_else(() => {
    for (i, row) in table.rows.slot_entries() {
      if row.id == previous.id {
        return i
      }
    }
    -1
  })
  if position < 0 {
    return
  }
  // BEFORE triggers may have changed this row: compare current storage, not
  // the caller's old row. Constraints/events/counters still run in the caller.
  if table.rows.get_slot(position) is Some(current) &&
    current.id == next.id &&
    same_stored_values(current.values, next.values) {
    return
  }
  update_table_indexes(store, table, Some(previous), Some(next))
  table.rows.set_slot(position, next)
  dirty_replace(store, table, previous, next)
}

///|
fn remove_table_row(store : Store, table : Table, row : StoredRow) -> Unit {
  let position = if FEATURE_PRIMARY_INDEX {
    primary_index(store, table).slots.get(row.id)
  } else {
    table.rows
    .slot_entries()
    .find_first(pair => pair.1.id == row.id)
    .map(pair => pair.0)
  }
  guard position is Some(position) else { return }
  update_table_indexes(store, table, Some(row), None)
  if table.rows.remove_slot(position) {
    // Stable slots survive ordinary deletes; repacking invalidates this root only.
    ignore(store.primary_indexes.remove(table.name))
  }
  dirty_edit(store, DeleteRow(table.name, row.id))
}

///|
fn schema_changed(store : Store) -> Unit {
  if FEATURE_GENERATED_COLUMNS {
    store.generated_plans.clear()
  }
  store.indexes.clear()
  store.primary_indexes.clear()
  dirty_snapshot(store)
  store.cookie += 1
}

///|
fn index_rows_for_fields(
  store : Store,
  table : Table,
  name : String,
  fields : Array[IndexField],
  predicate : Expr?,
) -> IndexRows raise SqlError {
  if store.indexes.get(name) is Some(index) &&
    index.cookie == store.cookie &&
    index.fields == fields {
    return index.rows
  }
  let rows = if predicate is None {
    table.rows.copy()
  } else {
    table.rows.filter(row => cached_index_member(store, table, predicate, row))
  }
  rows.sort_by((a, b) => compare_index_rows(store, fields, a, b))
  let rows = index_pages(rows)
  // Bound retained row references. Additional indexes can always be rebuilt.
  if store.indexes.length() >= 4 {
    store.indexes.clear()
  }
  store.indexes[name] = {
    table: table.name,
    cookie: store.cookie,
    fields,
    predicate,
    rows,
  }
  rows
}

///|
fn cached_index_member(
  store : Store,
  table : Table,
  predicate : Expr?,
  row : StoredRow,
) -> Bool raise SqlError {
  match predicate {
    None => true
    Some(e) =>
      truth(
        evaluate(
          e,
          evaluation(store, [], row_environment(table, row, table.name)),
        ),
      ) ==
      1
  }
}

///|
fn index_prefix_bound(
  store : Store,
  rows : IndexRows,
  fields : Array[IndexField],
  values : Array[Value],
  after_equal : Bool,
) -> Int32 {
  rows.bound(candidate => {
    let mut order = 0
    for i, value in values {
      let field = fields[i]
      order = compare_stored(
        store,
        index_field_value(candidate, field),
        value,
        field.collation,
      )
      if field.descending {
        order = -order
      }
      if order != 0 {
        break
      }
    }
    order < 0 || (after_equal && order == 0)
  })
}
