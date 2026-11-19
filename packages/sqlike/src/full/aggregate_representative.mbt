///|
priv struct AggregateRepresentativePlan {
  name : String
  argument : Expr
  columns : Array[Expr]
}

///|
fn representative_column(e : Expr) -> Bool {
  match e {
    Column(_, _) | Star(_) | TruthLiteral(_) => true
    Call(name, args) =>
      !aggregate_name(name, args.length()) && args.any(representative_column)
    Unary(_, e) | Cast(e, _) | Collate(e, _) => representative_column(e)
    Binary(_, a, b) => representative_column(a) || representative_column(b)
    Between(e, a, b) => [e, a, b].any(representative_column)
    Case(base, arms, other) =>
      base.map(representative_column).unwrap_or(false) ||
      arms.any(p => representative_column(p.0) || representative_column(p.1)) ||
      representative_column(other)
    Window(_, args, parts, orders, _) =>
      args.any(representative_column) ||
      parts.any(representative_column) ||
      orders.any(o => representative_column(o.expression))
    RowNumber(orders) => orders.any(o => representative_column(o.expression))
    _ => false
  }
}

///|
fn representative_order(select : Selection, e : Expr) -> Expr {
  if e is Column("", name) {
    let aliases = select.projections.filter(p => {
      identifier(p.label) == identifier(name)
    })
    if aliases.length() == 1 {
      return aliases[0].expression
    }
  }
  e
}

///|
fn representative_extrema(e : Expr, output : Map[String, Expr]) -> Unit {
  match e {
    Call("$filter", args)
    | Call("$aggregate-order", args)
    | Call("$distinct", args) =>
      if args.any(extremum_aggregate) {
        output["unsupported"] = e
      }
    Call(name, [arg]) if name == "min" || name == "max" => {
      if arg is Call("$distinct", _) {
        output["unsupported"] = e
      }
      output[@json.to_json(e).stringify()] = e
    }
    Call(_, args) =>
      for arg in args {
        representative_extrema(arg, output)
      }
    Unary(_, e) | Cast(e, _) | Collate(e, _) =>
      representative_extrema(e, output)
    Binary(_, a, b) => {
      representative_extrema(a, output)
      representative_extrema(b, output)
    }
    Between(e, a, b) =>
      for arg in [e, a, b] {
        representative_extrema(arg, output)
      }
    Case(base, arms, other) => {
      if base is Some(e) {
        representative_extrema(e, output)
      }
      for (a, b) in arms {
        representative_extrema(a, output)
        representative_extrema(b, output)
      }
      representative_extrema(other, output)
    }
    Window(_, args, parts, orders, _) => {
      for e in args + parts {
        representative_extrema(e, output)
      }
      for o in orders {
        representative_extrema(o.expression, output)
      }
    }
    RowNumber(orders) =>
      for o in orders {
        representative_extrema(o.expression, output)
      }
    _ => ()
  }
}

///|
/// The extremum is evaluated again by the aggregate evaluator. Only pure,
/// per-row expressions may select a representative until those values share a
/// materialized evaluation. Do not evaluate volatile functions twice.
fn representative_argument(e : Expr) -> Bool {
  match e {
    Literal(_) | Parameter(_) | Column(_, _) | TruthLiteral(_) => true
    Unary(_, e) | Cast(e, _) | Collate(e, _) => representative_argument(e)
    Binary(_, a, b) => representative_argument(a) && representative_argument(b)
    Between(e, a, b) => [e, a, b].all(representative_argument)
    Case(base, arms, other) =>
      base.map(representative_argument).unwrap_or(true) &&
      arms.all(p => representative_argument(p.0) && representative_argument(p.1)) &&
      representative_argument(other)
    Call(name, args) =>
      (
        ((name == "min" || name == "max") && args.length() >= 2) ||
        [
          "abs", "lower", "upper", "length", "typeof", "coalesce", "ifnull", "nullif",
          "iif", "if", "substr", "substring", "trim", "ltrim", "rtrim", "replace",
          "instr", "in", "hex", "round", "sign",
        ].contains(name)
      ) &&
      args.all(representative_argument)
    _ => false
  }
}

///|
fn aggregate_representative_plan(
  select : Selection,
) -> AggregateRepresentativePlan? {
  let expressions = select.projections.map(p => p.expression) +
    [select.having] +
    select.orders.map(o => {
      representative_order(select, ordering_expression(o.expression))
    })
  if !expressions.any(representative_column) {
    return None
  }
  let candidates : Map[String, Expr] = Map([])
  for e in expressions {
    representative_extrema(e, candidates)
  }
  guard candidates.length() == 1 && !candidates.contains("unsupported") else {
    return None
  }
  for _, e in candidates {
    if e is Call(name, [argument]) {
      if !representative_argument(argument) {
        return None
      }
      let columns : Array[Expr] = []
      for e in expressions {
        representative_columns(e, columns)
      }
      return Some({ name, argument, columns, })
    }
  }
  None
}

