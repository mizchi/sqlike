///|
struct BinaryCatalog {
  schema : Bytes
  statements : Bytes
  storage : Bytes
  error : String
}

///|
struct BinaryResult {
  data : Bytes
  error : String
  full : Bool
  serial : Int32
}

///|
struct DefinedDatabase {
  core : AotDatabase
  schema_id : String
}

///|
// Build-only bridge. New runtime entry points never reference this JSON reader.
pub fn pack_program_binary(artifact : String) -> BinaryCatalog {
  try {
    guard artifact.length() <= 1048576 else {
      fail("compiled program resource limit")
    }
    let compiled : CompiledProgram = @json.from_json(@json.parse(artifact))
    ignore(prepare_compiled_program(compiled, ""))
    // The legacy compiler omits declaration spelling when no metadata query
    // needs it. Recover it at build time so schema identity depends on DDL,
    // independently of which prepared statements the application includes.
    for table in compiled.schema.tables {
      guard parse_statement(lex(table.sql)) is CreateTable(definition, _) &&
        definition.columns.length() == table.columns.length() else {
        fail("binary schema declaration mismatch")
      }
      for i, column in table.columns {
        guard column.name == definition.columns[i].name else {
          fail("binary schema column mismatch")
        }
        column.default_source = definition.columns[i].default_source
      }
    }
    let schema_writer = binary_writer()
    Binary::write(compiled.schema, schema_writer)
    let initial_rows = compiled.schema.tables.any(t => !t.rows.is_empty())
    if initial_rows {
      Binary::write(
        compiled.schema.tables.map(t => {
          t.rows.map(row => persistent_generated_row(t, row))
        }),
        schema_writer,
      )
    }
    // Kind 1 stays byte-compatible for empty definitions. Older readers reject
    // kind 7 rather than silently opening a populated catalog as an empty DB.
    let schema = binary_finish(schema_writer, if initial_rows { 7 } else { 1 })
    let schema_id = binary_id(schema)
    let query_writer = binary_writer()
    Binary::write(schema_id, query_writer)
    Binary::write(compiled.queries, query_writer)
    let statements = binary_finish(query_writer, 2)
    let storage = match compiled.storage {
      None => b""
      Some(plan) => {
        let w = binary_writer()
        Binary::write(schema_id, w)
        Binary::write(plan.format, w)
        Binary::write(plan.page_size, w)
        Binary::write(@base64.decode(plan.image), w)
        Binary::write(plan.trees, w)
        binary_finish(w, 3)
      }
    }
    { schema, statements, storage, error: "", }
  } catch {
    e => { schema: b"", statements: b"", storage: b"", error: public_error(e), }
  }
}

///|
pub fn binary_catalog_schema(catalog : BinaryCatalog) -> Bytes {
  catalog.schema
}

///|
pub fn binary_catalog_statements(catalog : BinaryCatalog) -> Bytes {
  catalog.statements
}

///|
pub fn binary_catalog_storage(catalog : BinaryCatalog) -> Bytes {
  catalog.storage
}

///|
pub fn binary_catalog_info(catalog : BinaryCatalog) -> String {
  if catalog.error != "" {
    return ({ "error": catalog.error } : Json).stringify()
  }
  (
    {
      "format": "sqlike-defined@1",
      "schemaId": binary_id(catalog.schema),
      "programId": binary_id(catalog.statements),
    } : Json).stringify()
}

