///|
/// Deterministic materialized edits, not SQL replay. Version 2 adds column
/// patches; version 1 after-images remain readable. Preserve publication order.
#derive(ToJson, FromJson)
priv enum RowEdit {
  AppendRow(String, StoredRow)
  ReplaceRow(String, Int64, StoredRow)
  DeleteRow(String, Int64)
  PatchRow(String, Int64, Int64, Array[(Int32, Value)])
}

///|
priv struct DirtyState {
  mut full : Bool
  base : Int32
  edits : Array[RowEdit]
}

///|
fn dirty_state() -> DirtyState {
  { full: true, base: 0, edits: [], }
}

///|
fn dirty_snapshot(store : Store) -> Unit {
  store.dirty.full = true
  store.dirty.edits.clear()
}

///|
fn dirty_edit(store : Store, edit : RowEdit) -> Unit {
  if !store.dirty.full {
    if store.dirty.edits.length() >= 4096 {
      dirty_snapshot(store)
    } else {
      store.dirty.edits.push(edit)
    }
  }
}

///|
/// Storage equality must not use SQL comparison/affinity, or merge +0 / -0.
/// Unchanged TEXT/BLOB values usually share the immutable Value object.
fn same_stored_value(before : Value, after : Value) -> Bool {
  if physical_equal(before, after) {
    return true
  }
  match (before, after) {
    (Real(a), Real(b)) => a.reinterpret_as_uint64() == b.reinterpret_as_uint64()
    _ => before == after
  }
}

///|
/// Capture at row replacement, without dumping/diffing the database or keeping
/// the previous row alive. Published patch arrays and row values are immutable.
fn dirty_replace(
  store : Store,
  name : String,
  before : StoredRow,
  after : StoredRow,
) -> Unit {
  if store.dirty.full {
    return
  }
  if store.dirty.edits.length() >= 4096 {
    dirty_snapshot(store)
    return
  }
  let columns : Array[(Int32, Value)] = []
  for i, value in after.values {
    if !same_stored_value(before.values[i], value) {
      columns.push((i, value))
    }
  }
  if columns.is_empty() && before.id == after.id {
    return
  }
  // A complete replacement is more compact when every column changed.
  dirty_edit(
    store,
    if columns.length() == after.values.length() {
      ReplaceRow(name, before.id, after)
    } else {
      PatchRow(name, before.id, after.id, columns)
    },
  )
}

///|
#derive(ToJson, FromJson)
priv struct FlushMetadata {
  encoding : Int32?
  cookie : Int32
  changes : Int32
  last_rowid : Int64
  foreign_keys : Bool
  deferred : Bool
  sequences : Array[(String, Int64, Bool?)]
}

///|
pub fn database_delta(db : Database, force_snapshot : Bool) -> String {
  let store = db.store
  if force_snapshot || store.dirty.full {
    (
      {
        "format": "sqlike-flush@1",
        "full": true,
        "serial": db.serial,
        "state": @json.to_json(store),
      } : Json).stringify()
  } else {
    let meta : FlushMetadata = {
      encoding: store.encoding,
      cookie: store.cookie,
      changes: store.changes,
      last_rowid: store.last_rowid,
      foreign_keys: store.foreign_keys,
      deferred: store.deferred,
      sequences: store.tables.map(t => (t.name, t.sequence, t.sequence_present)),
    }
    (
      {
        "format": "sqlike-flush@2",
        "full": false,
        "base": store.dirty.base,
        "serial": db.serial,
        "meta": @json.to_json(meta),
        "edits": @json.to_json(store.dirty.edits),
      } : Json).stringify()
  }
}

///|
/// The host calls this only after durable ACK, or after opening a known image.
pub fn database_ack_delta(db : Database, serial : Int32) -> String {
  if serial < 0 || serial != db.serial {
    return ({ "error": "stale flush acknowledgement" } : Json).stringify()
  }
  db.store.dirty = { full: false, base: serial, edits: [], }
  "{}"
}

///|
fn flush_row(
  store : Store,
  table : Table,
  row : StoredRow,
  except : Int64?,
) -> Unit raise SqlError {
  let ipk = integer_primary(table)
  guard row.values.length() == table.columns.length() &&
    (ipk < 0 || row.values[ipk] == Integer(row.id)) else {
    fail("invalid flush row")
  }
  for value in row.values {
    if value is Real(n) && n.is_nan() {
      fail("invalid flush real")
    }
  }
  guard table_row_by_id(store, table, row.id).filter(r => Some(r.id) != except)
    is None else {
    fail("duplicate flush rowid")
  }
  check_row(store, table, row.values, [])
  guard conflict_row(store, table, row.values, except, None) is None else {
    fail("flush UNIQUE constraint failed")
  }
}