///|
/// Use the unique MIN/MAX row, or tied rows with identical observable bare
/// inputs. Reject ambiguous outputs rather than choosing an arbitrary row.
fn aggregate_representative_row(
  plan : AggregateRepresentativePlan,
  group : Array[Environment],
  base : Evaluation,
  template : Environment,
) -> Environment raise SqlError {
  if group.is_empty() {
    return template.map(b => {
      ..b,
      value: Null,
      join_column: b.join_column.map(c => {
        match c {
          MergedJoinColumn(_, a, c) => MergedJoinColumn(Null, a, c)
          _ => c
        }
      }),
    })
  }
  let collation = function_collation([plan.argument], base, false).unwrap_or(
    "binary",
  )
  let mut best : Value? = None
  let mut winner = group[0]
  let mut tied = false
  for row in group {
    let value = evaluate(plan.argument, { ..base, row, })
    if value is Null {
      if best is None && !representative_equal(plan, winner, row, base) {
        tied = true
      }
      continue
    }
    match best {
      None => {
        best = Some(value)
        winner = row
        tied = false
      }
      Some(previous) => {
        let comparison = compare_stored(base.store, value, previous, collation)
        if (plan.name == "min" && comparison < 0) ||
          (plan.name == "max" && comparison > 0) {
          best = Some(value)
          winner = row
          tied = false
        } else if comparison == 0 {
          if !representative_equal(plan, winner, row, base) {
            tied = true
          }
        }
      }
    }
  }
  guard !tied else { fail("unsupported ambiguous aggregate representative") }
  winner
}

///|
fn representative_columns(e : Expr, output : Array[Expr]) -> Unit {
  match e {
    Column(_, _) | Star(_) | TruthLiteral(_) => output.push(e)
    Call(name, args) =>
      if !aggregate_name(name, args.length()) {
        for arg in args {
          representative_columns(arg, output)
        }
      }
    Unary(_, e) | Cast(e, _) | Collate(e, _) =>
      representative_columns(e, output)
    Binary(_, a, b) => {
      representative_columns(a, output)
      representative_columns(b, output)
    }
    Between(e, a, b) =>
      for arg in [e, a, b] {
        representative_columns(arg, output)
      }
    Case(base, arms, other) => {
      if base is Some(e) {
        representative_columns(e, output)
      }
      for (a, b) in arms {
        representative_columns(a, output)
        representative_columns(b, output)
      }
      representative_columns(other, output)
    }
    Window(_, args, parts, orders, _) => {
      for e in args + parts {
        representative_columns(e, output)
      }
      for o in orders {
        representative_columns(o.expression, output)
      }
    }
    RowNumber(orders) =>
      for o in orders {
        representative_columns(o.expression, output)
      }
    _ => ()
  }
}

///|
fn representative_values(
  columns : Array[Expr],
  ctx : Evaluation,
) -> Array[Binding] raise SqlError {
  let values : Array[Binding] = []
  for e in columns {
    match e {
      Column(q, n) => values.push(resolve_context(ctx, q, n))
      TruthLiteral(v) =>
        values.push(
          find_context(ctx, "", if v { "true" } else { "false" }).unwrap_or_else(() => {
              binding("", boolean(v))
            },
          ),
        )
      Star(q) =>
        for b in ctx.row {
          if !b.hidden &&
            (q == "" || matches_identifier(b.qualifier, identifier(q))) {
            if q == "" {
              if unqualified_binding(b) is Some(b) {
                values.push(b)
              }
            } else {
              values.push(b)
            }
          }
        }
      _ => ()
    }
  }
  values
}

///|
fn representative_equal(
  plan : AggregateRepresentativePlan,
  a : Environment,
  b : Environment,
  base : Evaluation,
) -> Bool raise SqlError {
  let a = representative_values(plan.columns, { ..base, row: a, })
  let b = representative_values(plan.columns, { ..base, row: b, })
  a.length() == b.length() &&
  a
  .mapi((i, v) => {
    let w = b[i]
    let value = match (v.value, w.value) {
      (Real(x), Real(y)) =>
        x.reinterpret_as_uint64() == y.reinterpret_as_uint64()
      _ => v.value == w.value
    }
    value &&
    v.json_value == w.json_value &&
    v.affinity == w.affinity &&
    v.collation == w.collation
  })
  .all(v => v)
}
