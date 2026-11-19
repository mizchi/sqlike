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
  BoundOriginal(Expr, Array[PreparedRowMetadata])
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
priv enum BoundRowSlot {
  TargetSlot(Int32)
  TargetRowid
  SourceSlot(Int32)
  SourceRowid
}

///|
priv struct JoinedBoundRows {
  source : StoredRow
  slots : Array[BoundRowSlot]
}

///|
priv struct BoundInput {
  store : Store
  params : Array[Value]
  row : StoredRow
  layout : Environment
  mut context : Evaluation?
  in_lists : Array[InListFrame]
  joined : JoinedBoundRows?
}

///|
fn BoundInput::column(self : BoundInput, index : Int32) -> Value {
  if FEATURE_UPDATE_FROM &&
    OPT_UPDATE_FROM_LOOKUP &&
    self.joined is Some(joined) {
    return match joined.slots[index] {
      TargetSlot(i) => self.row.values[i]
      SourceSlot(i) => joined.source.values[i]
      TargetRowid => Integer(self.row.id)
      SourceRowid => Integer(joined.source.id)
    }
  }
  if index < 0 {
    Integer(self.row.id)
  } else {
    self.row.values[index]
  }
}

///|
fn BoundInput::environment(self : BoundInput) -> Evaluation {
  match self.context {
    Some(context) => context
    None => {
      let context = {
        ..evaluation(
          self.store,
          self.params,
          if FEATURE_UPDATE_FROM &&
            OPT_UPDATE_FROM_LOOKUP &&
            self.joined is Some(_) {
            self.layout.mapi((i, b) => { ..b, value: self.column(i), })
          } else {
            row_environment_from(self.layout, self.row)
          },
        ),
        in_lists: self.in_lists,
      }
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
    Call("$row", _) => false
    ScalarSelect(_) => false
    Cast(e, _) | Collate(e, _) | Unary("+", e) => bound_metadata(e)
    _ => true
  }
}

///|
fn bound_original(
  e : Expr,
  context : Evaluation,
) -> BoundExpression raise SqlError {
  let metadata : Array[PreparedRowMetadata] = []
  if OPT_ROW_METADATA &&
    FEATURE_ROW_VALUES &&
    context.outer.is_empty() &&
    !context.row.any(b => b.join_column is Some(_)) {
    prepare_row_metadata(e, context, metadata)
  }
  BoundOriginal(e, metadata)
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
    Cast(e, name) =>
      if CAP_EXPRESSION_CAST {
        BoundCast(bind_expression(e, context), name)
      } else {
        fail("catalog capability disabled: expression cast")
      }
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
        return bound_original(e, context)
      }
      let collation = comparison_collation(left, right, context)
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
    _ => bound_original(e, context)
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
      let value = input.column(index)
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
    BoundCast(e, name) =>
      if CAP_EXPRESSION_CAST {
        guard name != "blob" || input.store.encoding.unwrap_or(1) == 1 else {
          fail("unsupported SQL: TEXT to BLOB cast in UTF-16 database")
        }
        cast_value(evaluate_bound(e, input), name)
      } else {
        fail("catalog capability disabled: expression cast")
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
    BoundOriginal(e, metadata) =>
      evaluate(
        e,
        if OPT_ROW_METADATA && FEATURE_ROW_VALUES && !metadata.is_empty() {
          { ..input.environment(), row_metadata: metadata, }
        } else {
          input.environment()
        },
      )
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
