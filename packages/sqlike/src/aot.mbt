///|
struct AotDatabase {
  connection : Connection?
  program : Program?
  error : String?
}

///|
fn AotDatabase::ready(
  db : AotDatabase,
) -> (Connection, Program) raise SqliteError {
  guard db.connection is Some(connection) && db.program is Some(program) else {
    raise sqlite_misuse(db.error.unwrap_or("invalid AOT connection"))
  }
  connection.healthy()
  (connection, program)
}

///|
fn public_error(error : Error) -> String {
  match error {
    SqliteError(msg=message, ..) => message
    SqlError(message) => message
    TriggerIgnore => "RAISE(IGNORE) escaped its trigger frame"
    TriggerAbort(message) => message
    _ => error.to_string()
  }
}

///|
pub fn aot_open(artifact : String, image : String) -> AotDatabase {
  try {
    let program = Program::load(artifact)
    let connection = Connection::from_program(program)
    let result : AotDatabase = {
      connection: Some(connection),
      program: Some(program),
      error: None,
    }
    if image != "" {
      aot_restore_checked(result, image)
    }
    result
  } catch {
    error =>
      { connection: None, program: None, error: Some(public_error(error)), }
  }
}

///|
pub fn aot_info(db : AotDatabase) -> String {
  try {
    let (connection, program) = db.ready()
    (
      {
        "programId": program.id,
        "schemaVersion": connection.database.store.cookie,
        "serial": connection.database.serial,
        "queryCount": program.queries.length(),
        "autocommit": connection.database.store.transactions.frames.is_empty(),
      } : Json).stringify()
  } catch {
    error => public_error_json(error).stringify()
  }
}

///|
fn public_error_json(error : Error) -> Json {
  let json : Json = { "error": public_error(error) }
  if (
      error is TriggerAbort(_) ||
      error
      is SqliteError(code=Constraint, extended=Some(ConstraintTrigger), ..)
    ) &&
    json is Object(fields) {
    fields["code"] = "SQLITE_CONSTRAINT_TRIGGER"
  }
  if public_error(error).contains("datatype constraint") &&
    json is Object(fields) {
    fields["code"] = "SQLITE_CONSTRAINT_DATATYPE"
  }
  json
}

///|
pub fn aot_execute(
  db : AotDatabase,
  name : String,
  bindings : String,
) -> String {
  try {
    let (connection, program) = db.ready()
    let query = program.query(name)
    let values : Array[Json] = @json.from_json(@json.parse(bindings))
    guard values.length() == query.plan.parameters else {
      raise sqlite_misuse("SQL binding count mismatch")
    }
    let statement = connection.prepare_compiled(query)
    defer (statement.finalize() catch { _ => () })
    // JSON owns these freshly decoded values; unlike the public typed binding
    // API, there is no caller-owned BLOB to copy or binding index to validate.
    for i, value in values {
      statement.parameters[i] = json_value(value)
    }
    let rows : Array[Json] = []
    while statement.step() {
      let row : Array[Json] = []
      // Serialize each visible binding once. Reading through column() would
      // recheck state, filter the entire row and copy BLOBs for every cell.
      for binding in statement.rows[statement.cursor] {
        if !binding.hidden {
          row.push(value_json(binding.value))
        }
      }
      rows.push(Json::array(row))
    }
    (
      {
        "names": query.plan.names,
        "rows": rows,
        "readonly": data_readonly(query.plan.statement),
        "changes": connection_changes(connection.database.store),
      } : Json).stringify()
  } catch {
    error => public_error_json(error).stringify()
  }
}

///|
pub fn aot_dump(db : AotDatabase) -> String {
  try {
    let (connection, program) = db.ready()
    (
      {
        "format": "moon-aot-image@1",
        "programId": program.id,
        "serial": connection.database.serial,
        "state": @json.to_json(connection.database.store),
      } : Json).stringify()
  } catch {
    error => ({ "error": public_error(error) } : Json).stringify()
  }
}

