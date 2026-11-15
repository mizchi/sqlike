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
  match e {
    Call("min", _) | Call("max", _) => true
    Call(_, args) => args.any(extremum_aggregate)
    Unary(_, e) | Collate(e, _) | Cast(e, _) => extremum_aggregate(e)
    Binary(_, a, b) => extremum_aggregate(a) || extremum_aggregate(b)
    Between(e, a, b) =>
      extremum_aggregate(e) || extremum_aggregate(a) || extremum_aggregate(b)
    Case(base, arms, other) =>
      base.map(extremum_aggregate).unwrap_or(false) ||
      arms.any(p => extremum_aggregate(p.0) || extremum_aggregate(p.1)) ||
      extremum_aggregate(other)
    _ => false
  }
}

///|
/// Aggregate arguments have their own per-row scope. Outside them, only group
/// expressions are accepted; no arbitrary representative row is promised.
fn validate_group_output(
  e : Expr,
  groups : Array[Expr],
  extremes : Bool,
) -> Unit raise SqlError {
  if !extremes && groups.any(g => @json.to_json(g) == @json.to_json(e)) {
    return
  }
  match e {
    Column(_, _) | Star(_) =>
      fail("unsupported SQL: bare column in aggregate output")
    Call(name, args) =>
      if !aggregate_name(name) {
        for arg in args {
          validate_group_output(arg, groups, extremes)
        }
      }
    Unary(_, e) | Collate(e, _) | Cast(e, _) =>
      validate_group_output(e, groups, extremes)
    Binary(_, a, b) => {
      validate_group_output(a, groups, extremes)
      validate_group_output(b, groups, extremes)
    }
    Between(e, a, b) => {
      validate_group_output(e, groups, extremes)
      validate_group_output(a, groups, extremes)
      validate_group_output(b, groups, extremes)
    }
    Case(base, arms, other) => {
      if base is Some(e) {
        validate_group_output(e, groups, extremes)
      }
      for (a, b) in arms {
        validate_group_output(a, groups, extremes)
        validate_group_output(b, groups, extremes)
      }
      validate_group_output(other, groups, extremes)
    }
    Window(_, args, partitions, orders, _) => {
      for arg in args {
        validate_group_output(arg, groups, extremes)
      }
      for p in partitions {
        validate_group_output(p, groups, extremes)
      }
      for order in orders {
        validate_group_output(order.expression, groups, extremes)
      }
    }
    RowNumber(orders) =>
      for o in orders {
        validate_group_output(o.expression, groups, extremes)
      }
    ScalarSelect(_) | InSelect(_, _) | Exists(_) =>
      fail("unsupported SQL: subquery in aggregate output")
    _ => ()
  }
}

///|
fn validate_aggregate_output(select : Selection) -> Unit raise SqlError {
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
  for p in select.projections {
    validate_group_output(p.expression, select.groups, extremes)
  }
  validate_group_output(select.having, select.groups, extremes)
  for o in select.orders {
    if o.expression is Column("", name) {
      let aliases = select.projections.filter(p => {
        identifier(p.label) == identifier(name)
      })
      if aliases.length() == 1 {
        validate_group_output(aliases[0].expression, select.groups, extremes)
        continue
      }
    }
    validate_group_output(o.expression, select.groups, extremes)
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