///|
fn binary_program(
  schema : Bytes,
  statements : Bytes,
) -> (Program, String) raise SqlError {
  let kind = if schema.length() > 5 && schema[5] == b'\x07' { 7 } else { 1 }
  let schema_reader = binary_reader(schema, kind, 1048576)
  let store : Store = Binary::read(schema_reader)
  if kind == 7 {
    let rows : Array[Array[StoredRow]] = Binary::read(schema_reader)
    guard rows.length() == store.tables.length() &&
      rows.any(rs => !rs.is_empty()) else {
      fail("invalid initial catalog rows")
    }
    for i, table in store.tables {
      table.rows = row_pages(rows[i])
    }
  }
  schema_reader.finish()
  let schema_id = binary_id(schema)
  let query_reader = binary_reader(statements, 2, 1048576)
  let required_schema : String = Binary::read(query_reader)
  guard required_schema == schema_id else {
    fail("prepared statement schema mismatch")
  }
  let queries : Array[CompiledQuery] = Binary::read(query_reader)
  query_reader.finish()
  for table in store.tables {
    let ctx = evaluation(
      store,
      [],
      row_environment(
        table,
        { id: 0L, values: Array::make(table.columns.length(), Null), },
        table.name,
      ),
    )
    validate_generated_table(store, table)
    for column in table.columns {
      if FEATURE_GENERATED_COLUMNS && generated_column(column) {
        continue
      }
      prepare_default(store, column)
    }
    for check in table.checks {
      prepare_expression(check, ctx, false, false)
    }
    prepare_foreign_table(store, table)
  }
  for object in store.objects {
    if object.kind == "trigger" {
      prepare_trigger(store, get_table(store, object.table), object)
    }
  }
  let program = prepare_compiled_program(
    { format: "moon-aot@1", schema: store, queries, storage: None, },
    binary_id(statements),
  )
  (program, schema_id)
}

///|
/// Load fixed schema and named prepared queries without parsing SQL or JSON.
pub fn Program::load_binary(
  schema : Bytes,
  statements : Bytes,
) -> Program raise SqliteError {
  binary_program(schema, statements).0 catch {
    error => raise interface_error(public_error(error))
  }
}

///|
pub fn defined_open(
  schema : Bytes,
  statements : Bytes,
  image : Bytes,
) -> DefinedDatabase {
  try {
    let (program, schema_id) = binary_program(schema, statements)
    let core : AotDatabase = {
      connection: Some(Connection::from_program(program)),
      program: Some(program),
      error: None,
    }
    let db = { core, schema_id, }
    if !image.is_empty() {
      defined_restore_checked(db, image)
    }
    db
  } catch {
    e =>
      {
        core: { connection: None, program: None, error: Some(public_error(e)), },
        schema_id: "",
      }
  }
}

///|
pub fn defined_info(db : DefinedDatabase) -> String {
  try {
    let (connection, program) = db.core.ready()
    (
      {
        "schemaId": db.schema_id,
        "programId": program.id,
        "serial": connection.database.serial,
        "schemaVersion": connection.database.store.cookie,
        "queryCount": program.queries.length(),
        "autocommit": database_autocommit(connection.database),
      } : Json).stringify()
  } catch {
    e => ({ "error": public_error(e) } : Json).stringify()
  }
}

///|
pub fn defined_execute(
  db : DefinedDatabase,
  name : String,
  bindings : String,
) -> String {
  aot_execute(db.core, name, bindings)
}

///|
pub fn defined_query_info(db : DefinedDatabase, name : String) -> String {
  aot_query_info(db.core, name)
}

///|
pub fn defined_set_clock(db : DefinedDatabase, millis : String) -> String {
  aot_set_clock(db.core, millis)
}

///|
pub fn defined_clone(db : DefinedDatabase) -> DefinedDatabase {
  { core: aot_clone(db.core), schema_id: db.schema_id, }
}

///|
pub fn defined_copy_connection_state(
  target : DefinedDatabase,
  source : DefinedDatabase,
) -> String {
  aot_copy_connection_state(target.core, source.core)
}

///|
pub fn defined_ack_delta(db : DefinedDatabase, serial : Int32) -> String {
  aot_ack_delta(db.core, serial)
}

///|
pub fn binary_data(result : BinaryResult) -> Bytes {
  result.data
}

///|
pub fn binary_info(result : BinaryResult) -> String {
  if result.error != "" {
    ({ "error": result.error } : Json).stringify()
  } else {
    (
      {
        "full": result.full,
        "serial": result.serial,
        "bytes": result.data.length(),
      } : Json).stringify()
  }
}
