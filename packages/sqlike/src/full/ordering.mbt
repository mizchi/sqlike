///|
/// Reserved IR calls preserve the v1 AST/wire shape. Older runtimes reject these
/// unknown calls at preparation. They are valid only as outer ORDER BY metadata.
fn ordering_expression(e : Expr) -> Expr {
  match e {
    Call("$nulls-first", [arg]) | Call("$nulls-last", [arg]) => arg
    _ => e
  }
}

///|
fn ordering_compare(
  store : Store,
  order : Ordering,
  a : Value,
  b : Value,
  collation : String,
) -> Int32 {
  let first : Bool? = match order.expression {
    Call("$nulls-first", [_]) => Some(true)
    Call("$nulls-last", [_]) => Some(false)
    _ => None
  }
  if first is Some(first) && (a is Null || b is Null) {
    if a is Null && b is Null {
      0
    } else if (a is Null) == first {
      -1
    } else {
      1
    }
  } else {
    let c = compare_stored(store, a, b, collation)
    if order.descending {
      -c
    } else {
      c
    }
  }
}
