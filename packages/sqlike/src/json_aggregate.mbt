///|
fn json_aggregate(
  name : String,
  args : Array[Expr],
  ctx : Evaluation,
) -> Value raise SqlError {
  let input = filter_input(args[0])
  let predicate = aggregate_predicate(args[0])
  let distinct = input is Call("$distinct", _)
  let arg = match input {
    Call("$distinct", [e]) => e
    _ => input
  }
  let seen : Array[Value] = []
  let array : Array[SqlJson] = []
  let object : Array[(String, SqlJson)] = []
  for row in ctx.group.unwrap_or([ctx.row]) {
    let here = { ..ctx, row, group: None, }
    if predicate is Some(p) && truth(evaluate(p, here)) != 1 {
      continue
    }
    let value = evaluate(arg, here)
    if distinct &&
      seen.any(v => {
        compare_stored(ctx.store, v, value, expression_collation(arg, here)) ==
        0
      }) {
      continue
    }
    if distinct {
      seen.push(value)
    }
    if name == "json_group_array" {
      array.push(json_argument(value, arg, here))
    } else {
      guard !(value is Null) else {
        fail("unsupported JSON aggregate NULL label")
      }
      guard !(value is Blob(_)) || ctx.store.encoding.unwrap_or(1) == 1 else {
        fail("unsupported JSON aggregate BLOB label encoding")
      }
      object.push(
        (
          checked_text_value(value),
          json_argument(evaluate(args[1], here), args[1], here),
        ),
      )
    }
  }
  Text(
    (if name == "json_group_array" {
      SqlJson::array(array)
    } else {
      SqlJson::object(object)
    }).stringify(),
  )
}
