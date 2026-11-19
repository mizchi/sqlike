///|
/// Never substitute a replacement character for bytes SQLite would retain.
/// The portable TEXT contract contains Unicode strings, not arbitrary byte text.
fn checked_text_value(value : Value) -> String raise SqlError {
  match value {
    Blob(bytes) =>
      @utf8.decode(bytes) catch {
        _ => fail("unsupported SQL: non-UTF-8 BLOB to TEXT conversion")
      }
    _ => text_value(value)
  }
}

///|
fn validate_collation(name : String) -> Unit raise SqlError {
  guard ["binary", "nocase", "rtrim"].contains(name) else {
    fail("unsupported SQL collation: " + name)
  }
}

///|
fn extremum_aggregate(e : Expr) -> Bool {
  if !CAP_FUNCTION_AGGREGATES {
    return false
  }
  match e {
    Call("min", [_]) | Call("max", [_]) => true
    Call(_, args) => args.any(extremum_aggregate)
    Unary(_, e) | Collate(e, _) | Cast(e, _) => extremum_aggregate(e)
    Binary(_, a, b) => extremum_aggregate(a) || extremum_aggregate(b)
    Between(e, a, b) =>
      extremum_aggregate(e) || extremum_aggregate(a) || extremum_aggregate(b)
    Case(base, arms, other) =>
      base.map(extremum_aggregate).unwrap_or(false) ||
      arms.any(p => extremum_aggregate(p.0) || extremum_aggregate(p.1)) ||
      extremum_aggregate(other)
    Window(_, args, parts, orders, _) =>
      args.any(extremum_aggregate) ||
      parts.any(extremum_aggregate) ||
      orders.any(o => extremum_aggregate(o.expression))
    RowNumber(orders) => orders.any(o => extremum_aggregate(o.expression))
    _ => false
  }
}

///|
/// Aggregate arguments have their own per-row scope. Outside them, only group
/// expressions or a verified MIN/MAX representative are accepted.
fn validate_group_output(
  e : Expr,
  groups : Array[Expr],
  extremes : Bool,
  representative : Bool,
  context : Evaluation,
) -> Unit raise SqlError {
  if !extremes && groups.any(g => @json.to_json(g) == @json.to_json(e)) {
    return
  }
  match e {
    Column(_, _) | Star(_) =>
      if !representative {
        fail("unsupported SQL: bare column in aggregate output")
      }
    TruthLiteral(value) =>
      if !representative &&
        find_context(context, "", if value { "true" } else { "false" })
        is Some(_) {
        fail("unsupported SQL: bare column in aggregate output")
      }
    Call(name, args) =>
      if !aggregate_name(name, args.length()) {
        for arg in args {
          validate_group_output(arg, groups, extremes, representative, context)
        }
      }
    Unary(_, e) | Collate(e, _) | Cast(e, _) =>
      validate_group_output(e, groups, extremes, representative, context)
    Binary(_, a, b) => {
      validate_group_output(a, groups, extremes, representative, context)
      validate_group_output(b, groups, extremes, representative, context)
    }
    Between(e, a, b) => {
      validate_group_output(e, groups, extremes, representative, context)
      validate_group_output(a, groups, extremes, representative, context)
      validate_group_output(b, groups, extremes, representative, context)
    }
    Case(base, arms, other) => {
      if base is Some(e) {
        validate_group_output(e, groups, extremes, representative, context)
      }
      for (a, b) in arms {
        validate_group_output(a, groups, extremes, representative, context)
        validate_group_output(b, groups, extremes, representative, context)
      }
      validate_group_output(other, groups, extremes, representative, context)
    }
    Window(_, args, partitions, orders, _) => {
      for arg in args {
        validate_group_output(arg, groups, extremes, representative, context)
      }
      for p in partitions {
        validate_group_output(p, groups, extremes, representative, context)
      }
      for order in orders {
        validate_group_output(
          order.expression,
          groups,
          extremes,
          representative,
          context,
        )
      }
    }
    RowNumber(orders) =>
      for o in orders {
        validate_group_output(
          o.expression,
          groups,
          extremes,
          representative,
          context,
        )
      }
    ScalarSelect(_) | InSelect(_, _) | Exists(_) =>
      fail("unsupported SQL: subquery in aggregate output")
    _ => ()
  }
}

///|
fn validate_aggregate_output(
  select : Selection,
  context : Evaluation,
) -> Unit raise SqlError {
  if CAP_QUERY_GROUP_BY ||
    CAP_FUNCTION_AGGREGATES ||
    CAP_FUNCTION_GROUP_CONCAT ||
    CAP_FUNCTION_JSON_AGGREGATE {
    validate_grouped_selection(select, context)
  } else {
    guard select.groups.is_empty() else {
      fail("catalog capability disabled: query groupBy")
    }
    guard select.having is Literal(Integer(1L)) else {
      fail("unsupported SQL: aggregate context outside aggregate SELECT")
    }
  }
}

///|
fn validate_grouped_selection(
  select : Selection,
  context : Evaluation,
) -> Unit raise SqlError {
  let grouped = !select.groups.is_empty() ||
    select.projections.any(p => aggregate(p.expression))
  if !grouped {
    guard select.having is Literal(Integer(1L)) &&
      !select.orders.any(o => aggregate(o.expression)) else {
      fail("unsupported SQL: aggregate context outside aggregate SELECT")
    }
    return
  }
  let extremes = select.projections.any(p => extremum_aggregate(p.expression)) ||
    extremum_aggregate(select.having) ||
    select.orders.any(o => extremum_aggregate(o.expression))
  let representative = CAP_QUERY_AGGREGATE_REPRESENTATIVE &&
    aggregate_representative_plan(select) is Some(_)
  for p in select.projections {
    validate_group_output(
      p.expression,
      select.groups,
      extremes,
      representative,
      context,
    )
  }
  validate_group_output(
    select.having,
    select.groups,
    extremes,
    representative,
    context,
  )
  for o in select.orders {
    if o.expression is Column("", name) {
      let aliases = select.projections.filter(p => {
        identifier(p.label) == identifier(name)
      })
      if aliases.length() == 1 {
        validate_group_output(
          aliases[0].expression,
          select.groups,
          extremes,
          representative,
          context,
        )
        continue
      }
    }
    validate_group_output(
      o.expression,
      select.groups,
      extremes,
      representative,
      context,
    )
  }
}

///|
/// Raw BLOB reads remain possible through physical projection. Expression
/// coercions in UTF-16 databases need byte-encoding provenance we do not retain.
fn expression_value(value : Value, store : Store) -> Value raise SqlError {
  if store.encoding.unwrap_or(1) != 1 && value is Blob(_) {
    fail("unsupported SQL: BLOB expression coercion in UTF-16 database")
  }
  value
}
