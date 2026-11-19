///|
/// sqlite3SubqueryColumnTypes / sqlite3ExprDataType, SQLite 3.53/3.54.
/// A derived compound column is distinct from a scalar subquery's rightmost
/// expression affinity. Preserve values; only derive their comparison metadata.
fn compound_probe(
  select : Selection,
  e : Expr,
  context : Evaluation,
) -> Environment raise SqlError {
  selection_template(
    {
      ..select,
      ctes: [],
      projections: [
        { expression: e, explicit_label: true, label: "$metadata", },
      ],
      predicate: yes(),
      groups: [],
      having: yes(),
      orders: [],
      compound: None,
      distinct: false,
      limit: Literal(Integer(-1L)),
      offset: Literal(Integer(0L)),
    },
    context,
  )
}

///|
fn compound_affinity_types(affinity : String) -> Int32 {
  if ["integer", "numeric", "real"].contains(affinity) {
    5
  } else if affinity == "text" {
    6
  } else {
    7
  }
}

///|
fn compound_expression_types(
  e : Expr,
  select : Selection,
  context : Evaluation,
  affinity~ : String? = None,
) -> Int32 raise SqlError {
  match e {
    Literal(Null) => 0
    Literal(Text(_)) => 2
    Literal(Blob(_)) => 4
    Literal(_) => 1
    Collate(inner, _) =>
      compound_expression_types(inner, select, context, affinity~)
    Unary("+", inner) => compound_expression_types(inner, select, context)
    Column(_, _) | Cast(_, _) | ScalarSelect(_) =>
      compound_affinity_types(
        affinity.unwrap_or_else(() => {
          compound_probe(select, e, context)[0].affinity
        }),
      )
    TruthLiteral(value) =>
      // TRUE/FALSE can resolve to a source column, including a column having
      // no affinity. Probe the identifier, not the literal fallback.
      compound_affinity_types(
        compound_probe(
          select,
          Column("", if value { "true" } else { "false" }),
          context,
        )[0].affinity,
      ) catch {
        SqlError(message) =>
          if message.has_prefix("no such column") {
            1
          } else {
            fail(message)
          }
        error => raise error
      }
    Case(_, arms, otherwise) => {
      let mut types = compound_expression_types(otherwise, select, context)
      for (_, value) in arms {
        types = types | compound_expression_types(value, select, context)
      }
      types
    }
    Binary("||", _, _) => 6
    Call(_, _)
    | CurrentTime(_)
    | Parameter(_)
    | Window(_, _, _, _, _)
    | RowNumber(_) => 7
    _ => 1
  }
}

///|
fn compound_projection_origins(
  select : Selection,
  context : Evaluation,
) -> Array[Expr?] raise SqlError {
  let result : Array[Expr?] = []
  for p in select.projections {
    if p.expression is Star(_) {
      for _ in compound_probe(select, p.expression, context) {
        result.push(None)
      }
    } else {
      result.push(Some(p.expression))
    }
  }
  result
}

///|
fn compound_column_template(
  select : Selection,
  context : Evaluation,
  templates : Array[Environment],
) -> Environment raise SqlError {
  if templates.length() <= 1 {
    return templates[0]
  }
  let arms = [{ ..select, ctes: [], compound: None, }] +
    select.compound.unwrap_or([]).map(p => p.1)
  let origins = arms.map(arm => compound_projection_origins(arm, context))
  let type_at = fn(arm : Int32, column : Int32) -> Int32 raise SqlError {
    match origins[arm][column] {
      Some(e) =>
        compound_expression_types(
          e,
          arms[arm],
          context,
          affinity=Some(templates[arm][column].affinity),
        )
      None => compound_affinity_types(templates[arm][column].affinity)
    }
  }
  templates[0].mapi((column, binding) => {
    let mut chosen = 0
    let mut affinity = binding.affinity
    let mut types = 0
    while affinity == "" && chosen + 1 < templates.length() {
      types = types | type_at(chosen, column)
      chosen += 1
      affinity = templates[chosen][column].affinity
    }
    if affinity != "" {
      for i in (chosen + 1)..<templates.length() {
        types = types | type_at(i, column)
      }
      if (affinity == "text" && (types & 1) != 0) ||
        (["integer", "numeric", "real"].contains(affinity) && (types & 2) != 0) {
        affinity = "blob"
      }
      // FLEXNUM preserves the source cells. NUMERIC is its comparison affinity;
      // CTAS over compounds remains rejected until initial storage is modeled.
      if ["integer", "numeric", "real"].contains(affinity) &&
        origins[0][column] is Some(Cast(_, _)) {
        affinity = "numeric"
      }
    }
    { ..binding, affinity, }
  })
}
