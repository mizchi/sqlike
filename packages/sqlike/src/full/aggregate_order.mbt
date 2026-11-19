///|
/// Reserved Call metadata keeps the v1 AST/wire layout. The required-feature
/// bit makes older binary readers reject a definition before applying its schema.
fn aggregate_orderings(e : Expr) -> Array[Ordering] raise SqlError {
  guard e is Call("$aggregate-order", [_, .. terms]) && !terms.is_empty() else {
    fail("invalid aggregate ORDER BY")
  }
  terms
  .to_owned()
  .map(term => {
    match term {
      Call("$sort-asc", [expression]) => { expression, descending: false, }
      Call("$sort-desc", [expression]) => { expression, descending: true, }
      _ => fail("invalid aggregate ORDER BY term")
    }
  })
}

///|
fn prepare_ordered_argument(
  e : Expr,
  ctx : Evaluation,
  name : String,
  window : Bool,
  arity : Int32,
) -> Unit raise SqlError {
  guard FEATURE_AGGREGATE_ORDER else {
    fail("feature disabled: aggregateOrderBy")
  }
  guard !window &&
    aggregate_name(name, arity) &&
    e is Call("$aggregate-order", [input, ..]) else {
    fail("ORDER BY requires a non-window aggregate")
  }
  let value = match input {
    Call("$distinct", [value]) => {
      guard arity == 1 else { fail("DISTINCT aggregates require one argument") }
      value
    }
    _ => input
  }
  prepare_expression(value, ctx, false, false)
  let orders = aggregate_orderings(e)
  for order in orders {
    prepare_expression(ordering_expression(order.expression), ctx, false, false)
  }
  if arity == 1 && orders.length() == 1 && name != "min" && name != "max" {
    ignore(
      aggregate_same_expression(
        value,
        ordering_expression(orders[0].expression),
        ctx,
      ),
    )
  }
}

///|
/// SQLite compares resolved expressions when sharing the DISTINCT/sort b-tree.
/// Equivalent column spelling/qualification must still choose the last value.
fn aggregate_same_expression(
  a : Expr,
  b : Expr,
  ctx : Evaluation,
) -> Bool raise SqlError {
  match (a, b) {
    (Column(aq, an), Column(bq, bn)) => {
      let a = resolve_context(ctx, aq, an)
      let b = resolve_context(ctx, bq, bn)
      if identifier(an) == identifier(bn) &&
        identifier(aq) != identifier(bq) &&
        (a.join_column is Some(_) || b.join_column is Some(_)) {
        // A USING column may refer to either physical input or a coalesce
        // expression. The environment does not retain that expression yet.
        fail("unsupported aggregate ordering of merged join columns")
      }
      identifier(a.qualifier) == identifier(b.qualifier) &&
      identifier(a.name) == identifier(b.name)
    }
    (Call(an, aa), Call(bn, ba)) =>
      an == bn &&
      aa.length() == ba.length() &&
      aa
      .iter()
      .zip(ba.iter())
      .all(p => aggregate_same_expression(p.0, p.1, ctx))
    (Unary(an, ae), Unary(bn, be))
    | (Collate(ae, an), Collate(be, bn))
    | (Cast(ae, an), Cast(be, bn)) =>
      an == bn && aggregate_same_expression(ae, be, ctx)
    (Binary(an, al, ar), Binary(bn, bl, br)) =>
      an == bn &&
      aggregate_same_expression(al, bl, ctx) &&
      aggregate_same_expression(ar, br, ctx)
    (Between(ae, al, ar), Between(be, bl, br)) =>
      aggregate_same_expression(ae, be, ctx) &&
      aggregate_same_expression(al, bl, ctx) &&
      aggregate_same_expression(ar, br, ctx)
    (Case(ab, aa, ao), Case(bb, ba, bo)) => {
      let base = match (ab, bb) {
        (Some(a), Some(b)) => aggregate_same_expression(a, b, ctx)
        (None, None) => true
        _ => false
      }
      base &&
      aa.length() == ba.length() &&
      aa
      .iter()
      .zip(ba.iter())
      .all(p => {
        aggregate_same_expression(p.0.0, p.1.0, ctx) &&
        aggregate_same_expression(p.0.1, p.1.1, ctx)
      }) &&
      aggregate_same_expression(ao, bo, ctx)
    }
    // SQLite does not share sorter keys with arguments containing subqueries.
    (ScalarSelect(_), _) | (Exists(_), _) | (InSelect(_, _), _) => false
    _ => @json.to_json(a) == @json.to_json(b)
  }
}

