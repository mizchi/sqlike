///|
/// Fixed-schema derived metadata. Cached cells are immutable/recomputed at writes
/// and reopen; persistent rows carry NULL placeholders at virtual ordinals.
priv struct GeneratedPlan {
  layout : Environment
  columns : Array[(Int32, String, BoundExpression)]
}

///|
fn generated_column(col : ColumnDef) -> Bool {
  col.default_value is Call("$generated-virtual", _)
}

///|
fn has_generated_columns(table : Table) -> Bool {
  FEATURE_GENERATED_COLUMNS && table.columns.any(generated_column)
}

///|
fn writable_column(table : Table, name : String) -> Int32 raise SqlError {
  let i = column_index(table, name)
  guard !FEATURE_GENERATED_COLUMNS || !generated_column(table.columns[i]) else {
    fail("cannot write generated column: " + name)
  }
  i
}

///|
fn insert_columns(table : Table) -> Array[Int32] {
  if !FEATURE_GENERATED_COLUMNS {
    return table.columns.mapi((i, _) => i)
  }
  table.columns
  .mapi((i, _) => i)
  .filter(i => !FEATURE_GENERATED_COLUMNS || !generated_column(table.columns[i]))
}

///|
fn generated_dependencies(
  table : Table,
  e : Expr,
) -> Array[Int32] raise SqlError {
  match e {
    Literal(_) => []
    TruthLiteral(value) => {
      let name = if value { "true" } else { "false" }
      match table.columns.search_by(c => matches_identifier(c.name, name)) {
        Some(i) => [i]
        None => []
      }
    }
    Column(q, n) => {
      guard q == "" else { fail("qualified column in generated expression") }
      [column_index(table, n)]
    }
    Unary(_, e) | Cast(e, _) | Collate(e, _) => generated_dependencies(table, e)
    Binary(_, a, b) =>
      generated_dependencies(table, a) + generated_dependencies(table, b)
    Between(e, a, b) =>
      generated_dependencies(table, e) +
      generated_dependencies(table, a) +
      generated_dependencies(table, b)
    Case(base, arms, other) => {
      let result = base.map(e => generated_dependencies(table, e)).unwrap_or([])
      for (condition, value) in arms {
        for
          i in generated_dependencies(table, condition) +
          generated_dependencies(table, value) {
          result.push(i)
        }
      }
      for i in generated_dependencies(table, other) {
        result.push(i)
      }
      result
    }
    Call(name, args) => {
      guard !aggregate_name(name, args.length()) &&
        (
          [
            "abs", "length", "octet_length", "typeof", "coalesce", "ifnull", "nullif",
            "iif", "if", "lower", "upper", "substr", "substring", "trim", "ltrim",
            "rtrim", "replace", "instr", "hex", "unhex", "unicode", "char", "quote",
            "zeroblob", "round", "sign", "min", "max", "like", "glob", "in", "ceil",
            "ceiling", "floor", "trunc", "->", "->>", "json",
          ].contains(name) ||
          name.has_prefix("json_")
        ) else {
        fail(
          "unsupported nondeterministic or non-scalar generated expression: " +
          name,
        )
      }
      let result : Array[Int32] = []
      for arg in args {
        for i in generated_dependencies(table, arg) {
          result.push(i)
        }
      }
      result
    }
    _ => fail("unsupported generated expression")
  }
}

///|
fn generated_visit(
  table : Table,
  i : Int32,
  state : Array[Int32],
  order : Array[Int32],
  depth : Int32,
) -> Unit raise SqlError {
  guard depth <= 64 else { fail("generated dependency resource limit") }
  if state[i] == 2 {
    return
  }
  guard state[i] == 0 else { fail("generated column dependency cycle") }
  state[i] = 1
  if table.columns[i].default_value is Call("$generated-virtual", [expression]) {
    guard table.columns[i].default_source is None ||
      table.columns[i].default_source == Some("") else {
      fail("DEFAULT on a generated column")
    }
    guard affinity_name(table.columns[i].declared) != "real" else {
      fail("unsupported REAL affinity generated column")
    }
    guard table.columns[i].primary == 0 else {
      fail("generated column cannot be PRIMARY KEY")
    }
    for dependency in generated_dependencies(table, expression) {
      generated_visit(table, dependency, state, order, depth + 1)
    }
    order.push(i)
  } else {
    guard !generated_column(table.columns[i]) else {
      fail("invalid generated column metadata")
    }
  }
  state[i] = 2
}

///|
fn validate_generated_table(
  store : Store,
  table : Table,
) -> Unit raise SqlError {
  if !has_generated_columns(table) {
    return
  }
  guard table.columns.any(c => !generated_column(c)) else {
    fail("table requires a non-generated column")
  }
  let layout = row_environment(
    table,
    { id: 0L, values: Array::make(table.columns.length(), Null), },
    table.name,
  )
  let context = evaluation(store, [], layout)
  let order : Array[Int32] = []
  let state = Array::make(table.columns.length(), 0)
  for i in 0..<table.columns.length() {
    generated_visit(table, i, state, order, 0)
  }
  let columns = order.map(i => {
    guard table.columns[i].default_value
      is Call("$generated-virtual", [expression]) else {
      fail("invalid generated column metadata")
    }
    prepare_expression(expression, context, false, false)
    (
      i,
      column_affinity(table, table.columns[i]),
      bind_expression(expression, context),
    )
  })
  store.generated_plans[table.sql] = { layout, columns, }
}

///|
fn generated_row(
  store : Store,
  table : Table,
  row : StoredRow,
  storage~ : Bool = false,
) -> StoredRow raise SqlError {
  if !has_generated_columns(table) {
    return row
  }
  if !store.generated_plans.contains(table.sql) {
    validate_generated_table(store, table)
  }
  guard row.values.length() == table.columns.length() else {
    fail("invalid generated row width")
  }
  let plan = store.generated_plans[table.sql]
  let values = row.values.copy()
  for (i, affinity, expression) in plan.columns {
    guard !storage || values[i] is Null else {
      fail("generated value in persistent row")
    }
    let input : BoundInput = {
      store,
      params: [],
      row: { id: row.id, values, },
      layout: plan.layout,
      context: None,
      joined: None,
      in_lists: [],
    }
    values[i] = apply_affinity(evaluate_bound(expression, input), affinity)
  }
  { ..row, values, }
}

///|
fn persistent_generated_row(table : Table, row : StoredRow) -> StoredRow {
  if !has_generated_columns(table) {
    return row
  }
  {
    ..row,
    values: row.values.mapi((i, value) => {
      if generated_column(table.columns[i]) {
        Null
      } else {
        value
      }
    }),
  }
}

///|
fn column_default(
  store : Store,
  table : Table,
  col : ColumnDef,
  params : Array[Value],
) -> Value raise SqlError {
  if FEATURE_GENERATED_COLUMNS && generated_column(col) {
    return Null
  }
  // Most omitted columns have a literal NULL default. Avoid allocating an
  // evaluation context for literals; expressions still run once per row.
  let value = match col.default_value {
    Literal(Null) => return Null
    Literal(value) => value
    TruthLiteral(value) => boolean(value)
    expression =>
      evaluate(expression, { ..evaluation(store, params, []), outer: [], })
  }
  apply_affinity(value, column_affinity(table, col))
}
