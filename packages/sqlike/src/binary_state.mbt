///|
fn defined_state_write(db : DefinedDatabase, w : BinaryWriter) -> Unit raise {
  let (connection, _) = db.core.ready()
  let store = connection.database.store
  guard database_autocommit(connection.database) && !store.deferred else {
    fail("cannot persist an active defined transaction")
  }
  Binary::write(db.schema_id, w)
  Binary::write(connection.database.serial, w)
  Binary::write(store.changes, w)
  Binary::write(store.last_rowid, w)
  Binary::write(store.foreign_keys, w)
  w.uint(store.tables.length().reinterpret_as_uint())
  for table in store.tables {
    Binary::write(table.sequence, w)
    Binary::write(table.sequence_present, w)
    Binary::write(table.rows.copy(), w)
  }
}

///|
pub fn defined_snapshot(db : DefinedDatabase) -> BinaryResult {
  try {
    let (connection, _) = db.core.ready()
    let w = binary_writer()
    defined_state_write(db, w)
    {
      data: binary_finish(w, 4),
      full: true,
      serial: connection.database.serial,
      error: "",
    }
  } catch {
    e => { data: b"", full: true, serial: 0, error: public_error(e), }
  }
}

///|
fn defined_restore_checked(db : DefinedDatabase, bytes : Bytes) -> Unit raise {
  let (connection, program) = db.core.ready()
  guard database_autocommit(connection.database) else {
    fail("cannot restore an active transaction")
  }
  let r = binary_reader(bytes, 4, 67108864)
  let schema_id : String = Binary::read(r)
  guard schema_id == db.schema_id else {
    fail("defined snapshot schema mismatch")
  }
  let serial : Int32 = Binary::read(r)
  let changes : Int32 = Binary::read(r)
  let last_rowid : Int64 = Binary::read(r)
  let foreign_keys : Bool = Binary::read(r)
  let count = r.length()
  let store = copy_store(program.schema)
  guard serial >= 0 &&
    changes >= 0 &&
    count == store.tables.length() &&
    foreign_keys == store.foreign_keys else {
    fail("invalid defined snapshot metadata")
  }
  for table in store.tables {
    table.sequence = Binary::read(r)
    table.sequence_present = Binary::read(r)
    let rows : Array[StoredRow] = Binary::read(r)
    table.rows = row_pages(rows)
  }
  r.finish()
  store.changes = changes
  store.last_rowid = last_rowid
  validate_store_rows(store)
  publish_flush(connection.database, store, serial)
}

///|
pub fn defined_restore(db : DefinedDatabase, bytes : Bytes) -> String {
  try {
    defined_restore_checked(db, bytes)
    "{}"
  } catch {
    e => ({ "error": public_error(e) } : Json).stringify()
  }
}

///|
pub fn defined_delta(
  db : DefinedDatabase,
  force_snapshot : Bool,
) -> BinaryResult {
  try {
    let (connection, _) = db.core.ready()
    let database = connection.database
    let store = database.store
    if force_snapshot || store.dirty.full || database.serial == store.dirty.base {
      return defined_snapshot(db)
    }
    guard database_autocommit(database) && !store.deferred else {
      fail("cannot persist an active defined transaction")
    }
    let w = binary_writer()
    Binary::write(db.schema_id, w)
    Binary::write(store.dirty.base, w)
    Binary::write(database.serial, w)
    Binary::write(store.changes, w)
    Binary::write(store.last_rowid, w)
    Binary::write(store.foreign_keys, w)
    Binary::write(store.tables.map(t => (t.sequence, t.sequence_present)), w)
    Binary::write(store.dirty.edits, w)
    {
      data: binary_finish(w, 5),
      full: false,
      serial: database.serial,
      error: "",
    }
  } catch {
    e => { data: b"", full: false, serial: 0, error: public_error(e), }
  }
}

///|
pub fn defined_apply_delta(db : DefinedDatabase, bytes : Bytes) -> String {
  try {
    let (connection, _) = db.core.ready()
    let database = connection.database
    guard database_autocommit(database) else {
      fail("cannot replay into an active transaction")
    }
    let r = binary_reader(bytes, 5, 67108864)
    let schema_id : String = Binary::read(r)
    let base : Int32 = Binary::read(r)
    let serial : Int32 = Binary::read(r)
    let changes : Int32 = Binary::read(r)
    let last_rowid : Int64 = Binary::read(r)
    let foreign_keys : Bool = Binary::read(r)
    let sequences : Array[(Int64, Bool?)] = Binary::read(r)
    let edits : Array[RowEdit] = Binary::read(r)
    r.finish()
    guard schema_id == db.schema_id &&
      base == database.serial &&
      serial > base &&
      changes >= 0 &&
      sequences.length() == database.store.tables.length() &&
      foreign_keys == database.store.foreign_keys else {
      fail("defined delta schema/serial mismatch")
    }
    let store = copy_store(database.store)
    store.dirty = dirty_state()
    apply_materialized_edits(store, edits)
    for i, (sequence, present) in sequences {
      store.tables[i].sequence = sequence
      store.tables[i].sequence_present = present
    }
    store.changes = changes
    store.last_rowid = last_rowid
    validate_foreign_keys(store)
    publish_flush(database, store, serial)
    "{}"
  } catch {
    e => ({ "error": public_error(e) } : Json).stringify()
  }
}

///|
// Optional entry point. Only this path loads a SQLite layout/template.
pub fn defined_export_sqlite(
  schema : Bytes,
  statements : Bytes,
  layout : Bytes,
  image : Bytes,
) -> SqliteResult {
  try {
    let db = defined_open(schema, statements, image)
    let (connection, _) = db.core.ready()
    let r = binary_reader(layout, 3, 1048576)
    let schema_id : String = Binary::read(r)
    guard schema_id == db.schema_id else {
      fail("SQLite layout schema mismatch")
    }
    let format : String = Binary::read(r)
    let page_size : Int32 = Binary::read(r)
    let template : Bytes = Binary::read(r)
    let trees : Array[StorageTree] = Binary::read(r)
    r.finish()
    let plan : StoragePlan = {
      format,
      page_size,
      image: @base64.encode(template),
      trees,
    }
    {
      data: sqlite_export(
        connection.database.store,
        connection.database.serial,
        plan,
      ),
      info: "{}",
    }
  } catch {
    e => { data: b"", info: ({ "error": public_error(e) } : Json).stringify(), }
  }
}