///|
priv struct OrderedAggregateEntry {
  values : Array[Value]
  keys : Array[Value]
  row : Environment
  sequence : Int32
}

///|
/// Materialize keys/arguments before stepping the aggregate, matching SQLite's
/// sorter. FILTER runs first; DISTINCT usually keeps the first input row. When
/// its single argument is also its sole ordering expression, the unique sorter
/// replaces an equal key with the last value (observable with NOCASE/RTRIM).
fn ordered_aggregate_entries(
  args : Array[Expr],
  ctx : Evaluation,
) -> (Array[Expr], Array[OrderedAggregateEntry]) raise SqlError {
  let wrapped = filter_input(args[0])
  guard wrapped is Call("$aggregate-order", [input, ..]) else {
    fail("invalid aggregate ORDER BY")
  }
  let orders = aggregate_orderings(wrapped)
  let distinct = input is Call("$distinct", _)
  let first = match input {
    Call("$distinct", [value]) => value
    _ => input
  }
  let expressions = args.copy()
  expressions[0] = first
  let predicate = aggregate_predicate(args[0])
  let collations = orders.map(o => {
    expression_collation(ordering_expression(o.expression), ctx)
  })
  let distinct_collation = expression_collation(first, ctx)
  let same = args.length() == 1 &&
    orders.length() == 1 &&
    aggregate_same_expression(
      first,
      ordering_expression(orders[0].expression),
      ctx,
    )
  let entries : Array[OrderedAggregateEntry] = []
  for sequence, row in ctx.group.unwrap_or([ctx.row]) {
    let here = { ..ctx, row, group: None, }
    if predicate is Some(p) && truth(evaluate(p, here)) != 1 {
      continue
    }
    let keys = orders.map(o => evaluate(ordering_expression(o.expression), here))
    let values = if same {
      [keys[0]]
    } else {
      expressions.map(e => evaluate(e, here))
    }
    let entry = { values, keys, row, sequence, }
    if distinct {
      let previous = entries.search_by(e => {
        compare_stored(ctx.store, e.values[0], values[0], distinct_collation) ==
        0
      })
      if previous is Some(i) {
        if same {
          entries[i] = entry
        }
        continue
      }
    }
    entries.push(entry)
  }
  entries.sort_by((a, b) => {
    for i, order in orders {
      let c = ordering_compare(
        ctx.store,
        order,
        a.keys[i],
        b.keys[i],
        collations[i],
      )
      if c != 0 {
        return c
      }
    }
    a.sequence.compare(b.sequence)
  })
  (expressions, entries)
}

///|
fn ordered_aggregate(
  name : String,
  args : Array[Expr],
  ctx : Evaluation,
) -> Value raise SqlError {
  // SQLite resolves min/max ordering terms but never evaluates or sorts them.
  if CAP_FUNCTION_AGGREGATES && (name == "min" || name == "max") {
    guard filter_input(args[0]) is Call("$aggregate-order", [input, ..]) else {
      fail("invalid aggregate ORDER BY")
    }
    let unwrapped = args.copy()
    unwrapped[0] = if aggregate_predicate(args[0]) is Some(p) {
      Call("$filter", [input, p])
    } else {
      input
    }
    return evaluate_call(name, unwrapped, ctx)
  }
  let (expressions, entries) = ordered_aggregate_entries(args, ctx)
  if FEATURE_SQL_JSON &&
    CAP_FUNCTION_JSON_AGGREGATE &&
    (name == "json_group_array" || name == "json_group_object") {
    return ordered_json_aggregate(name, expressions, entries, ctx)
  }
  if CAP_FUNCTION_GROUP_CONCAT &&
    (name == "group_concat" || name == "string_agg") {
    let out = @buffer.Buffer()
    let mut count = 0
    for entry in entries {
      if entry.values[0] is Null {
        continue
      }
      if count > 0 {
        out.write_bytes(
          @utf8.encode(
            if entry.values.length() == 2 {
              checked_text_value(entry.values[1])
            } else {
              ","
            },
          ),
        )
      }
      out.write_bytes(@utf8.encode(checked_text_value(entry.values[0])))
      count += 1
    }
    return if count == 0 {
      Null
    } else {
      Text(@utf8.decode_lossy(out.to_bytes()))
    }
  }
  guard CAP_FUNCTION_AGGREGATES else {
    fail("catalog capability disabled: aggregates")
  }
  if name == "count" {
    return Integer(
      entries.filter(e => !(e.values[0] is Null)).length().to_int64(),
    )
  }
  let sum = sum_state()
  for entry in entries {
    sum.add(entry.values[0])
  }
  sum.finish(name)
}
