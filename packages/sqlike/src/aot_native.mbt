///|
/// Experimental eager SELECT handle. Owns one Statement, never a result batch.
/// Fixed-schema metadata comes from Program; the action reads the live Store.
struct AotPreparedValues {
  mut statement : Statement?
  mut error : String?
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
    Ok(
      if statement.step() {
        statement.rows.map(row => row.filter(b => !b.hidden).map(b => b.value))
      } else {
        []
      },
    )
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
