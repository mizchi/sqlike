///|
/// A frozen row-page root; chunk encoding never builds a database-sized JSON tree.
struct AotSnapshot {
  store : Store?
  header : String
  seal : String
  parts : Int32
  incremental : Bool
  identity : String
  error : String?
}

///|
#derive(ToJson, FromJson)
priv struct AotSnapshotHeader {
  format : String
  programId : String
  serial : Int32
  parts : Int32
  rows : Array[Int32]
  blocks : Array[Int32]
  state : Store
}

///|
struct AotSnapshotReader {
  db : AotDatabase
  before : Store?
  base : Int32
  header : AotSnapshotHeader?
  seal : String
  mut next : Int32
  mut error : String?
  mut finished : Bool
}

///|
pub fn aot_snapshot_open(db : AotDatabase) -> AotSnapshot {
  snapshot_open(db, false)
}

///|
pub fn aot_snapshot_incremental(db : AotDatabase) -> AotSnapshot {
  snapshot_open(db, true)
}

///|
fn snapshot_open(db : AotDatabase, incremental : Bool) -> AotSnapshot {
  try {
    let (connection, program) = db.ready()
    let database = connection.database
    guard database_autocommit(database) && !database.store.deferred else {
      fail("cannot snapshot an active transaction")
    }
    let store = copy_store(database.store)
    guard !incremental ||
      schema_identity(store) == schema_identity(program.schema) else {
      fail("incremental snapshot schema mismatch")
    }
    // A retained checkpoint baseline needs row roots, not statement history or
    // execution caches (a large DELETE must not keep its removed rows alive).
    store.dirty = dirty_state()
    store.primary_indexes.clear()
    store.declaration_sources.clear()
    store.generated_plans.clear()
    let state = copy_store(store)
    let rows = store.tables.map(t => t.rows.length())
    let blocks = store.tables.map(t => t.rows.pages.length())
    let mut parts = 0
    for count in blocks {
      parts += count
    }
    for table in state.tables {
      table.rows = row_pages([])
    }
    let header : AotSnapshotHeader = {
      format: if incremental {
        "moon-aot-chunks@2"
      } else {
        "moon-aot-chunks@1"
      },
      programId: program.id,
      serial: database.serial,
      parts,
      rows,
      blocks,
      state,
    }
    let text = @json.to_json(header).stringify()
    guard @utf8.encode(text).length() <= 1048576 &&
      parts <= 100000 &&
      rows.all(count => count <= 100000) else {
      fail("logical snapshot resource limit")
    }
    {
      store: Some(store),
      header: text,
      seal: binary_hex(
        Bytes::from_array(@crypto.sha256(@utf8.encode(text))[:])[:],
      ),
      parts,
      incremental,
      identity: if incremental {
        program.id
      } else {
        ""
      },
      error: None,
    }
  } catch {
    e =>
      {
        store: None,
        header: "",
        seal: "",
        parts: 0,
        incremental,
        identity: "",
        error: Some(public_error(e)),
      }
  }
}

///|
pub fn aot_snapshot_info(snapshot : AotSnapshot) -> String {
  match snapshot.error {
    Some(error) => ({ "error": error } : Json).stringify()
    None => snapshot.header
  }
}

///|
fn snapshot_location(
  blocks : Array[Int32],
  index : Int32,
) -> (Int32, Int32) raise SqlError {
  guard index >= 0 else { fail("invalid logical chunk index") }
  let mut remaining = index
  for i, count in blocks {
    if remaining < count {
      return (i, remaining)
    }
    remaining -= count
  }
  fail("invalid logical chunk index")
}

///|
pub fn aot_snapshot_chunk(
  snapshot : AotSnapshot,
  index : Int32,
) -> SqliteResult {
  try {
    guard snapshot.store is Some(store) && index < snapshot.parts else {
      fail(snapshot.error.unwrap_or("invalid logical chunk index"))
    }
    let (table_index, block) = snapshot_location(
      store.tables.map(t => t.rows.pages.length()),
      index,
    )
    let table = store.tables[table_index]
    let rows : Array[StoredRow] = []
    for row in table.rows.pages[block].rows {
      if row is Some(row) {
        rows.push(persistent_generated_row(table, row))
      }
    }
    let w = binary_writer()
    if snapshot.incremental {
      Binary::write(snapshot.identity, w)
      Binary::write(table_index, w)
      Binary::write(block, w)
    } else {
      Binary::write(snapshot.seal, w)
      Binary::write(index, w)
    }
    Binary::write(rows, w)
    {
      data: binary_finish(w, if snapshot.incremental { 8 } else { 6 }),
      info: "{}",
    }
  } catch {
    e => { data: b"", info: ({ "error": public_error(e) } : Json).stringify(), }
  }
}

