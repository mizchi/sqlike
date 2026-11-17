///|
#derive(ToJson, FromJson)
priv struct CompiledQuery {
  name : String
  parameters : Int32
  names : Array[String]
  statement : DataStatement
}

///|
#derive(ToJson, FromJson)
priv struct CompiledProgram {
  format : String
  schema : Store
  queries : Array[CompiledQuery]
  storage : StoragePlan?
}

///|
struct Program {
  schema : Store
  queries : Map[String, CompiledQuery]
  selections : Map[String, PreparedSelection]
  updates : Map[String, PreparedUpdatePlan]
  id : String
  storage : StoragePlan?
}

///|
struct Query {
  program_id : String
  plan : CompiledQuery
  selection : PreparedSelection?
  update : PreparedUpdatePlan?
}

///|
/// Derived from the validated fixed schema, never serialized into moon-aot@1.
/// No Store, Table, row, parameter, clock or connection state is retained.
priv struct PreparedSelection {
  output : Environment
  simple : PreparedProjection?
  point : PreparedPoint?
}

///|
priv struct PreparedProjection {
  layout : Environment
  columns : Array[RowProjection]
}

///|
/// Runtime-only metadata from the validated fixed schema. Like PreparedSelection,
/// this contains no Store/Table, live row, bindings or connection state.
priv struct PreparedUpdatePlan {
  table_slot : Int32
  layout : Environment
  columns : Array[String]
  setters : Array[PreparedSetter]
  integer_primary : Int32
  predicate : BoundExpression
  access : BoundAccess
  returning : BoundProjection
}

///|
priv struct PreparedSetter {
  column : Int32
  affinity : String
  expression : BoundExpression
}

///|
fn prepare_update(
  store : Store,
  name : String,
  setters : Array[(String, Expr)],
  predicate : Expr,
  returning : Array[Projection],
  parameters : Int32,
  layouts~ : Map[String, Environment] = Map([]),
) -> (PreparedUpdatePlan, Array[String]) raise SqlError {
  guard CAP_STATEMENT_UPDATE else {
    fail("catalog capability disabled: update")
  }
  let table = get_table(store, name)
  prepare_foreign_table(store, table)
  let layout = match layouts.get(table.name) {
    Some(layout) => layout
    None => {
      let layout = row_environment(
        table,
        { id: 0L, values: Array::make(table.columns.length(), Null), },
        table.name,
      )
      layouts[table.name] = layout
      layout
    }
  }
  let context = evaluation(store, Array::make(parameters, Null), layout)
  let resolved = validate_update(table, setters, predicate, returning, context).map(pair => {
      let (column, expression) = pair
      {
        column,
        affinity: column_affinity(table, table.columns[column]),
        expression: bind_expression(expression, context),
      }
    },
  )
  let returning = bind_projection(returning, context)
  (
    {
      table_slot: prepared_table_slot(store, table),
      layout,
      columns: setters.map(p => p.0),
      setters: resolved,
      integer_primary: integer_primary(table),
      predicate: bind_expression(predicate, context),
      access: bind_access(table, predicate, layout),
      returning,
    },
    returning.output.map(b => b.name),
  )
}

///|
/// Semantic validation also serves trigger bodies with live OLD/NEW scopes.
/// Executable slot binding is a separate step for fixed-schema top-level plans.
fn validate_update(
  table : Table,
  setters : Array[(String, Expr)],
  predicate : Expr,
  returning : Array[Projection],
  context : Evaluation,
) -> Array[(Int32, Expr)] raise SqlError {
  prepare_expression(predicate, context, false, false)
  let resolved = setters.map(pair => {
    let (name, expression) = pair
    let column = column_index(table, name)
    prepare_expression(expression, context, false, false)
    (column, expression)
  })
  prepare_returning(returning, context)
  resolved
}

///|
fn prepare_selection(
  store : Store,
  select : Selection,
  parameters : Int32,
) -> PreparedSelection raise SqlError {
  let output = selection_template(
    select,
    evaluation(store, Array::make(parameters, Null), []),
  )
  let mut simple : PreparedProjection? = None
  let mut point : PreparedPoint? = None
  if select.sources.length() == 1 {
    let source = select.sources[0]
    let key = identifier(source.name)
    for slot, table in store.tables {
      if matches_identifier(table.name, key) &&
        simple_projection(select, table, source.qualifier) is Some(columns) &&
        columns.length() == output.length() {
        let projection : PreparedProjection = {
          layout: row_environment(
            table,
            { id: 0L, values: Array::make(table.columns.length(), Null), },
            source.qualifier,
          ),
          columns,
        }
        simple = Some(projection)
        point = prepare_point(
          store, select, table, slot, projection, output, parameters,
        )
        break
      }
    }
  }
  { output, simple, point, }
}

