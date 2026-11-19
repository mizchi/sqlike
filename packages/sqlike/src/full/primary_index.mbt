///|
/// Derived persistent point indexes. Fork mutable wrappers, share immutable
/// roots, and read current row values through stable physical slots.
priv struct PrimaryIndex {
  mut slots : @rowmap.HashMap[Int64, Int32]
  mut keys : @rowmap.HashMap[String, Int64]
  mut maximum : Int64?
}

///|
fn primary_value_key(table : Table, values : Array[Value]) -> String? {
  let parts : Array[Json] = []
  for i in primary_key(table) {
    guard primary_part_key(
        values[i],
        column_affinity(table, table.columns[i]),
        table.columns[i].collation,
      )
      is Some(part) else {
      return None
    }
    parts.push(part)
  }
  if parts.is_empty() {
    None
  } else {
    Some(Json::array(parts).stringify())
  }
}

///|
fn primary_part_key(
  input : Value,
  affinity : String,
  collation : String,
) -> Json? {
  let mut value = apply_affinity(input, affinity)
  if value is Null {
    return None
  }
  if value is Real(n) &&
    n >= -9223372036854775808.0 &&
    n < 9223372036854775808.0 &&
    n.to_int64().to_double() == n {
    value = Integer(n.to_int64())
  }
  if value is Text(s) {
    if collation == "nocase" {
      return Some(
        Json::array([
          Json::number(@utf8.encode(s).length().to_double()),
          value_json(Text(nocase_prefix(s))),
        ]),
      )
    }
    if collation == "rtrim" {
      value = Text(s.trim_end(chars=" ").to_owned())
    }
  }
  Some(value_json(value))
}

///|
fn primary_index(store : Store, table : Table) -> PrimaryIndex {
  if store.primary_indexes.get(table.name) is Some(index) {
    return index
  }
  let slots : Array[(Int64, Int32)] = []
  let keys : Array[(String, Int64)] = []
  let composite = integer_primary(table) < 0
  let mut maximum : Int64? = None
  for (slot, row) in table.rows.slot_entries() {
    maximum = Some(maximum.map(n => n.max(row.id)).unwrap_or(row.id))
    slots.push((row.id, slot))
    if composite && primary_value_key(table, row.values) is Some(key) {
      keys.push((key, row.id))
    }
  }
  let index : PrimaryIndex = {
    slots: @rowmap.HashMap(slots[:]),
    keys: @rowmap.HashMap(keys[:]),
    maximum: Some(maximum.unwrap_or(0L)),
  }
  if store.primary_indexes.length() >= 4 {
    store.primary_indexes.clear()
  }
  store.primary_indexes[table.name] = index
  index
}

///|
fn update_primary_index(
  store : Store,
  table : Table,
  previous : StoredRow?,
  next : StoredRow?,
) -> Unit {
  if !FEATURE_PRIMARY_INDEX {
    return
  }
  if store.primary_indexes.get(table.name) is Some(index) {
    if previous is Some(row) &&
      next.map(r => r.id) != Some(row.id) &&
      index.maximum == Some(row.id) {
      index.maximum = None
    }
    if next is Some(row) {
      if previous is None && table.rows.is_empty() {
        index.maximum = Some(row.id)
      } else if index.maximum is Some(maximum) {
        index.maximum = Some(maximum.max(row.id))
      }
    }
    let slot = match previous {
      Some(row) => index.slots.get(row.id).unwrap_or(table.rows.used)
      None => table.rows.used
    }
    if previous is Some(row) && next.map(r => r.id) != Some(row.id) {
      index.slots = index.slots.remove(row.id)
    }
    if next is Some(row) && index.slots.get(row.id) != Some(slot) {
      index.slots = index.slots.add(row.id, slot)
    }
    if integer_primary(table) >= 0 {
      return
    }
    if previous is Some(row) {
      if primary_value_key(table, row.values) is Some(key) {
        index.keys = index.keys.remove(key)
      }
    }
    if next is Some(row) {
      if primary_value_key(table, row.values) is Some(key) {
        index.keys = index.keys.add(key, row.id)
      }
    }
  }
}

