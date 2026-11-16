///|
fn filter_input(e : Expr) -> Expr {
  if FEATURE_AGGREGATE_FILTER {
    if e is Call("$filter", [input, _]) {
      return input
    }
  }
  e
}

///|
fn aggregate_predicate(e : Expr) -> Expr? {
  if FEATURE_AGGREGATE_FILTER {
    if e is Call("$filter", [_, predicate]) {
      return Some(predicate)
    }
  }
  None
}

///|
fn prepare_filtered_argument(
  e : Expr,
  ctx : Evaluation,
  name : String,
  window : Bool,
  arity : Int32,
) -> Unit raise SqlError {
  guard FEATURE_AGGREGATE_FILTER else {
    fail("feature disabled: aggregateFilter")
  }
  guard aggregate_name(name, arity) && e is Call("$filter", [input, predicate]) else {
    fail("invalid aggregate FILTER")
  }
  if input is Call("$distinct", [value]) {
    guard !window && arity == 1 else {
      fail("invalid DISTINCT aggregate FILTER")
    }
    prepare_expression(value, ctx, false, false)
  } else if input is Star(_) {
    guard name == "count" else { fail("invalid aggregate FILTER *") }
  } else {
    prepare_expression(input, ctx, window, false)
  }
  prepare_expression(predicate, ctx, window, false)
}
