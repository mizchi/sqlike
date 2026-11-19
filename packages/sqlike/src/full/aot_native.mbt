///|
/// Experimental eager SELECT handle. Owns one Statement, never a result batch.
/// Fixed-schema metadata comes from Program; the action reads the live Store.
struct AotPreparedValues {
  mut statement : Statement?
  mut error : String?
}

///|
pub struct AotNativeResult {
  names : Array[String]
  rows : Array[Array[Value]]
  read_only : Bool
  changes : Int32
}

///|
pub fn aot_native_values(
  query : AotPreparedValues,
  bindings : Array[Value],
) -> Result[Array[Array[Value]], String] {
  try {
    if query.error is Some(message) {
      fail(message)
    }
    guard query.statement is Some(statement) else { fail("invalid AOT query") }
    statement.reset(clear_bindings=true)
    defer (statement.reset(clear_bindings=true) catch { _ => () })
    native_bind_statement(statement, bindings)
    Ok(native_statement_rows(statement))
  } catch {
    error => Err(public_error_json(error).stringify())
  }
}

///|
pub fn aot_native_execute(
  db : AotDatabase,
  name : String,
  bindings : Array[Value],
) -> Result[AotNativeResult, String] {
  try {
    let (connection, program) = db.ready()
    let query = program.query(name)
    let statement = connection.prepare_compiled(query)
    defer (statement.finalize() catch { _ => () })
    native_bind_statement(statement, bindings)
    let rows = native_statement_rows(statement)
    Ok({
      names: query.plan.names,
      rows,
      read_only: data_readonly(query.plan.statement),
      changes: connection_changes(connection.database.store),
    })
  } catch {
    error => Err(public_error_json(error).stringify())
  }
}

///|
fn native_bind_statement(
  statement : Statement,
  values : Array[Value],
) -> Unit raise SqliteError {
  guard values.length() == statement.parameters.length() else {
    raise sqlite_misuse("SQL binding count mismatch")
  }
  for i, value in values {
    statement.bind(index=i + 1, value)
  }
}

///|
fn native_statement_rows(
  statement : Statement,
) -> Array[Array[Value]] raise SqliteError {
  if statement.step() {
    statement.rows.map(row => row.filter(b => !b.hidden).map(b => b.value))
  } else {
    []
  }
}

///|
pub fn aot_prepare_values(db : AotDatabase, name : String) -> AotPreparedValues {
  try {
    let (connection, program) = db.ready()
    let query = program.query(name)
    guard query.plan.statement is PreparedSelect(_) else {
      fail("typed AOT results accept SELECT only")
    }
    { statement: Some(connection.prepare_compiled(query)), error: None, }
  } catch {
    error => { statement: None, error: Some(public_error(error)), }
  }
}

///|
pub fn aot_prepared_values(
  query : AotPreparedValues,
  bindings : String,
) -> Result[Array[Array[Value]], String] {
  try {
    if query.error is Some(message) {
      fail(message)
    }
    guard query.statement is Some(statement) else { fail("invalid AOT query") }
    statement.reset(clear_bindings=true)
    // Release row environments and bindings on success and every error path.
    // reset clears the prior step error before reporting it; retain the original.
    defer (statement.reset(clear_bindings=true) catch { _ => () })
    let values : Array[Json] = @json.from_json(@json.parse(bindings))
    guard values.length() == statement.parameters.length() else {
      raise sqlite_misuse("SQL binding count mismatch")
    }
    for i, value in values {
      statement.parameters[i] = json_value(value)
    }
    // step materializes the entire SELECT. Copy visible values once without
    // stepping each row again or exposing row environments to the native ABI.
    Ok(native_statement_rows(statement))
  } catch {
    error => Err(public_error(error))
  }
}

///|
pub fn aot_finalize_values(query : AotPreparedValues) -> String {
  try {
    if query.statement is Some(statement) {
      statement.finalize()
    }
    query.statement = None
    query.error = Some("statement is finalized")
    "{}"
  } catch {
    error => public_error_json(error).stringify()
  }
}

///|
/// Portable JSON boundary for the same reusable SELECT handle used by native JS.
/// No JS FFI or SQL parser is reachable from this API.
pub fn aot_prepared_execute(
  query : AotPreparedValues,
  bindings : String,
) -> String {
  match aot_prepared_values(query, bindings) {
    Err(message) => ({ "error": message } : Json).stringify()
    Ok(rows) => {
      guard query.statement is Some(statement) else {
        return ({ "error": "invalid AOT query" } : Json).stringify()
      }
      let output = StringBuilder()
      output.write_string("{\"names\":")
      output.write_string(@json.to_json(statement.names).stringify())
      output.write_string(",\"rows\":[")
      for i, row in rows {
        if i > 0 {
          output.write_char(',')
        }
        output.write_char('[')
        for j, value in row {
          if j > 0 {
            output.write_char(',')
          }
          write_result_cell(output, value)
        }
        output.write_char(']')
      }
      output.write_string("],\"readonly\":true,\"changes\":")
      output.write_string(
        connection_changes(statement.connection.database.store).to_string(),
      )
      output.write_char('}')
      output.to_string()
    }
  }
}
