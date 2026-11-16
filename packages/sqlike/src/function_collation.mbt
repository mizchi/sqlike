///|
/// A column defines even BINARY. Other expressions carry only explicit COLLATE;
/// scalar subqueries do not supply collation to min/max (unlike comparisons).
fn function_collation(
  expressions : Array[Expr],
  ctx : Evaluation,
  explicit_only : Bool,
) -> String? raise SqlError {
  for e in expressions {
    let found : String? = match e {
      Collate(_, name) => Some(name)
      Column(q, n) =>
        if explicit_only {
          None
        } else {
          Some(resolve_context(ctx, q, n).collation)
        }
      TruthLiteral(v) =>
        if explicit_only {
          None
        } else {
          find_context(ctx, "", if v { "true" } else { "false" }).map(b => {
            b.collation
          })
        }
      Cast(e, _) | Unary("+", e) => function_collation([e], ctx, explicit_only)
      Unary(_, e) => function_collation([e], ctx, true)
      Binary(_, a, b) => function_collation([a, b], ctx, true)
      Between(a, b, c) => function_collation([a, b, c], ctx, true)
      Call(_, args) | Window(_, args, _, _, _) =>
        function_collation(args, ctx, true)
      Case(base, arms, other) => {
        let parts = base.map(e => [e]).unwrap_or([])
        for (condition, value) in arms {
          parts.push(condition)
          parts.push(value)
        }
        parts.push(other)
        function_collation(parts, ctx, true)
      }
      InSelect(e, _) => function_collation([e], ctx, true)
      _ => None
    }
    if found is Some(_) {
      return found
    }
  }
  None
}
