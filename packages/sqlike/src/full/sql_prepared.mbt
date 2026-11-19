///|
/// Opaque SQL handle owned by one Database. Only immutable data-statement ASTs
/// and schema-derived metadata are retained; bindings/rows/results are per call.
struct SqlPrepared {
  database : Database
  sql : String
  statement : ParsedStatement?
  parameters : Int32
  error : String?
  mut epoch : Int64
  mut selection : PreparedSelection?
  mut update : PreparedUpdatePlan?
}

///|
/// Parse once; semantic metadata is prepared after validating execution bindings.
/// DDL/transaction/PRAGMA retain the uncached parser/executor, including mutable
/// CREATE TABLE definitions and state-dependent PRAGMA behavior.
pub fn database_prepare(db : Database, sql : String) -> SqlPrepared {
  let (statement, parameters, error) = try {
    let parser = lex(sql)
    let statement = parse_statement(parser)
    let statement = match statement {
      Select(_) | Insert(_) | Update(_, _, _, _) | Delete(_, _, _) =>
        Some(statement)
      _ => None
    }
    (statement, parser.parameter, None)
  } catch {
    error => (None, 0, Some(public_error(error)))
  }
  {
    database: db,
    sql,
    statement,
    parameters,
    error,
    epoch: -1L,
    selection: None,
    update: None,
  }
}

///|
fn prepare_sql_metadata(query : SqlPrepared) -> Unit raise SqlError {
  let db = query.database
  guard query.statement is Some(statement) else { fail("invalid SQL plan") }
  if query.epoch != db.schema_epoch {
    let selection = match statement {
      Select(select) =>
        Some(prepare_selection(db.store, select, query.parameters))
      _ => None
    }
    let update = match statement {
      Update(name, setters, predicate, returning) => {
        let (plan, _) = prepare_update(
          db.store,
          name,
          setters,
          predicate,
          returning,
          query.parameters,
        )
        Some(plan)
      }
      _ => None
    }
    query.selection = selection
    query.update = update
    query.epoch = db.schema_epoch
  }
}

///|
fn prepared_sql_rows(
  query : SqlPrepared,
  params : Array[Value],
) -> Array[Environment] raise SqlError {
  let db = query.database
  guard query.statement is Some(statement) else { fail("invalid SQL plan") }
  prepare_sql_metadata(query)
  let data = match statement {
    Select(select) => PreparedSelect(select)
    Insert(insert) => PreparedInsert(insert)
    Update(name, setters, predicate, returning) =>
      PreparedUpdate(name, setters, predicate, returning)
    Delete(name, predicate, returning) =>
      PreparedDelete(name, predicate, returning)
    _ => fail("invalid SQL plan")
  }
  execute_data_statement(
    db.store,
    data,
    params,
    prepared_selection=query.selection,
    prepared_update=query.update,
  )
}

///|
/// Execute against the handle's owning connection and its current schema/state.
pub fn database_prepared_exec(
  query : SqlPrepared,
  bindings : String,
  read_only : Bool,
  positional : Bool,
) -> String {
  if query.error is Some(message) {
    return ({ "error": message } : Json).stringify()
  }
  database_exec_inner(
    query.database,
    query.sql,
    bindings,
    read_only,
    positional,
    prepared=if query.statement is Some(_) { Some(query) } else { None },
  )
}
