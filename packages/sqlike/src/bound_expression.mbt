///|
/// Internal executable IR, derived only after validating the fixed-schema AST.
/// It is neither a wire format nor an input accepted from the host.
priv enum BoundExpression {
  BoundLiteral(Value)
  BoundParameter(Int32)
  BoundColumn(Int32, Bool) // -1 = physical rowid; Bool = expression coercion policy
  BoundUnary(String, BoundExpression)
  BoundBinary(String, BoundExpression, BoundExpression)
  BoundCast(BoundExpression, String)
  BoundCompare(String, BoundExpression, BoundExpression, BoundComparison)
  BoundOriginal(Expr)
}

///|
priv struct BoundComparison {
  left_affinity : String
  right_affinity : String
  collation : String
  truth_literal : Bool?
}

///|
priv struct BoundProjection {
  output : Environment
  values : Array[BoundExpression]
}

///|
/// Per-row state, never stored in a Program/Query. A generic expression creates
/// its environment lazily; fully bound expressions use StoredRow slots directly.
priv struct BoundInput {
  store : Store
  params : Array[Value]
  row : StoredRow
  layout : Environment
  mut context : Evaluation?
}

///|
fn BoundInput::environment(self : BoundInput) -> Evaluation {
  match self.context {
    Some(context) => context
    None => {
      let context = evaluation(
        self.store,
        self.params,
        row_environment_from(self.layout, self.row),
      )
      self.context = Some(context)
      context
    }
  }
}

///|
fn bound_column(
  layout : Environment,
  qualifier : String,
  name : String,
) -> Int32 raise SqlError {
  guard find_binding(layout, qualifier, name) is Some(found) else {
    fail("no such column: " + name)
  }
  for i, column in layout {
    if column.name == found.name && column.qualifier == found.qualifier {
      return if column.hidden { -1 } else { i }
    }
  }
  fail("invalid bound column")
}

///|
fn bound_metadata(e : Expr) -> Bool {
  match e {
    ScalarSelect(_) => false
    Cast(e, _) | Collate(e, _) | Unary("+", e) => bound_metadata(e)
    _ => true
  }
}

///|
fn bind_expression(
  e : Expr,
  context : Evaluation,
) -> BoundExpression raise SqlError {
  match e {
    Literal(value) => BoundLiteral(value)
    Parameter(index) => {
      guard index >= 0 && index < context.params.length() else {
        fail("missing SQL binding")
      }
      BoundParameter(index)
    }
    Column(q, name) => BoundColumn(bound_column(context.row, q, name), true)
    TruthLiteral(value) =>
      if find_binding(context.row, "", if value { "true" } else { "false" })
        is Some(_) {
        BoundColumn(
          bound_column(context.row, "", if value { "true" } else { "false" }),
          false,
        )
      } else {
        BoundLiteral(boolean(value))
      }
    Collate(e, _) => bind_expression(e, context)
    Cast(e, name) => BoundCast(bind_expression(e, context), name)
    Unary(op, e) => BoundUnary(op, bind_expression(e, context))
    Binary(op, left, right) => {
      if !comparison_operator(op) {
        return BoundBinary(
          op,
          bind_expression(left, context),
          bind_expression(right, context),
        )
      }
      // Subquery result metadata stays with the generic evaluator. Base-table
      // columns have no USING/FULL JOIN merged-column affinity rules.
      guard bound_metadata(left) && bound_metadata(right) else {
        return BoundOriginal(e)
      }
      let collation = match left {
        Collate(_, name) => name
        _ =>
          match right {
            Collate(_, name) => name
            _ =>
              if column_collation_operand(left) {
                expression_collation(left, context)
              } else {
                expression_collation(right, context)
              }
          }
      }
      let truth_literal = match right {
        TruthLiteral(value) =>
          if find_binding(context.row, "", if value { "true" } else { "false" })
            is None {
            Some(value)
          } else {
            None
          }
        _ => None
      }
      BoundCompare(
        op,
        bind_expression(left, context),
        bind_expression(right, context),
        {
          left_affinity: expression_affinity(left, context),
          right_affinity: expression_affinity(right, context),
          collation,
          truth_literal,
        },
      )
    }
    _ => BoundOriginal(e)
  }
}

///|
fn evaluate_bound(
  e : BoundExpression,
  input : BoundInput,
) -> Value raise SqlError {
  match e {
    BoundLiteral(value) => expression_value(value, input.store)
    BoundParameter(index) => {
      guard index >= 0 && index < input.params.length() else {
        fail("missing SQL binding")
      }
      expression_value(input.params[index], input.store)
    }
    BoundColumn(index, checked) => {
      let value : Value = if index < 0 {
        Integer(input.row.id)
      } else {
        input.row.values[index]
      }
      if checked {
        expression_value(value, input.store)
      } else {
        value
      }
    }
    BoundUnary(op, e) => unary_value(op, evaluate_bound(e, input))
    BoundBinary(op, left, right) =>
      binary_value(
        op,
        evaluate_bound(left, input),
        evaluate_bound(right, input),
      )
    BoundCast(e, name) => {
      guard name != "blob" || input.store.encoding.unwrap_or(1) == 1 else {
        fail("unsupported SQL: TEXT to BLOB cast in UTF-16 database")
      }
      cast_value(evaluate_bound(e, input), name)
    }
    BoundCompare(op, left, right, metadata) => {
      let a = evaluate_bound(left, input)
      let b = evaluate_bound(right, input)
      if (op == "is" || op == "is not") &&
        metadata.truth_literal is Some(expected) {
        boolean((truth(a) == (if expected { 1 } else { 0 })) == (op == "is"))
      } else if a is Null || b is Null {
        if op == "is" || op == "is not" {
          boolean((a is Null && b is Null) == (op == "is"))
        } else {
          Null
        }
      } else {
        compare_nonnull(
          op,
          a,
          b,
          metadata.left_affinity,
          metadata.right_affinity,
          metadata.collation,
          input.store,
        )
      }
    }
    BoundOriginal(e) => evaluate(e, input.environment())
  }
}

///|
fn bind_projection(
  projections : Array[Projection],
  context : Evaluation,
) -> BoundProjection raise SqlError {
  let output = project_template(projections, context)
  let values : Array[BoundExpression] = []
  for projection in projections {
    match projection.expression {
      Star(q) =>
        for i, column in context.row {
          if !column.hidden &&
            (q == "" || matches_identifier(column.qualifier, identifier(q))) {
            values.push(BoundColumn(i, false))
          }
        }
      // Direct BLOB reads retain the physical projection policy, including UTF-16.
      Column(q, name) =>
        values.push(BoundColumn(bound_column(context.row, q, name), false))
      e => values.push(bind_expression(e, context))
    }
  }
  guard output.length() == values.length() else {
    fail("invalid bound projection")
  }
  { output, values, }
}

///|
fn project_bound(
  plan : BoundProjection,
  input : BoundInput,
) -> Environment raise SqlError {
  plan.output.mapi((i, binding) => {
    ..binding,
    value: evaluate_bound(plan.values[i], input),
  })
}