///|
fn aot_restore_checked(db : AotDatabase, image : String) -> Unit raise {
  let (connection, program) = db.ready()
  guard image.length() <= 67108864 else { fail("AOT image resource limit") }
  guard @json.parse(image)
    is {
      "format": "moon-aot-image@1",
      "programId": String(id),
      "serial": Number(serial, ..),
      "state": state,
      ..
    } &&
    id == program.id &&
    serial >= 0.0 &&
    serial <= 2147483647.0 &&
    serial.to_int().to_double() == serial else {
    fail("invalid AOT image/program identity")
  }
  let candidate : Store = @json.from_json(state)
  guard schema_identity(candidate) == schema_identity(program.schema) else {
    fail("AOT image schema mismatch")
  }
  validate_store_rows(candidate)
  connection.database.store = candidate
  connection.database.serial = serial.to_int()
}

///|
pub fn aot_restore(db : AotDatabase, image : String) -> String {
  try {
    aot_restore_checked(db, image)
    "{}"
  } catch {
    error => ({ "error": public_error(error) } : Json).stringify()
  }
}

///|
pub fn aot_query_info(db : AotDatabase, name : String) -> String {
  try {
    let (_, program) = db.ready()
    let query = program.query(name).plan
    (
      {
        "parameters": query.parameters,
        "names": query.names,
        "readonly": data_readonly(query.statement),
      } : Json).stringify()
  } catch {
    error => ({ "error": public_error(error) } : Json).stringify()
  }
}

///|
pub fn aot_clone(db : AotDatabase) -> AotDatabase {
  try {
    let (connection, program) = db.ready()
    {
      connection: Some({
        database: database_clone(connection.database),
        program: Some(program),
        closed: false,
        statements: 0,
      }),
      program: Some(program),
      error: None,
    }
  } catch {
    error =>
      { connection: None, program: None, error: Some(public_error(error)), }
  }
}

///|
pub fn aot_delta(db : AotDatabase, force_snapshot : Bool) -> String {
  try {
    let (connection, program) = db.ready()
    (
      {
        "format": "aot-flush@1",
        "programId": program.id,
        "data": @json.parse(database_delta(connection.database, force_snapshot)),
      } : Json).stringify()
  } catch {
    error => ({ "error": public_error(error) } : Json).stringify()
  }
}

///|
pub fn aot_ack_delta(db : AotDatabase, serial : Int32) -> String {
  try {
    let (connection, _) = db.ready()
    database_ack_delta(connection.database, serial)
  } catch {
    error => ({ "error": public_error(error) } : Json).stringify()
  }
}

///|
pub fn aot_apply_delta(db : AotDatabase, text : String) -> String {
  try {
    let (connection, program) = db.ready()
    guard @json.parse(text)
      is { "format": "aot-flush@1", "programId": String(id), "data": data, .. } &&
      id == program.id else {
      fail("flush program mismatch")
    }
    let (store, serial, full) = decode_flush(
      connection.database,
      data.stringify(),
    )
    guard schema_identity(store) == schema_identity(program.schema) else {
      fail("flush schema mismatch")
    }
    if full {
      validate_store_rows(store)
    }
    publish_flush(connection.database, store, serial)
    "{}"
  } catch {
    error => ({ "error": public_error(error) } : Json).stringify()
  }
}

///|
pub fn aot_set_clock(db : AotDatabase, milliseconds : String) -> String {
  try {
    let (connection, _) = db.ready()
    database_set_clock(connection.database, milliseconds)
  } catch {
    e => public_error_json(e).stringify()
  }
}

///|
pub fn aot_copy_connection_state(
  target : AotDatabase,
  source : AotDatabase,
) -> String {
  try {
    let (to, to_program) = target.ready()
    let (from, from_program) = source.ready()
    guard to_program.id == from_program.id else {
      fail("connection program mismatch")
    }
    database_copy_connection_state(to.database, from.database)
    "{}"
  } catch {
    e => ({ "error": public_error(e) } : Json).stringify()
  }
}
