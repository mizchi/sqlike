///|
/// Resolve names and reject unsupported expressions before changing any row.
/// This phase does not execute scalar functions (an empty result may skip them).
fn prepare_expression(
  e : Expr,
  ctx : Evaluation,
  aggregates : Bool,
  windows : Bool,
) -> Unit raise SqlError {
  match e {
    Literal(_) | Parameter(_) | TruthLiteral(_) => ()
    CurrentTime(name) => {
      guard FEATURE_DATETIME else { fail("feature disabled: dateTime") }
      guard ["date", "time", "datetime"].contains(name) else {
        fail("unsupported SQL current time: " + name)
      }
    }
    Column(q, n) => ignore(resolve_context(ctx, q, n))
    Star(_) => fail("unsupported * expression")
    Unary(op, e) => {
      guard ["+", "-", "not", "~"].contains(op) else {
        fail("unsupported SQL unary operator: " + op)
      }
      prepare_expression(e, ctx, aggregates, windows)
    }
    Collate(e, name) => {
      validate_collation(name)
      prepare_expression(e, ctx, aggregates, windows)
    }
    Cast(e, target) => {
      guard ["integer", "real", "numeric", "text", "blob"].contains(target) else {
        fail("unsupported SQL cast: " + target)
      }
      prepare_expression(e, ctx, aggregates, windows)
    }
    Binary(op, a, b) => {
      guard [
        "+", "-", "*", "/", "%", "<<", ">>", "&", "|", "||", "and", "or", "=", "==",
        "!=", "<>", "<", ">", "<=", ">=", "is", "is not", "like",
      ].contains(op) else {
        fail("unsupported SQL binary operator: " + op)
      }
      prepare_expression(a, ctx, aggregates, windows)
      prepare_expression(b, ctx, aggregates, windows)
    }
    Between(e, a, b) => {
      prepare_expression(e, ctx, aggregates, windows)
      prepare_expression(a, ctx, aggregates, windows)
      prepare_expression(b, ctx, aggregates, windows)
    }
    Case(base, arms, otherwise) => {
      if base is Some(e) {
        prepare_expression(e, ctx, aggregates, windows)
      }
      for (condition, value) in arms {
        prepare_expression(condition, ctx, aggregates, windows)
        prepare_expression(value, ctx, aggregates, windows)
      }
      prepare_expression(otherwise, ctx, aggregates, windows)
    }
    InSelect(value, select) => {
      prepare_expression(value, ctx, aggregates, windows)
      guard selection_template(select, ctx.nested()).length() == 1 else {
        fail("sub-select returns more than one column")
      }
    }
    ScalarSelect(select) => {
      guard selection_template(select, ctx.nested()).length() == 1 else {
        fail("sub-select returns more than one column")
      }
    }
    Exists(select) => ignore(selection_template(select, ctx.nested()))
    Window(name, args, partitions, orders, frame) => {
      guard FEATURE_WINDOWS else { fail("feature disabled: windowFunctions") }
      guard ["rows", "range", "groups"].contains(frame.kind) else {
        fail("unsupported SQL window frame: " + frame.kind)
      }
      guard windows && window_arity(name, args.length()) else {
        fail("misuse of window function: " + name)
      }
      guard !args.any(e => e is Call("$distinct", _)) else {
        fail("DISTINCT is not supported for window functions")
      }
      for e in args {
        if !(e is Star(_)) {
          prepare_expression(e, ctx, true, false)
        } else {
          guard name == "count" else { fail("invalid window *") }
        }
      }
      for e in partitions {
        prepare_expression(e, ctx, true, false)
      }
      for o in orders {
        prepare_expression(o.expression, ctx, true, false)
      }
      for bound in [frame.start, frame.end] {
        match bound {
          Preceding(e) | Following(e) =>
            prepare_expression(e, { ..ctx, row: [], }, false, false)
          _ => ()
        }
      }
    }
    RowNumber(orders) => {
      guard FEATURE_WINDOWS else { fail("feature disabled: windowFunctions") }
      guard windows else { fail("misuse of window function") }
      for o in orders {
        prepare_expression(o.expression, ctx, false, false)
      }
    }
    Call(name, args) => {
      validate_function_features(name)
      if name == "$distinct" {
        guard aggregates &&
          (
            args.length() == 1 ||
            (
              (name == "group_concat" || name == "string_agg") &&
              args.length() == 2
            )
          ) &&
          (name != "string_agg" || args.length() == 2) else {
          fail("misuse of DISTINCT aggregate")
        }
        prepare_expression(args[0], ctx, false, false)
        return
      }
      if name == "raise" {
        guard !ctx.store.triggers.active.is_empty() else {
          fail("RAISE() may only be used within a trigger-program")
        }
        ignore(trigger_raise_action(args))
        if args.length() == 2 {
          prepare_expression(args[1], ctx, false, false)
        }
        return
      }
      let grouped = aggregate_name(name)
      if grouped {
        guard aggregates &&
          (
            args.length() == 1 ||
            (
              (name == "group_concat" || name == "string_agg") &&
              args.length() == 2
            )
          ) &&
          (name != "string_agg" || args.length() == 2) else {
          fail("misuse of aggregate function: " + name)
        }
      } else {
        let valid = match name {
          "changes" | "last_insert_rowid" => args.length() == 0
          "coalesce" => args.length() >= 2
          "ifnull" => args.length() == 2
          "typeof" | "hex" | "length" | "lower" | "upper" | "abs" =>
            args.length() == 1
          "in" => args.length() >= 1
          _ =>
            scalar_arity(name, args.length()) ||
            json_arity(name, args.length()) ||
            datetime_arity(name, args.length())
        }
        guard valid else { fail("unsupported SQL function or arity: " + name) }
      }
      for arg in args {
        if arg is Star(_) {
          guard name == "count" else { fail("unsupported function * argument") }
        } else if arg is Call("$distinct", [e]) {
          guard grouped && args.length() == 1 else {
            fail("DISTINCT aggregates require one argument")
          }
          prepare_expression(e, ctx, false, false)
        } else {
          prepare_expression(
            arg,
            ctx,
            aggregates && !grouped,
            windows && !grouped,
          )
        }
      }
    }
  }
}