///|
pub fn aot_snapshot_restore(
  db : AotDatabase,
  text : String,
) -> AotSnapshotReader {
  try {
    let (connection, program) = db.ready()
    guard database_autocommit(connection.database) && text.length() <= 1048576 else {
      fail("invalid logical snapshot header/transaction")
    }
    let h : AotSnapshotHeader = @json.from_json(@json.parse(text))
    guard (h.format == "moon-aot-chunks@1" || h.format == "moon-aot-chunks@2") &&
      h.programId == program.id &&
      h.serial >= 0 &&
      h.rows.length() == h.state.tables.length() &&
      h.blocks.length() == h.rows.length() &&
      h.parts >= 0 &&
      h.parts <= 100000 &&
      schema_identity(h.state) == schema_identity(program.schema) &&
      !h.state.deferred else {
      fail("logical snapshot identity/metadata mismatch")
    }
    let mut parts = 0
    for i, table in h.state.tables {
      guard table.rows.is_empty() &&
        h.rows[i] >= 0 &&
        h.rows[i] <= 100000 &&
        h.blocks[i] >= 0 &&
        h.blocks[i] <= 100000 &&
        h.rows[i] <= h.blocks[i] * 64 else {
        fail("invalid logical snapshot row counts")
      }
      parts += h.blocks[i]
    }
    guard parts == h.parts else {
      fail("logical snapshot chunk count mismatch")
    }
    {
      db,
      before: Some(connection.database.store),
      base: connection.database.serial,
      header: Some(h),
      seal: if h.format == "moon-aot-chunks@2" {
        h.programId
      } else {
        binary_hex(Bytes::from_array(@crypto.sha256(@utf8.encode(text))[:])[:])
      },
      next: 0,
      error: None,
      finished: false,
    }
  } catch {
    e =>
      {
        db,
        before: None,
        base: 0,
        header: None,
        seal: "",
        next: 0,
        error: Some(public_error(e)),
        finished: false,
      }
  }
}

///|
pub fn aot_snapshot_supply(reader : AotSnapshotReader, bytes : Bytes) -> String {
  try {
    guard reader.error is None && !reader.finished && reader.header is Some(h) else {
      fail(reader.error.unwrap_or("logical snapshot reader is closed"))
    }
    let (table, block) = snapshot_location(h.blocks, reader.next)
    let incremental = h.format == "moon-aot-chunks@2"
    let r = binary_reader(bytes, if incremental { 8 } else { 6 }, 67108864)
    let seal : String = Binary::read(r)
    let index : Int32 = Binary::read(r)
    let location_ok = if incremental {
      let encoded_block : Int32 = Binary::read(r)
      index == table && encoded_block == block
    } else {
      index == reader.next
    }
    let rows : Array[StoredRow] = Binary::read(r)
    r.finish()
    guard seal == reader.seal &&
      location_ok &&
      rows.length() <= 64 &&
      h.state.tables[table].rows.length() + rows.length() <= h.rows[table] else {
      fail("logical snapshot chunk identity/order mismatch")
    }
    for row in rows {
      h.state.tables[table].rows.push(row)
    }
    reader.next += 1
    "{}"
  } catch {
    e => {
      let message = public_error(e)
      reader.error = Some(message)
      ({ "error": message } : Json).stringify()
    }
  }
}

///|
pub fn aot_snapshot_finish(reader : AotSnapshotReader) -> String {
  try {
    guard reader.error is None &&
      !reader.finished &&
      reader.header is Some(h) &&
      reader.before is Some(before) else {
      fail(reader.error.unwrap_or("logical snapshot reader is closed"))
    }
    let (connection, _) = reader.db.ready()
    guard database_autocommit(connection.database) &&
      connection.database.serial == reader.base &&
      physical_equal(connection.database.store, before) &&
      reader.next == h.parts else {
      fail("logical snapshot incomplete or connection changed")
    }
    for i, table in h.state.tables {
      guard table.rows.length() == h.rows[i] else {
        fail("logical snapshot missing rows")
      }
    }
    validate_store_rows(h.state, storage=true)
    publish_flush(connection.database, h.state, h.serial)
    reader.finished = true
    "{}"
  } catch {
    e => {
      let message = public_error(e)
      reader.error = Some(message)
      ({ "error": message } : Json).stringify()
    }
  }
}

///|
pub fn aot_snapshot_supply_base64(
  reader : AotSnapshotReader,
  bytes : String,
) -> String {
  aot_snapshot_supply(reader, @base64.decode(bytes)) catch {
    e => {
      let message = public_error(e)
      reader.error = Some(message)
      ({ "error": message } : Json).stringify()
    }
  }
}

///|
/// Reuse only page roots frozen by the same program/schema. Returns the old
/// global index, since growth in an earlier table can move later indices.
pub fn aot_snapshot_reuse(
  current : AotSnapshot,
  before : AotSnapshot,
  index : Int32,
) -> Int32 {
  try {
    guard current.incremental &&
      before.incremental &&
      current.identity == before.identity &&
      current.store is Some(store) &&
      before.store is Some(old) else {
      return -1
    }
    let (table, block) = snapshot_location(
      store.tables.map(t => t.rows.pages.length()),
      index,
    )
    guard table < old.tables.length() &&
      block < old.tables[table].rows.pages.length() &&
      physical_equal(
        store.tables[table].rows.pages[block],
        old.tables[table].rows.pages[block],
      ) else {
      return -1
    }
    let mut previous = block
    for i in 0..<table {
      previous += old.tables[i].rows.pages.length()
    }
    previous
  } catch {
    _ => -1
  }
}