///|
fn decode_flush(db : Database, text : String) -> (Store, Int32, Bool) raise {
  guard text.length() <= 67108864 else { fail("flush resource limit") }
  let json = @json.parse(text)
  guard json
    is { "format": String(format), "serial": serial, "full": is_full, .. } &&
    (format == "sqlike-flush@1" || format == "sqlike-flush@2") else {
    fail("invalid flush format")
  }
  let serial = flush_integer(serial)
  let full : Bool = @json.from_json(is_full)
  guard serial >= 0 else { fail("invalid flush serial") }
  if full {
    guard format == "sqlike-flush@1" else {
      fail("invalid flush snapshot version")
    }
    guard json is { "state": state, .. } else { fail("missing flush snapshot") }
    let store : Store = @json.from_json(state)
    return (store, serial, true)
  }
  guard json is { "base": base, "meta": meta, "edits": edits, .. } else {
    fail("invalid flush delta")
  }
  let base = flush_integer(base)
  guard base == db.serial && serial > base else {
    fail("flush serial mismatch")
  }
  guard meta is { "cookie": cookie, "changes": changes, .. } else {
    fail("invalid flush metadata")
  }
  ignore(flush_integer(cookie))
  ignore(flush_integer(changes))
  let meta : FlushMetadata = @json.from_json(meta)
  guard meta.cookie == db.store.cookie &&
    meta.encoding == db.store.encoding &&
    meta.changes >= 0 &&
    !meta.deferred &&
    meta.sequences.length() == db.store.tables.length() else {
    fail("flush metadata mismatch")
  }
  // FromJson[Int32] truncates fractions. Validate wire positions before typed
  // decoding so a malformed index cannot silently target a different column.
  guard edits is Array(raw_edits) && raw_edits.length() <= 100000 else {
    fail("flush edit limit")
  }
  for edit in raw_edits {
    if edit is Array([String("PatchRow"), _, _, _, Array(columns)]) {
      guard format == "sqlike-flush@2" else {
        fail("invalid flush patch version")
      }
      for column in columns {
        guard column is Array([index, _]) else { fail("invalid flush column") }
        ignore(flush_integer(index))
      }
    }
  }
  let edits : Array[RowEdit] = @json.from_json(edits)
  guard edits.length() <= 100000 else { fail("flush edit limit") }
  let store = copy_store(db.store)
  store.dirty = dirty_state()
  if format != "sqlike-flush@2" &&
    edits.any(edit => edit is PatchRow(_, _, _, _)) {
    fail("invalid flush patch version")
  }
  apply_materialized_edits(store, edits)
  for i, (name, sequence, present) in meta.sequences {
    let table = store.tables[i]
    guard table.name == name else { fail("flush table mismatch") }
    table.sequence = sequence
    table.sequence_present = present
  }
  store.changes = meta.changes
  store.last_rowid = meta.last_rowid
  store.foreign_keys = meta.foreign_keys
  store.deferred = false
  validate_foreign_keys(store)
  (store, serial, false)
}

///|
fn flush_integer(value : Json) -> Int32 raise SqlError {
  guard value is Number(number, ..) &&
    number >= 0.0 &&
    number <= 2147483647.0 &&
    number.to_int().to_double() == number else {
    fail("invalid flush integer")
  }
  number.to_int()
}

///|
fn publish_flush(db : Database, store : Store, serial : Int32) -> Unit {
  store.dirty = { full: false, base: serial, edits: [], }
  db.store = store
  db.serial = serial
  db.schema_epoch += 1L
}

///|
pub fn database_apply_delta(db : Database, text : String) -> String {
  try {
    let (store, serial, full) = decode_flush(db, text)
    if full {
      validate_image(store)
    }
    publish_flush(db, store, serial)
    "{}"
  } catch {
    error => ({ "error": public_error(error) } : Json).stringify()
  }
}

///|
fn same_stored_values(before : Array[Value], after : Array[Value]) -> Bool {
  if before.length() != after.length() {
    return false
  }
  for i in 0..<before.length() {
    if !same_stored_value(before[i], after[i]) {
      return false
    }
  }
  true
}