///|
fn project_template(
  projections : Array[Projection],
  ctx : Evaluation,
) -> Environment raise SqlError {
  let output : Environment = []
  for projection in projections {
    if projection.expression is Star(q) {
      let columns = ctx.row.filter(b => {
        !b.hidden &&
        (q != "" || !(b.join_column is Some(SuppressedJoinColumn))) &&
        (q == "" || identifier(b.qualifier) == identifier(q))
      })
      guard !columns.is_empty() else {
        fail("no such table in * expression: " + q)
      }
      for b in columns {
        output.push({
          ..(if b.join_column is Some(MergedJoinColumn(_, _, _)) {
            unqualified_binding(b).unwrap()
          } else {
            b
          }),
          qualifier: "",
          value: Null,
          join_column: None,
        })
      }
    } else {
      prepare_expression(projection.expression, ctx, true, true)
      // A result column inherits affinity/collation only from a direct reference.
      output.push({
        ..binding(projection_name(projection, ctx), Null),
        affinity: expression_affinity(projection.expression, ctx),
        collation: expression_collation(projection.expression, ctx),
      })
    }
  }
  output
}

///|
fn prepare_returning(
  projections : Array[Projection],
  ctx : Evaluation,
) -> Unit raise SqlError {
  for p in projections {
    if !(p.expression is Star(_)) {
      prepare_expression(p.expression, ctx, false, false)
    }
  }
  ignore(project_template(projections, ctx))
}

///|
fn constant_default(expression : Expr) -> Bool {
  match expression {
    Literal(_) | TruthLiteral(_) | CurrentTime(_) => true
    Unary(_, e) => constant_default(e)
    _ => false
  }
}

///|
fn has_parameter(expression : Expr) -> Bool {
  match expression {
    Parameter(_) => true
    Unary(_, e) | Collate(e, _) | Cast(e, _) => has_parameter(e)
    Binary(_, a, b) => has_parameter(a) || has_parameter(b)
    InSelect(e, _) => has_parameter(e)
    Between(e, a, b) => has_parameter(e) || has_parameter(a) || has_parameter(b)
    Case(base, arms, otherwise) =>
      base.map(has_parameter).unwrap_or(false) ||
      arms.any(arm => has_parameter(arm.0) || has_parameter(arm.1)) ||
      has_parameter(otherwise)
    Call(_, args) => args.any(has_parameter)
    _ => false
  }
}

///|
fn has_subquery(e : Expr) -> Bool {
  match e {
    ScalarSelect(_) | Exists(_) | InSelect(_, _) => true
    Unary(_, e) | Collate(e, _) | Cast(e, _) => has_subquery(e)
    Binary(_, a, b) => has_subquery(a) || has_subquery(b)
    Between(e, a, b) => has_subquery(e) || has_subquery(a) || has_subquery(b)
    Case(base, arms, otherwise) =>
      base.map(has_subquery).unwrap_or(false) ||
      arms.any(arm => has_subquery(arm.0) || has_subquery(arm.1)) ||
      has_subquery(otherwise)
    Call(_, args) => args.any(has_subquery)
    _ => false
  }
}