///|
/// Derived allocation metadata. Removing the maximum invalidates just this
/// value; the next automatic allocation scans once. Restore/clone remain safe.
fn maximum_rowid(store : Store, table : Table) -> Int64 {
  let index = if FEATURE_PRIMARY_INDEX {
    Some(primary_index(store, table))
  } else {
    None
  }
  if index is Some(index) && index.maximum is Some(maximum) {
    return if table.autoincrement {
      maximum.max(table.sequence)
    } else {
      maximum
    }
  }
  let mut maximum : Int64? = None
  for row in table.rows {
    maximum = Some(maximum.map(n => n.max(row.id)).unwrap_or(row.id))
  }
  let result = maximum.unwrap_or(0L)
  if index is Some(index) {
    index.maximum = Some(result)
  }
  if table.autoincrement {
    result.max(table.sequence)
  } else {
    result
  }
}

///|
fn primary_row(index : PrimaryIndex, table : Table, id : Int64) -> StoredRow? {
  match index.slots.get(id) {
    Some(slot) => table.rows.get_slot(slot)
    None => None
  }
}

///|
fn primary_key_row(
  index : PrimaryIndex,
  table : Table,
  key : String,
) -> StoredRow? {
  match index.keys.get(key) {
    Some(id) => primary_row(index, table, id)
    None => None
  }
}

///|
fn table_row_by_id(store : Store, table : Table, id : Int64) -> StoredRow? {
  if FEATURE_PRIMARY_INDEX {
    primary_row(primary_index(store, table), table, id)
  } else {
    table.rows.iter().find_first(row => row.id == id)
  }
}

///|
fn primary_terms(
  table : Table,
  predicate : Expr,
  params : Array[Value],
  qualifier : String,
  values : Map[Int32, Value],
) -> Unit {
  match predicate {
    Binary("and", a, b) => {
      primary_terms(table, a, params, qualifier, values)
      primary_terms(table, b, params, qualifier, values)
    }
    Binary(op, a, b) => {
      if op != "=" && op != "==" {
        return
      }
      for (column, expression) in [(a, b), (b, a)] {
        if column is Column(q, name) &&
          (q == "" || matches_identifier(q, identifier(qualifier))) {
          for i in primary_key(table) {
            if matches_identifier(table.columns[i].name, identifier(name)) {
              match expression {
                Literal(value) => values[i] = value
                Parameter(p) => if p < params.length() { values[i] = params[p] }
                _ => ()
              }
            }
          }
        }
      }
    }
    _ => ()
  }
}

///|
/// Some([]) is an indexed miss. None means a scan is necessary. The original
/// predicate is always evaluated so additional clauses retain SQL semantics.
fn primary_candidates(
  store : Store,
  table : Table,
  predicate : Expr,
  params : Array[Value],
  qualifier : String,
) -> Array[StoredRow]? {
  if !FEATURE_PRIMARY_INDEX {
    return None
  }
  if rowid_equality(table, predicate, params, qualifier) is Some(id) {
    return Some(
      primary_row(primary_index(store, table), table, id)
      .map(r => [r])
      .unwrap_or([]),
    )
  }
  let keys = primary_key(table)
  if keys.is_empty() {
    return None
  }
  let values : Map[Int32, Value] = Map([])
  primary_terms(table, predicate, params, qualifier, values)
  if !keys.all(i => values.contains(i)) {
    return None
  }
  let row : Array[Value] = Array::make(table.columns.length(), Null)
  for i in keys {
    row[i] = values[i]
  }
  let ipk = integer_primary(table)
  if ipk >= 0 {
    let value = apply_affinity(
      row[ipk],
      column_affinity(table, table.columns[ipk]),
    )
    let id = match value {
      Integer(n) => Some(n)
      Real(n) =>
        if n >= -9223372036854775808.0 &&
          n < 9223372036854775808.0 &&
          n.to_int64().to_double() == n {
          Some(n.to_int64())
        } else {
          None
        }
      _ => None
    }
    return Some(
      match id {
        Some(n) =>
          primary_row(primary_index(store, table), table, n)
          .map(r => [r])
          .unwrap_or([])
        None => []
      },
    )
  }
  if primary_value_key(table, row) is Some(key) {
    return Some(
      primary_key_row(primary_index(store, table), table, key)
      .map(r => [r])
      .unwrap_or([]),
    )
  }
  Some([])
}