///|
fn prepared_table_slot(store : Store, table : Table) -> Int32 raise SqlError {
  for i, candidate in store.tables {
    if candidate.name == table.name {
      return i
    }
  }
  fail("invalid prepared table")
}

///|
fn data_readonly(statement : DataStatement) -> Bool {
  match statement {
    PreparedSelect(_) | PreparedPragma(_, _) => true
    _ => false
  }
}

///|
fn prepared_names(
  store : Store,
  statement : DataStatement,
  count : Int32,
) -> Array[String] raise SqlError {
  let params = Array::make(count, Value::Null)
  match statement {
    PreparedTransaction(_, _) => {
      guard CAP_STATEMENT_TRANSACTION else {
        fail("catalog capability disabled: transaction")
      }
      []
    }
    PreparedSelect(select) => {
      guard CAP_STATEMENT_SELECT else {
        fail("catalog capability disabled: select")
      }
      selection_template(select, evaluation(store, params, [])).map(b => b.name)
    }
    PreparedPragma(name, table) => {
      guard CAP_STATEMENT_PRAGMA else {
        fail("catalog capability disabled: pragma")
      }
      ignore(execute_pragma(store, name, table, None, params))
      match name {
        "index_list" => ["seq", "name", "unique", "origin", "partial"]
        "index_info" => ["seqno", "cid", "name"]
        "index_xinfo" => ["seqno", "cid", "name", "desc", "coll", "key"]
        "table_info" => ["cid", "name", "type", "notnull", "dflt_value", "pk"]
        "table_xinfo" =>
          ["cid", "name", "type", "notnull", "dflt_value", "pk", "hidden"]
        "foreign_key_list" =>
          [
            "id", "seq", "table", "from", "to", "on_update", "on_delete", "match",
          ]
        "foreign_key_check" => ["table", "rowid", "parent", "fkid"]
        _ => [name]
      }
    }
    PreparedInsert(insertion) => {
      guard CAP_STATEMENT_INSERT else {
        fail("catalog capability disabled: insert")
      }
      let table = get_table(store, insertion.table)
      prepare_foreign_table(store, table)
      let columns = if insertion.columns.is_empty() {
        table.columns.map(c => c.name)
      } else {
        insertion.columns
      }
      for name in columns {
        ignore(insertion_column(table, name))
      }
      if insertion.selection is Some(select) {
        guard selection_template(select, evaluation(store, params, [])).length() ==
          columns.length() else {
          fail("INSERT SELECT column count mismatch")
        }
      }
      for row in insertion.values {
        guard row.length() == columns.length() else {
          fail("INSERT value count mismatch")
        }
        for value in row {
          prepare_expression(value, evaluation(store, params, []), false, false)
        }
      }
      let empty = { id: 0L, values: Array::make(table.columns.length(), Null), }
      let row = row_environment(table, empty, table.name)
      let excluded = row_environment(table, empty, "excluded")
      for (name, expression) in insertion.updates {
        ignore(column_index(table, name))
        prepare_expression(
          expression,
          evaluation(store, params, row + excluded),
          false,
          false,
        )
      }
      prepare_expression(
        insertion.predicate,
        evaluation(store, params, row + excluded),
        false,
        false,
      )
      prepare_returning(insertion.returning, evaluation(store, params, row))
      project_template(insertion.returning, evaluation(store, params, row)).map(b => {
          b.name
        },
      )
    }
    PreparedUpdate(name, setters, predicate, returning) => {
      guard CAP_STATEMENT_UPDATE else {
        fail("catalog capability disabled: update")
      }
      let table = get_table(store, name)
      prepare_foreign_table(store, table)
      let layout = row_environment(
        table,
        { id: 0L, values: Array::make(table.columns.length(), Null), },
        table.name,
      )
      let context = evaluation(store, params, layout)
      ignore(validate_update(table, setters, predicate, returning, context))
      project_template(returning, context).map(b => b.name)
    }
    PreparedDelete(name, predicate, returning) => {
      guard CAP_STATEMENT_DELETE else {
        fail("catalog capability disabled: delete")
      }
      let table = get_table(store, name)
      prepare_foreign_table(store, table)
      let context = evaluation(
        store,
        params,
        row_environment(
          table,
          { id: 0L, values: Array::make(table.columns.length(), Null), },
          name,
        ),
      )
      prepare_expression(predicate, context, false, false)
      prepare_returning(returning, context)
      project_template(returning, context).map(b => b.name)
    }
  }
}

