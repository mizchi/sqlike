///|
/// A column defines even BINARY. Other expressions carry only explicit COLLATE;
/// scalar subqueries do not supply collation. IN SELECT handles its RHS
/// projection's collation separately.
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

///|
/// COLLATE anywhere in an operand overrides implicit column collation. Reserved
/// aggregate wrappers do not turn FILTER predicates/sorter keys into operands.
fn explicit_collation(e : Expr) -> String? {
  match e {
    Collate(_, name) => Some(name)
    Unary(_, e) | Cast(e, _) => explicit_collation(e)
    Binary(_, a, b) =>
      match explicit_collation(a) {
        Some(_) as c => c
        None => explicit_collation(b)
      }
    Between(e, a, b) => first_explicit_collation([e, a, b])
    Call("$filter", [e, _])
    | Call("$aggregate-order", [e, ..])
    | Call("$distinct", [e]) => explicit_collation(e)
    Call(_, args) | Window(_, args, _, _, _) => first_explicit_collation(args)
    Case(base, arms, otherwise) => {
      let fields = match base {
        Some(e) => [e]
        None => []
      }
      for (condition, value) in arms {
        fields.push(condition)
        fields.push(value)
      }
      fields.push(otherwise)
      first_explicit_collation(fields)
    }
    _ => None
  }
}

///|
fn first_explicit_collation(fields : Array[Expr]) -> String? {
  for field in fields {
    if explicit_collation(field) is Some(name) {
      return Some(name)
    }
  }
  None
}

///|
fn comparison_collation(
  left : Expr,
  right : Expr,
  ctx : Evaluation,
  right_default~ : String? = None,
) -> String raise SqlError {
  if explicit_collation(left) is Some(name) {
    return name
  }
  if explicit_collation(right) is Some(name) {
    return name
  }
  if function_collation([left], ctx, false) is Some(name) {
    return name
  }
  match right_default {
    Some(name) => name
    None => expression_collation(right, ctx)
  }
}