///|
fn program_id(input : String) -> String {
  let mut value = 14695981039346656037UL
  for byte in @utf8.encode(input) {
    value = (value ^ byte.to_uint64()) * 1099511628211UL
  }
  value.to_string()
}

///|
// Shared semantic validation has no dependency on a particular wire decoder.
fn prepare_compiled_program(
  program : CompiledProgram,
  id : String,
) -> Program raise SqlError {
  guard program.format == "moon-aot@1" &&
    program.queries.length() <= 1000 &&
    program.schema.encoding.unwrap_or(1) == 1 &&
    program.schema.tables.all(t => t.rows.is_empty()) else {
    fail("unsupported compiled program")
  }
  validate_store_rows(program.schema)
  for object in program.schema.objects {
    if object.kind == "view" {
      guard object.selection is Some(select) else {
        fail("view has no compiled query")
      }
      ignore(selection_template(select, evaluation(program.schema, [], [])))
    }
  }
  let queries : Map[String, CompiledQuery] = Map([])
  let selections : Map[String, PreparedSelection] = Map([])
  let updates : Map[String, PreparedUpdatePlan] = Map([])
  // Share a table's null-valued layout rather than retaining it per UPDATE.
  let update_layouts : Map[String, Environment] = Map([])
  for query in program.queries {
    validate_optional_features(query)
    guard query.name != "" &&
      !queries.contains(query.name) &&
      query.parameters >= 0 &&
      query.parameters <= 10000 else {
      fail("invalid compiled query catalog")
    }
    let names = match query.statement {
      PreparedSelect(select) => {
        guard CAP_STATEMENT_SELECT else {
          fail("catalog capability disabled: select")
        }
        let prepared = prepare_selection(
          program.schema,
          select,
          query.parameters,
        )
        selections[query.name] = prepared
        prepared.output.map(b => b.name)
      }
      PreparedUpdate(name, setters, predicate, returning) => {
        guard CAP_STATEMENT_UPDATE else {
          fail("catalog capability disabled: update")
        }
        let (prepared, names) = prepare_update(
          program.schema,
          name,
          setters,
          predicate,
          returning,
          query.parameters,
          layouts=update_layouts,
        )
        updates[query.name] = prepared
        names
      }
      _ => prepared_names(program.schema, query.statement, query.parameters)
    }
    guard names == query.names else {
      fail("invalid compiled query result metadata")
    }
    queries[query.name] = query
  }
  {
    schema: program.schema,
    queries,
    selections,
    updates,
    id,
    storage: program.storage,
  }
}

///|
/// Load an application build artifact once. It is not an untrusted SQL endpoint.
pub fn Program::load(input : String) -> Program raise SqliteError {
  try {
    guard input.length() <= 1048576 else {
      fail("compiled program resource limit")
    }
    let program : CompiledProgram = @json.from_json(@json.parse(input))
    let validated = prepare_compiled_program(program, "")
    { ..validated, id: program_id(@json.to_json(program).stringify()), }
  } catch {
    error =>
      raise interface_error(
        match error {
          SqlError(message) => message
          _ => error.to_string()
        },
      )
  }
}

///|
pub fn Program::query(self : Program, name : String) -> Query raise SqliteError {
  guard self.queries.get(name) is Some(plan) else {
    raise sqlite_misuse("unknown query in compiled catalog: " + name)
  }
  {
    program_id: self.id,
    plan,
    selection: self.selections.get(name),
    update: self.updates.get(name),
  }
}

///|
pub fn Connection::from_program(program : Program) -> Connection {
  {
    database: {
      store: copy_store(program.schema),
      serial: 0,
      schema_epoch: 0L,
    },
    program: Some(program),
    closed: false,
    statements: 0,
  }
}

///|
pub fn Connection::prepare_compiled(
  self : Connection,
  query : Query,
) -> Statement raise SqliteError {
  self.healthy()
  guard self.program is Some(program) && program.id == query.program_id else {
    raise sqlite_misuse("compiled query belongs to a different program")
  }
  let plan = query.plan
  statement_new(
    self,
    plan.parameters,
    plan.names,
    data_readonly(plan.statement),
    params => {
      execute_data_statement(
        self.database.store,
        plan.statement,
        params,
        prepared_selection=query.selection,
        prepared_update=query.update,
      )
    },
    tracks_changes=!data_readonly(plan.statement),
  )
}
