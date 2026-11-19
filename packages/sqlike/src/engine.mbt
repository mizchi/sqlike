// Generated from canonical full engine; do not edit.
// Source SHA256: 061b923e5c9fbc6107f48f373658947c00d238509f0a2ab8c6eaf67954809d48

// Source: aggregate_filter.mbt

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
  if input is Call("$aggregate-order", _) {
    prepare_ordered_argument(input, ctx, name, window, arity)
  } else if input is Call("$distinct", [value]) {
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

// Source: aggregate_order.mbt

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

// Source: aggregate_plan.mbt

///|
/// A bounded shortcut for aggregates of physical columns/constants.
/// Resolve positions once, then share one row scan across the aggregates.
fn simple_aggregate(
  select : Selection,
  context : Evaluation,
  output : Environment,
  filter~ : ((StoredRow) -> Bool raise SqlError)? = None,
) -> Relation? raise SqlError {
  guard OPT_AGGREGATE_SCAN &&
    context.store.encoding.unwrap_or(1) == 1 &&
    select.sources.length() == 1 &&
    select.ctes.is_empty() &&
    context.ctes.length() == 0 &&
    !select.distinct &&
    select.groups.is_empty() &&
    select.having is Literal(Integer(1L)) &&
    (select.predicate is Literal(Integer(1L)) || filter is Some(_)) &&
    select.orders.is_empty() else {
    return None
  }
  let source = select.sources[0]
  guard !source.left &&
    source.right != Some(true) &&
    source.on is Literal(Integer(1L)) else {
    return None
  }
  let names : Array[String] = []
  let projections : Array[Projection] = []
  for p in select.projections {
    guard p.expression is Call(name, [arg]) &&
      ["count", "sum", "total", "avg"].contains(name) else {
      return None
    }
    names.push(name)
    projections.push({
      ..p,
      expression: if arg is Star(_) {
        Literal(Integer(1L))
      } else {
        arg
      },
    })
  }
  let mut physical : Table? = None
  for table in context.store.tables {
    if matches_identifier(table.name, identifier(source.name)) {
      physical = Some(table)
      break
    }
  }
  guard physical is Some(table) && !table.without_rowid else { return None }
  guard simple_projection({ ..select, projections, }, table, source.qualifier)
    is Some(plan) else {
    return None
  }
  guard rowid_value(select.limit, context.params) is Some(limit) &&
    rowid_value(select.offset, context.params) is Some(offset) else {
    return None
  }
  if limit == 0L {
    return Some({ rows: [], template: output, })
  }
  let states = names.map(_ => sum_state())
  let rows = ordered_rowid_rows(context.store, table)
  for block in rows.blocks {
    for row in block {
      if filter is Some(matches) && !matches(row) {
        continue
      }
      for i, field in plan {
        let value = match field {
          Stored(n) => row.values[n]
          RowidValue => Value::Integer(row.id)
          Constant(v) => v
        }
        if names[i] == "count" {
          if !(value is Null) {
            states[i].count += 1L
          }
        } else {
          states[i].add(value)
        }
      }
    }
  }
  let values : Array[Value] = names.mapi((i, name) => {
    if name == "count" {
      Integer(states[i].count)
    } else {
      states[i].finish(name)
    }
  })
  Some({
    rows: if offset > 0L {
      []
    } else {
      [output.mapi((i, b) => { ..b, value: values[i], })]
    },
    template: output,
  })
}

///|
fn ordered_rowid_rows(store : Store, table : Table) -> IndexRows raise SqlError {
  index_rows_for_fields(
    store,
    table,
    "\u{0}rowid:" + table.name,
    [{ column: -1, collation: "binary", descending: false, }],
    None,
  )
}

// Source: aggregate_representative.mbt

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

// Source: aggregate_sum.mbt

///|
/// Shared by general, window and physical-row aggregates. Mirrors SQLite's
/// compensated summation and delayed integer-overflow decision (func.c SumCtx).
priv struct SumState {
  mut integer : Int64
  mut real : Double
  mut error : Double
  mut approximate : Bool
  mut overflow : Bool
  mut count : Int64
}

///|
fn sum_state() -> SumState {
  {
    integer: 0L,
    real: 0.0,
    error: 0.0,
    approximate: false,
    overflow: false,
    count: 0L,
  }
}

///|
fn SumState::add_real(self : SumState, value : Double) -> Unit {
  let before = self.real
  let after = before + value
  self.error += if before.abs() > value.abs() {
    before - after + value
  } else {
    value - after + before
  }
  self.real = after
}

///|
fn SumState::init_real(self : SumState) -> Unit {
  if self.integer > -4503599627370496L && self.integer < 4503599627370496L {
    self.real = self.integer.to_double()
    self.error = 0.0
    self.approximate = true
    return
  }
  let small = self.integer % 16384L
  self.real = (self.integer - small).to_double()
  self.error = small.to_double()
  self.approximate = true
}

///|
fn SumState::add_integer(self : SumState, n : Int64) -> Unit {
  if n <= -4503599627370496L || n >= 4503599627370496L {
    let small = n % 16384L
    self.add_real((n - small).to_double())
    self.add_real(small.to_double())
  } else {
    self.add_real(n.to_double())
  }
}

///|
fn SumState::add(self : SumState, value : Value) -> Unit {
  if value is Null {
    return
  }
  self.count += 1L
  let value = aggregate_number(value)
  if value is Integer(n) {
    if !self.approximate {
      let next = self.integer + n
      if (n >= 0L && next >= self.integer) || (n < 0L && next < self.integer) {
        self.integer = next
        return
      }
      self.overflow = true
      self.init_real()
    }
    self.add_integer(n)
  } else {
    if !self.approximate {
      self.init_real()
    }
    self.overflow = false
    self.add_real(as_double(value))
  }
}

///|
fn SumState::finish(self : SumState, name : String) -> Value raise SqlError {
  if self.count == 0L {
    return if name == "total" { Real(0.0) } else { Null }
  }
  if name == "sum" && self.overflow {
    fail("integer overflow")
  }
  if name == "sum" && !self.approximate {
    return Integer(self.integer)
  }
  let result = if !self.approximate {
    self.integer.to_double()
  } else if self.error.is_finite() {
    self.real + self.error
  } else {
    self.real
  }
  sql_real(if name == "avg" { result / self.count.to_double() } else { result })
}

// Source: aot.mbt

///|
struct AotDatabase {
  connection : Connection?
  program : Program?
  error : String?
}

///|
fn AotDatabase::ready(
  db : AotDatabase,
) -> (Connection, Program) raise SqliteError {
  guard db.connection is Some(connection) && db.program is Some(program) else {
    raise sqlite_misuse(db.error.unwrap_or("invalid AOT connection"))
  }
  connection.healthy()
  (connection, program)
}

///|
fn public_error(error : Error) -> String {
  match error {
    SqliteError(msg=message, ..) => message
    SqlError(message) => message
    TriggerIgnore => "RAISE(IGNORE) escaped its trigger frame"
    TriggerAbort(message) => message
    _ => error.to_string()
  }
}

///|
fn aot_open(artifact : String, image : String) -> AotDatabase {
  try {
    let program = Program::load(artifact)
    let connection = Connection::from_program(program)
    let result : AotDatabase = {
      connection: Some(connection),
      program: Some(program),
      error: None,
    }
    if image != "" {
      if CAP_API_SNAPSHOT {
        aot_restore_checked(result, image)
      } else {
        raise sqlite_misuse("AOT snapshot API is disabled")
      }
    }
    result
  } catch {
    error =>
      { connection: None, program: None, error: Some(public_error(error)), }
  }
}

///|
fn aot_info(db : AotDatabase) -> String {
  try {
    let (connection, program) = db.ready()
    (
      {
        "programId": program.id,
        "schemaVersion": connection.database.store.cookie,
        "serial": connection.database.serial,
        "queryCount": program.queries.length(),
        "autocommit": connection.database.store.transactions.frames.is_empty(),
      } : Json).stringify()
  } catch {
    error => public_error_json(error).stringify()
  }
}

///|
fn public_error_json(error : Error) -> Json {
  let json : Json = { "error": public_error(error) }
  if (
      error is TriggerAbort(_) ||
      error
      is SqliteError(code=Constraint, extended=Some(ConstraintTrigger), ..)
    ) &&
    json is Object(fields) {
    fields["code"] = "SQLITE_CONSTRAINT_TRIGGER"
  }
  if public_error(error).contains("datatype constraint") &&
    json is Object(fields) {
    fields["code"] = "SQLITE_CONSTRAINT_DATATYPE"
  }
  json
}

///|
fn aot_execute(db : AotDatabase, name : String, bindings : String) -> String {
  try {
    let (connection, program) = db.ready()
    let query = program.query(name)
    let values : Array[Json] = @json.from_json(@json.parse(bindings))
    guard values.length() == query.plan.parameters else {
      raise sqlite_misuse("SQL binding count mismatch")
    }
    let statement = connection.prepare_compiled(query)
    defer (statement.finalize() catch { _ => () })
    // JSON owns these freshly decoded values; unlike the public typed binding
    // API, there is no caller-owned BLOB to copy or binding index to validate.
    for i, value in values {
      statement.parameters[i] = json_value(value)
    }
    let output = StringBuilder()
    output.write_string("{\"names\":[")
    for i, name in query.plan.names {
      if i > 0 {
        output.write_char(',')
      }
      output.write_string(Json::string(name).stringify())
    }
    output.write_string("],\"rows\":[")
    let mut first = true
    while statement.step() {
      if !first {
        output.write_char(',')
      }
      first = false
      write_result_row(output, statement.rows[statement.cursor])
    }
    output.write_string("],\"readonly\":")
    output.write_string(
      if data_readonly(query.plan.statement) {
        "true"
      } else {
        "false"
      },
    )
    output.write_string(",\"changes\":")
    output.write_string(
      connection_changes(connection.database.store).to_string(),
    )
    output.write_char('}')
    output.to_string()
  } catch {
    error => public_error_json(error).stringify()
  }
}

///|
fn aot_dump(db : AotDatabase) -> String {
  try {
    let (connection, program) = db.ready()
    (
      {
        "format": "moon-aot-image@1",
        "programId": program.id,
        "serial": connection.database.serial,
        "state": @json.to_json(connection.database.store),
      } : Json).stringify()
  } catch {
    error => ({ "error": public_error(error) } : Json).stringify()
  }
}

///|
fn aot_restore_checked(db : AotDatabase, image : String) -> Unit raise {
  let (connection, program) = db.ready()
  guard image.length() <= 67108864 else { fail("AOT image resource limit") }
  guard @json.parse(image)
    is {
      "format": "moon-aot-image@1",
      "programId": String(id),
      "serial": Number(serial, ..),
      "state": state,
      ..
    } &&
    id == program.id &&
    serial >= 0.0 &&
    serial <= 2147483647.0 &&
    serial.to_int().to_double() == serial else {
    fail("invalid AOT image/program identity")
  }
  let candidate : Store = @json.from_json(state)
  guard schema_identity(candidate) == schema_identity(program.schema) else {
    fail("AOT image schema mismatch")
  }
  validate_store_rows(candidate, storage=true)
  connection.database.store = candidate
  connection.database.serial = serial.to_int()
}

///|
fn aot_restore(db : AotDatabase, image : String) -> String {
  try {
    aot_restore_checked(db, image)
    "{}"
  } catch {
    error => ({ "error": public_error(error) } : Json).stringify()
  }
}

///|
fn aot_query_info(db : AotDatabase, name : String) -> String {
  try {
    let (_, program) = db.ready()
    let query = program.query(name).plan
    (
      {
        "parameters": query.parameters,
        "names": query.names,
        "readonly": data_readonly(query.statement),
      } : Json).stringify()
  } catch {
    error => ({ "error": public_error(error) } : Json).stringify()
  }
}

///|
fn aot_clone(db : AotDatabase) -> AotDatabase {
  try {
    let (connection, program) = db.ready()
    {
      connection: Some({
        database: database_clone(connection.database),
        program: Some(program),
        closed: false,
        statements: 0,
      }),
      program: Some(program),
      error: None,
    }
  } catch {
    error =>
      { connection: None, program: None, error: Some(public_error(error)), }
  }
}

///|
fn aot_delta(db : AotDatabase, force_snapshot : Bool) -> String {
  try {
    let (connection, program) = db.ready()
    (
      {
        "format": "aot-flush@1",
        "programId": program.id,
        "data": @json.parse(database_delta(connection.database, force_snapshot)),
      } : Json).stringify()
  } catch {
    error => ({ "error": public_error(error) } : Json).stringify()
  }
}

///|
fn aot_ack_delta(db : AotDatabase, serial : Int32) -> String {
  try {
    let (connection, _) = db.ready()
    database_ack_delta(connection.database, serial)
  } catch {
    error => ({ "error": public_error(error) } : Json).stringify()
  }
}

///|
fn aot_apply_delta(db : AotDatabase, text : String) -> String {
  try {
    let (connection, program) = db.ready()
    guard @json.parse(text)
      is { "format": "aot-flush@1", "programId": String(id), "data": data, .. } &&
      id == program.id else {
      fail("flush program mismatch")
    }
    let (store, serial, full) = decode_flush(
      connection.database,
      data.stringify(),
    )
    guard schema_identity(store) == schema_identity(program.schema) else {
      fail("flush schema mismatch")
    }
    if full {
      validate_store_rows(store, storage=true)
    }
    publish_flush(connection.database, store, serial)
    "{}"
  } catch {
    error => ({ "error": public_error(error) } : Json).stringify()
  }
}

///|
fn aot_set_clock(db : AotDatabase, milliseconds : String) -> String {
  try {
    let (connection, _) = db.ready()
    database_set_clock(connection.database, milliseconds)
  } catch {
    e => public_error_json(e).stringify()
  }
}

///|
fn aot_copy_connection_state(
  target : AotDatabase,
  source : AotDatabase,
) -> String {
  try {
    let (to, to_program) = target.ready()
    let (from, from_program) = source.ready()
    guard to_program.id == from_program.id else {
      fail("connection program mismatch")
    }
    database_copy_connection_state(to.database, from.database)
    "{}"
  } catch {
    e => ({ "error": public_error(e) } : Json).stringify()
  }
}

// Source: aot_native.mbt

///|
/// Experimental eager SELECT handle. Owns one Statement, never a result batch.
/// Fixed-schema metadata comes from Program; the action reads the live Store.
struct AotPreparedValues {
  mut statement : Statement?
  mut error : String?
}

///|
priv struct AotNativeResult {
  names : Array[String]
  rows : Array[Array[Value]]
  read_only : Bool
  changes : Int32
}

///|
fn aot_native_values(
  query : AotPreparedValues,
  bindings : Array[Value],
) -> Result[Array[Array[Value]], String] {
  try {
    if query.error is Some(message) {
      fail(message)
    }
    guard query.statement is Some(statement) else { fail("invalid AOT query") }
    statement.reset(clear_bindings=true)
    defer (statement.reset(clear_bindings=true) catch { _ => () })
    native_bind_statement(statement, bindings)
    Ok(native_statement_rows(statement))
  } catch {
    error => Err(public_error_json(error).stringify())
  }
}

///|
fn aot_native_execute(
  db : AotDatabase,
  name : String,
  bindings : Array[Value],
) -> Result[AotNativeResult, String] {
  try {
    let (connection, program) = db.ready()
    let query = program.query(name)
    let statement = connection.prepare_compiled(query)
    defer (statement.finalize() catch { _ => () })
    native_bind_statement(statement, bindings)
    let rows = native_statement_rows(statement)
    Ok({
      names: query.plan.names,
      rows,
      read_only: data_readonly(query.plan.statement),
      changes: connection_changes(connection.database.store),
    })
  } catch {
    error => Err(public_error_json(error).stringify())
  }
}

///|
fn native_bind_statement(
  statement : Statement,
  values : Array[Value],
) -> Unit raise SqliteError {
  guard values.length() == statement.parameters.length() else {
    raise sqlite_misuse("SQL binding count mismatch")
  }
  for i, value in values {
    statement.bind(index=i + 1, value)
  }
}

///|
fn native_statement_rows(
  statement : Statement,
) -> Array[Array[Value]] raise SqliteError {
  if statement.step() {
    statement.rows.map(row => row.filter(b => !b.hidden).map(b => b.value))
  } else {
    []
  }
}

///|
fn aot_prepare_values(db : AotDatabase, name : String) -> AotPreparedValues {
  try {
    let (connection, program) = db.ready()
    let query = program.query(name)
    guard query.plan.statement is PreparedSelect(_) else {
      fail("typed AOT results accept SELECT only")
    }
    { statement: Some(connection.prepare_compiled(query)), error: None, }
  } catch {
    error => { statement: None, error: Some(public_error(error)), }
  }
}

///|
fn aot_prepared_values(
  query : AotPreparedValues,
  bindings : String,
) -> Result[Array[Array[Value]], String] {
  try {
    if query.error is Some(message) {
      fail(message)
    }
    guard query.statement is Some(statement) else { fail("invalid AOT query") }
    statement.reset(clear_bindings=true)
    // Release row environments and bindings on success and every error path.
    // reset clears the prior step error before reporting it; retain the original.
    defer (statement.reset(clear_bindings=true) catch { _ => () })
    let values : Array[Json] = @json.from_json(@json.parse(bindings))
    guard values.length() == statement.parameters.length() else {
      raise sqlite_misuse("SQL binding count mismatch")
    }
    for i, value in values {
      statement.parameters[i] = json_value(value)
    }
    // step materializes the entire SELECT. Copy visible values once without
    // stepping each row again or exposing row environments to the native ABI.
    Ok(native_statement_rows(statement))
  } catch {
    error => Err(public_error(error))
  }
}

///|
fn aot_finalize_values(query : AotPreparedValues) -> String {
  try {
    if query.statement is Some(statement) {
      statement.finalize()
    }
    query.statement = None
    query.error = Some("statement is finalized")
    "{}"
  } catch {
    error => public_error_json(error).stringify()
  }
}

///|
/// Portable JSON boundary for the same reusable SELECT handle used by native JS.
/// No JS FFI or SQL parser is reachable from this API.
fn aot_prepared_execute(query : AotPreparedValues, bindings : String) -> String {
  match aot_prepared_values(query, bindings) {
    Err(message) => ({ "error": message } : Json).stringify()
    Ok(rows) => {
      guard query.statement is Some(statement) else {
        return ({ "error": "invalid AOT query" } : Json).stringify()
      }
      let output = StringBuilder()
      output.write_string("{\"names\":")
      output.write_string(@json.to_json(statement.names).stringify())
      output.write_string(",\"rows\":[")
      for i, row in rows {
        if i > 0 {
          output.write_char(',')
        }
        output.write_char('[')
        for j, value in row {
          if j > 0 {
            output.write_char(',')
          }
          write_result_cell(output, value)
        }
        output.write_char(']')
      }
      output.write_string("],\"readonly\":true,\"changes\":")
      output.write_string(
        connection_changes(statement.connection.database.store).to_string(),
      )
      output.write_char('}')
      output.to_string()
    }
  }
}

// Source: aot_snapshot.mbt

///|
/// A frozen row-page root; chunk encoding never builds a database-sized JSON tree.
struct AotSnapshot {
  store : Store?
  header : String
  seal : String
  parts : Int32
  incremental : Bool
  identity : String
  error : String?
}

///|
#derive(ToJson, FromJson)
priv struct AotSnapshotHeader {
  format : String
  programId : String
  serial : Int32
  parts : Int32
  rows : Array[Int32]
  blocks : Array[Int32]
  state : Store
}

///|
struct AotSnapshotReader {
  db : AotDatabase
  before : Store?
  base : Int32
  header : AotSnapshotHeader?
  seal : String
  mut next : Int32
  mut error : String?
  mut finished : Bool
}

///|
fn aot_snapshot_open(db : AotDatabase) -> AotSnapshot {
  snapshot_open(db, false)
}

///|
fn aot_snapshot_incremental(db : AotDatabase) -> AotSnapshot {
  snapshot_open(db, true)
}

///|
fn snapshot_open(db : AotDatabase, incremental : Bool) -> AotSnapshot {
  try {
    let (connection, program) = db.ready()
    let database = connection.database
    guard database_autocommit(database) && !database.store.deferred else {
      fail("cannot snapshot an active transaction")
    }
    let store = copy_store(database.store)
    guard !incremental ||
      schema_identity(store) == schema_identity(program.schema) else {
      fail("incremental snapshot schema mismatch")
    }
    // A retained checkpoint baseline needs row roots, not statement history or
    // execution caches (a large DELETE must not keep its removed rows alive).
    store.dirty = dirty_state()
    store.primary_indexes.clear()
    store.declaration_sources.clear()
    store.generated_plans.clear()
    let state = copy_store(store)
    let rows = store.tables.map(t => t.rows.length())
    let blocks = store.tables.map(t => t.rows.pages.length())
    let mut parts = 0
    for count in blocks {
      parts += count
    }
    for table in state.tables {
      table.rows = row_pages([])
    }
    let header : AotSnapshotHeader = {
      format: if incremental {
        "moon-aot-chunks@2"
      } else {
        "moon-aot-chunks@1"
      },
      programId: program.id,
      serial: database.serial,
      parts,
      rows,
      blocks,
      state,
    }
    let text = @json.to_json(header).stringify()
    guard @utf8.encode(text).length() <= 1048576 &&
      parts <= 100000 &&
      rows.all(count => count <= 100000) else {
      fail("logical snapshot resource limit")
    }
    {
      store: Some(store),
      header: text,
      seal: binary_hex(
        Bytes::from_array(@crypto.sha256(@utf8.encode(text))[:])[:],
      ),
      parts,
      incremental,
      identity: if incremental {
        program.id
      } else {
        ""
      },
      error: None,
    }
  } catch {
    e =>
      {
        store: None,
        header: "",
        seal: "",
        parts: 0,
        incremental,
        identity: "",
        error: Some(public_error(e)),
      }
  }
}

///|
fn aot_snapshot_info(snapshot : AotSnapshot) -> String {
  match snapshot.error {
    Some(error) => ({ "error": error } : Json).stringify()
    None => snapshot.header
  }
}

///|
fn snapshot_location(
  blocks : Array[Int32],
  index : Int32,
) -> (Int32, Int32) raise SqlError {
  guard index >= 0 else { fail("invalid logical chunk index") }
  let mut remaining = index
  for i, count in blocks {
    if remaining < count {
      return (i, remaining)
    }
    remaining -= count
  }
  fail("invalid logical chunk index")
}

///|
fn aot_snapshot_chunk(snapshot : AotSnapshot, index : Int32) -> SqliteResult {
  try {
    guard snapshot.store is Some(store) && index < snapshot.parts else {
      fail(snapshot.error.unwrap_or("invalid logical chunk index"))
    }
    let (table_index, block) = snapshot_location(
      store.tables.map(t => t.rows.pages.length()),
      index,
    )
    let table = store.tables[table_index]
    let rows : Array[StoredRow] = []
    for row in table.rows.pages[block].rows {
      if row is Some(row) {
        rows.push(persistent_generated_row(table, row))
      }
    }
    let w = binary_writer()
    if snapshot.incremental {
      Binary::write(snapshot.identity, w)
      Binary::write(table_index, w)
      Binary::write(block, w)
    } else {
      Binary::write(snapshot.seal, w)
      Binary::write(index, w)
    }
    Binary::write(rows, w)
    {
      data: binary_finish(w, if snapshot.incremental { 8 } else { 6 }),
      info: "{}",
    }
  } catch {
    e => { data: b"", info: ({ "error": public_error(e) } : Json).stringify(), }
  }
}

///|
fn aot_snapshot_restore(db : AotDatabase, text : String) -> AotSnapshotReader {
  try {
    let (connection, program) = db.ready()
    guard database_autocommit(connection.database) && text.length() <= 1048576 else {
      fail("invalid logical snapshot header/transaction")
    }
    let h : AotSnapshotHeader = @json.from_json(@json.parse(text))
    guard (h.format == "moon-aot-chunks@1" || h.format == "moon-aot-chunks@2") &&
      h.programId == program.id &&
      h.serial >= 0 &&
      h.rows.length() == h.state.tables.length() &&
      h.blocks.length() == h.rows.length() &&
      h.parts >= 0 &&
      h.parts <= 100000 &&
      schema_identity(h.state) == schema_identity(program.schema) &&
      !h.state.deferred else {
      fail("logical snapshot identity/metadata mismatch")
    }
    let mut parts = 0
    for i, table in h.state.tables {
      guard table.rows.is_empty() &&
        h.rows[i] >= 0 &&
        h.rows[i] <= 100000 &&
        h.blocks[i] >= 0 &&
        h.blocks[i] <= 100000 &&
        h.rows[i] <= h.blocks[i] * 64 else {
        fail("invalid logical snapshot row counts")
      }
      parts += h.blocks[i]
    }
    guard parts == h.parts else {
      fail("logical snapshot chunk count mismatch")
    }
    {
      db,
      before: Some(connection.database.store),
      base: connection.database.serial,
      header: Some(h),
      seal: if h.format == "moon-aot-chunks@2" {
        h.programId
      } else {
        binary_hex(Bytes::from_array(@crypto.sha256(@utf8.encode(text))[:])[:])
      },
      next: 0,
      error: None,
      finished: false,
    }
  } catch {
    e =>
      {
        db,
        before: None,
        base: 0,
        header: None,
        seal: "",
        next: 0,
        error: Some(public_error(e)),
        finished: false,
      }
  }
}

///|
fn aot_snapshot_supply(reader : AotSnapshotReader, bytes : Bytes) -> String {
  try {
    guard reader.error is None && !reader.finished && reader.header is Some(h) else {
      fail(reader.error.unwrap_or("logical snapshot reader is closed"))
    }
    let (table, block) = snapshot_location(h.blocks, reader.next)
    let incremental = h.format == "moon-aot-chunks@2"
    let r = binary_reader(bytes, if incremental { 8 } else { 6 }, 67108864)
    let seal : String = Binary::read(r)
    let index : Int32 = Binary::read(r)
    let location_ok = if incremental {
      let encoded_block : Int32 = Binary::read(r)
      index == table && encoded_block == block
    } else {
      index == reader.next
    }
    let rows : Array[StoredRow] = Binary::read(r)
    r.finish()
    guard seal == reader.seal &&
      location_ok &&
      rows.length() <= 64 &&
      h.state.tables[table].rows.length() + rows.length() <= h.rows[table] else {
      fail("logical snapshot chunk identity/order mismatch")
    }
    for row in rows {
      h.state.tables[table].rows.push(row)
    }
    reader.next += 1
    "{}"
  } catch {
    e => {
      let message = public_error(e)
      reader.error = Some(message)
      ({ "error": message } : Json).stringify()
    }
  }
}

///|
fn aot_snapshot_finish(reader : AotSnapshotReader) -> String {
  try {
    guard reader.error is None &&
      !reader.finished &&
      reader.header is Some(h) &&
      reader.before is Some(before) else {
      fail(reader.error.unwrap_or("logical snapshot reader is closed"))
    }
    let (connection, _) = reader.db.ready()
    guard database_autocommit(connection.database) &&
      connection.database.serial == reader.base &&
      physical_equal(connection.database.store, before) &&
      reader.next == h.parts else {
      fail("logical snapshot incomplete or connection changed")
    }
    for i, table in h.state.tables {
      guard table.rows.length() == h.rows[i] else {
        fail("logical snapshot missing rows")
      }
    }
    validate_store_rows(h.state, storage=true)
    publish_flush(connection.database, h.state, h.serial)
    reader.finished = true
    "{}"
  } catch {
    e => {
      let message = public_error(e)
      reader.error = Some(message)
      ({ "error": message } : Json).stringify()
    }
  }
}

///|
fn aot_snapshot_supply_base64(
  reader : AotSnapshotReader,
  bytes : String,
) -> String {
  aot_snapshot_supply(reader, @base64.decode(bytes)) catch {
    e => {
      let message = public_error(e)
      reader.error = Some(message)
      ({ "error": message } : Json).stringify()
    }
  }
}

///|
/// Reuse only page roots frozen by the same program/schema. Returns the old
/// global index, since growth in an earlier table can move later indices.
fn aot_snapshot_reuse(
  current : AotSnapshot,
  before : AotSnapshot,
  index : Int32,
) -> Int32 {
  try {
    guard current.incremental &&
      before.incremental &&
      current.identity == before.identity &&
      current.store is Some(store) &&
      before.store is Some(old) else {
      return -1
    }
    let (table, block) = snapshot_location(
      store.tables.map(t => t.rows.pages.length()),
      index,
    )
    guard table < old.tables.length() &&
      block < old.tables[table].rows.pages.length() &&
      physical_equal(
        store.tables[table].rows.pages[block],
        old.tables[table].rows.pages[block],
      ) else {
      return -1
    }
    let mut previous = block
    for i in 0..<table {
      previous += old.tables[i].rows.pages.length()
    }
    previous
  } catch {
    _ => -1
  }
}

// Source: api_config.mbt

///|
const CAP_API_SNAPSHOT : Bool = false

// Source: binary_base64.mbt

///|
// Wasm GC Bytes are opaque references at the JS boundary. These explicit
// transfer functions preserve the same binary format through the string ABI.
fn defined_open_base64(
  schema : String,
  statements : String,
  image : String,
) -> DefinedDatabase {
  try {
    guard schema.length() <= 1398104 &&
      statements.length() <= 1398104 &&
      image.length() <= 89478488 else {
      fail("binary transfer resource limit")
    }
    defined_open(
      @base64.decode(schema),
      @base64.decode(statements),
      @base64.decode(image),
    )
  } catch {
    e =>
      {
        core: { connection: None, program: None, error: Some(public_error(e)), },
        schema_id: "",
      }
  }
}

///|
fn binary_data_base64(result : BinaryResult) -> String {
  @base64.encode(result.data)
}

///|
fn defined_restore_base64(db : DefinedDatabase, text : String) -> String {
  try {
    guard text.length() <= 89478488 else {
      fail("binary transfer resource limit")
    }
    defined_restore(db, @base64.decode(text))
  } catch {
    e => ({ "error": public_error(e) } : Json).stringify()
  }
}

///|
fn defined_apply_delta_base64(db : DefinedDatabase, text : String) -> String {
  try {
    guard text.length() <= 89478488 else {
      fail("binary transfer resource limit")
    }
    defined_apply_delta(db, @base64.decode(text))
  } catch {
    e => ({ "error": public_error(e) } : Json).stringify()
  }
}

// Source: binary_catalog.mbt

///|
struct BinaryCatalog {
  schema : Bytes
  statements : Bytes
  storage : Bytes
  error : String
}

///|
struct BinaryResult {
  data : Bytes
  error : String
  full : Bool
  serial : Int32
}

///|
struct DefinedDatabase {
  core : AotDatabase
  schema_id : String
}

///|
// Build-only bridge. New runtime entry points never reference this JSON reader.
fn pack_program_binary(artifact : String) -> BinaryCatalog {
  try {
    guard artifact.length() <= 1048576 else {
      fail("compiled program resource limit")
    }
    let compiled : CompiledProgram = @json.from_json(@json.parse(artifact))
    ignore(prepare_compiled_program(compiled, ""))
    // The legacy compiler omits declaration spelling when no metadata query
    // needs it. Recover it at build time so schema identity depends on DDL,
    // independently of which prepared statements the application includes.
    for table in compiled.schema.tables {
      guard parse_statement(lex(table.sql)) is CreateTable(definition, _) &&
        definition.columns.length() == table.columns.length() else {
        fail("binary schema declaration mismatch")
      }
      for i, column in table.columns {
        guard column.name == definition.columns[i].name else {
          fail("binary schema column mismatch")
        }
        column.default_source = definition.columns[i].default_source
      }
    }
    let schema_writer = binary_writer()
    Binary::write(compiled.schema, schema_writer)
    let initial_rows = compiled.schema.tables.any(t => !t.rows.is_empty())
    if initial_rows {
      Binary::write(
        compiled.schema.tables.map(t => {
          t.rows.map(row => persistent_generated_row(t, row))
        }),
        schema_writer,
      )
    }
    // Kind 1 stays byte-compatible for empty definitions. Older readers reject
    // kind 7 rather than silently opening a populated catalog as an empty DB.
    let schema = binary_finish(schema_writer, if initial_rows { 7 } else { 1 })
    let schema_id = binary_id(schema)
    let query_writer = binary_writer()
    Binary::write(schema_id, query_writer)
    Binary::write(compiled.queries, query_writer)
    let statements = binary_finish(query_writer, 2)
    let storage = match compiled.storage {
      None => b""
      Some(plan) => {
        let w = binary_writer()
        Binary::write(schema_id, w)
        Binary::write(plan.format, w)
        Binary::write(plan.page_size, w)
        Binary::write(@base64.decode(plan.image), w)
        Binary::write(plan.trees, w)
        binary_finish(w, 3)
      }
    }
    { schema, statements, storage, error: "", }
  } catch {
    e => { schema: b"", statements: b"", storage: b"", error: public_error(e), }
  }
}

///|
fn binary_catalog_schema(catalog : BinaryCatalog) -> Bytes {
  catalog.schema
}

///|
fn binary_catalog_statements(catalog : BinaryCatalog) -> Bytes {
  catalog.statements
}

///|
fn binary_catalog_storage(catalog : BinaryCatalog) -> Bytes {
  catalog.storage
}

///|
fn binary_catalog_info(catalog : BinaryCatalog) -> String {
  if catalog.error != "" {
    return ({ "error": catalog.error } : Json).stringify()
  }
  (
    {
      "format": "sqlike-defined@1",
      "schemaId": binary_id(catalog.schema),
      "programId": binary_id(catalog.statements),
    } : Json).stringify()
}

///|
fn binary_program(
  schema : Bytes,
  statements : Bytes,
) -> (Program, String) raise SqlError {
  let kind = if schema.length() > 5 && schema[5] == b'\x07' { 7 } else { 1 }
  let schema_reader = binary_reader(schema, kind, 1048576)
  let store : Store = Binary::read(schema_reader)
  if kind == 7 {
    let rows : Array[Array[StoredRow]] = Binary::read(schema_reader)
    guard rows.length() == store.tables.length() &&
      rows.any(rs => !rs.is_empty()) else {
      fail("invalid initial catalog rows")
    }
    for i, table in store.tables {
      table.rows = row_pages(rows[i])
    }
  }
  schema_reader.finish()
  let schema_id = binary_id(schema)
  let query_reader = binary_reader(statements, 2, 1048576)
  let required_schema : String = Binary::read(query_reader)
  guard required_schema == schema_id else {
    fail("prepared statement schema mismatch")
  }
  let queries : Array[CompiledQuery] = Binary::read(query_reader)
  query_reader.finish()
  for table in store.tables {
    let ctx = evaluation(
      store,
      [],
      row_environment(
        table,
        { id: 0L, values: Array::make(table.columns.length(), Null), },
        table.name,
      ),
    )
    validate_generated_table(store, table)
    for column in table.columns {
      if FEATURE_GENERATED_COLUMNS && generated_column(column) {
        continue
      }
      prepare_default(store, column)
    }
    for check in table.checks {
      prepare_expression(check, ctx, false, false)
    }
    prepare_foreign_table(store, table)
  }
  for object in store.objects {
    if object.kind == "trigger" {
      prepare_trigger(store, get_table(store, object.table), object)
    }
  }
  let program = prepare_compiled_program(
    { format: "moon-aot@1", schema: store, queries, storage: None, },
    binary_id(statements),
  )
  (program, schema_id)
}

///|
/// Load fixed schema and named prepared queries without parsing SQL or JSON.
fn Program::load_binary(
  schema : Bytes,
  statements : Bytes,
) -> Program raise SqliteError {
  binary_program(schema, statements).0 catch {
    error => raise interface_error(public_error(error))
  }
}

///|
fn defined_open(
  schema : Bytes,
  statements : Bytes,
  image : Bytes,
) -> DefinedDatabase {
  try {
    let (program, schema_id) = binary_program(schema, statements)
    let core : AotDatabase = {
      connection: Some(Connection::from_program(program)),
      program: Some(program),
      error: None,
    }
    let db = { core, schema_id, }
    if !image.is_empty() {
      defined_restore_checked(db, image)
    }
    db
  } catch {
    e =>
      {
        core: { connection: None, program: None, error: Some(public_error(e)), },
        schema_id: "",
      }
  }
}

///|
fn defined_info(db : DefinedDatabase) -> String {
  try {
    let (connection, program) = db.core.ready()
    (
      {
        "schemaId": db.schema_id,
        "programId": program.id,
        "serial": connection.database.serial,
        "schemaVersion": connection.database.store.cookie,
        "queryCount": program.queries.length(),
        "autocommit": database_autocommit(connection.database),
      } : Json).stringify()
  } catch {
    e => ({ "error": public_error(e) } : Json).stringify()
  }
}

///|
fn defined_execute(
  db : DefinedDatabase,
  name : String,
  bindings : String,
) -> String {
  aot_execute(db.core, name, bindings)
}

///|
fn defined_query_info(db : DefinedDatabase, name : String) -> String {
  aot_query_info(db.core, name)
}

///|
fn defined_set_clock(db : DefinedDatabase, millis : String) -> String {
  aot_set_clock(db.core, millis)
}

///|
fn defined_clone(db : DefinedDatabase) -> DefinedDatabase {
  { core: aot_clone(db.core), schema_id: db.schema_id, }
}

///|
fn defined_copy_connection_state(
  target : DefinedDatabase,
  source : DefinedDatabase,
) -> String {
  aot_copy_connection_state(target.core, source.core)
}

///|
fn defined_ack_delta(db : DefinedDatabase, serial : Int32) -> String {
  aot_ack_delta(db.core, serial)
}

///|
fn binary_data(result : BinaryResult) -> Bytes {
  result.data
}

///|
fn binary_info(result : BinaryResult) -> String {
  if result.error != "" {
    ({ "error": result.error } : Json).stringify()
  } else {
    (
      {
        "full": result.full,
        "serial": result.serial,
        "bytes": result.data.length(),
      } : Json).stringify()
  }
}

// Source: binary_generated.mbt
// Generated from src/binary-wire.json by generate-binary-codecs.ts.
// Contract SHA256: f3e811d415bf6e48620b30d666547b023504647406200f3b8e0f9abbe367dd96
// Capability SHA256: 29619c2e072435a6815a66a53f186049bab9599699b36935570352fe81d0b0be
// Numeric variant tags and ordered fields are the versioned wire contract.

///|
impl Binary for Ordering with fn write(value, w) {
  Binary::write(value.expression, w)
  Binary::write(value.descending, w)
}

///|
impl Binary for Ordering with fn read(r) {
  r.enter()
  defer r.leave()
  let expression : Expr = Binary::read(r)
  let descending : Bool = Binary::read(r)
  let value : Ordering = { expression, descending, }

  value
}

///|
impl Binary for Projection with fn write(value, w) {
  Binary::write(value.expression, w)
  Binary::write(value.explicit_label, w)
  Binary::write(value.label, w)
}

///|
impl Binary for Projection with fn read(r) {
  r.enter()
  defer r.leave()
  let expression : Expr = Binary::read(r)
  let explicit_label : Bool = Binary::read(r)
  let label : String = Binary::read(r)
  let value : Projection = { expression, explicit_label, label, }

  value
}

///|
impl Binary for Source with fn write(value, w) {
  if value.right == Some(true) ||
    value.natural == Some(true) ||
    value.using_columns.unwrap_or([]).length() > 0 {
    w.require_feature(8U)
  }
  Binary::write(value.name, w)
  Binary::write(value.qualifier, w)
  Binary::write(value.left, w)
  Binary::write(value.right, w)
  Binary::write(value.using_columns, w)
  Binary::write(value.natural, w)
  Binary::write(value.on, w)
}

///|
impl Binary for Source with fn read(r) {
  if CAP_QUERY_SOURCE {
    r.enter()
    defer r.leave()
    let name : String = Binary::read(r)
    let qualifier : String = Binary::read(r)
    let left : Bool = Binary::read(r)
    let right : Bool? = Binary::read(r)
    let using_columns : Array[String]? = Binary::read(r)
    let natural : Bool? = Binary::read(r)
    let on : Expr = Binary::read(r)
    let value : Source = {
      name,
      qualifier,
      left,
      right,
      using_columns,
      natural,
      on,
    }
    if value.right == Some(true) ||
      value.natural == Some(true) ||
      value.using_columns.unwrap_or([]).length() > 0 {
      r.require_feature(8U)
    }
    value
  } else {
    fail("catalog capability disabled: query source")
  }
}

///|
impl Binary for Selection with fn write(value, w) {
  Binary::write(value.ctes, w)
  Binary::write(value.projections, w)
  Binary::write(value.sources, w)
  Binary::write(value.predicate, w)
  Binary::write(value.groups, w)
  Binary::write(value.having, w)
  Binary::write(value.orders, w)
  Binary::write(value.limit, w)
  Binary::write(value.offset, w)
  Binary::write(value.distinct, w)
  Binary::write(value.compound, w)
  Binary::write(value.recursive, w)
  Binary::write(value.cte_names, w)
}

///|
impl Binary for Selection with fn read(r) {
  r.enter()
  defer r.leave()
  let ctes : Array[(String, Selection)] = Binary::read(r)
  let projections : Array[Projection] = Binary::read(r)
  let sources : Array[Source] = Binary::read(r)
  let predicate : Expr = Binary::read(r)
  let groups : Array[Expr] = Binary::read(r)
  let having : Expr = Binary::read(r)
  let orders : Array[Ordering] = Binary::read(r)
  let limit : Expr = Binary::read(r)
  let offset : Expr = Binary::read(r)
  let distinct : Bool = Binary::read(r)
  let compound : Array[(String, Selection)]? = Binary::read(r)
  let recursive : Bool? = Binary::read(r)
  let cte_names : Array[(String, Array[String])]? = Binary::read(r)
  let value : Selection = {
    ctes,
    projections,
    sources,
    predicate,
    groups,
    having,
    orders,
    limit,
    offset,
    distinct,
    compound,
    recursive,
    cte_names,
  }

  value
}

///|
impl Binary for ForeignKey with fn write(value, w) {
  w.require_feature(1U)
  Binary::write(value.column, w)
  Binary::write(value.parent, w)
  Binary::write(value.target, w)
  Binary::write(value.cascade, w)
  Binary::write(value.columns, w)
  Binary::write(value.targets, w)
  Binary::write(value.delete_action, w)
  Binary::write(value.update_action, w)
  Binary::write(value.initially_deferred, w)
}

///|
impl Binary for ForeignKey with fn read(r) {
  if FEATURE_FOREIGN_KEYS {
    r.enter()
    defer r.leave()
    let column : Int32 = Binary::read(r)
    let parent : String = Binary::read(r)
    let target : String = Binary::read(r)
    let cascade : Bool = Binary::read(r)
    let columns : Array[Int32]? = Binary::read(r)
    let targets : Array[String]? = Binary::read(r)
    let delete_action : String? = Binary::read(r)
    let update_action : String? = Binary::read(r)
    let initially_deferred : Bool? = Binary::read(r)
    let value : ForeignKey = {
      column,
      parent,
      target,
      cascade,
      columns,
      targets,
      delete_action,
      update_action,
      initially_deferred,
    }
    r.require_feature(1U)
    value
  } else {
    fail("feature disabled: foreignKeys")
  }
}

///|
impl Binary for ColumnDef with fn write(value, w) {
  Binary::write(value.name, w)
  Binary::write(value.declared, w)
  Binary::write(value.not_null, w)
  Binary::write(value.primary, w)
  Binary::write(value.primary_desc, w)
  Binary::write(value.default_value, w)
  Binary::write(value.default_source, w)
  Binary::write(value.collation, w)
}

///|
impl Binary for ColumnDef with fn read(r) {
  r.enter()
  defer r.leave()
  let name : String = Binary::read(r)
  let declared : String = Binary::read(r)
  let not_null : Bool = Binary::read(r)
  let primary : Int32 = Binary::read(r)
  let primary_desc : Bool? = Binary::read(r)
  let default_value : Expr = Binary::read(r)
  let default_source : String? = Binary::read(r)
  let collation : String = Binary::read(r)
  let value : ColumnDef = {
    name,
    declared,
    not_null,
    primary,
    primary_desc,
    default_value,
    default_source,
    collation,
  }

  value
}

///|
impl Binary for Table with fn write(value, w) {
  if value.strict == Some(true) {
    w.require_feature(4U)
  }
  Binary::write(value.name, w)
  Binary::write(value.sql, w)
  Binary::write(value.columns, w)
  Binary::write(value.unique_keys, w)
  Binary::write(value.checks, w)
  Binary::write(value.foreign_keys, w)
  Binary::write(value.without_rowid, w)
  Binary::write(value.strict, w)
  Binary::write(value.autoincrement, w)
}

///|
impl Binary for Table with fn read(r) {
  r.enter()
  defer r.leave()
  let name : String = Binary::read(r)
  let sql : String = Binary::read(r)
  let columns : Array[ColumnDef] = Binary::read(r)
  let unique_keys : Array[Array[Int32]] = Binary::read(r)
  let checks : Array[Expr] = Binary::read(r)
  let foreign_keys : Array[ForeignKey] = Binary::read(r)
  let without_rowid : Bool = Binary::read(r)
  let strict : Bool? = Binary::read(r)
  let autoincrement : Bool = Binary::read(r)
  let value : Table = {
    name,
    sql,
    columns,
    unique_keys,
    checks,
    foreign_keys,
    without_rowid,
    strict,
    autoincrement,
    sequence: 0L,
    sequence_present: None,
    rows: row_pages([]),
  }
  if value.strict == Some(true) {
    r.require_feature(4U)
  }
  value
}

///|
impl Binary for SchemaObject with fn write(value, w) {
  Binary::write(value.kind, w)
  Binary::write(value.name, w)
  Binary::write(value.table, w)
  Binary::write(value.sql, w)
  Binary::write(value.unique, w)
  Binary::write(value.columns, w)
  Binary::write(value.query, w)
  Binary::write(value.selection, w)
  Binary::write(value.index_terms, w)
  Binary::write(value.index_predicate, w)
  Binary::write(value.trigger, w)
}

///|
impl Binary for SchemaObject with fn read(r) {
  r.enter()
  defer r.leave()
  let kind : String = Binary::read(r)
  let name : String = Binary::read(r)
  let table : String = Binary::read(r)
  let sql : String = Binary::read(r)
  let unique : Bool = Binary::read(r)
  let columns : Array[String] = Binary::read(r)
  let query : String = Binary::read(r)
  let selection : Selection? = Binary::read(r)
  let index_terms : Array[Ordering]? = Binary::read(r)
  let index_predicate : Expr? = Binary::read(r)
  let trigger : TriggerDefinition? = Binary::read(r)
  let value : SchemaObject = {
    kind,
    name,
    table,
    sql,
    unique,
    columns,
    query,
    selection,
    index_terms,
    index_predicate,
    trigger,
  }

  value
}

///|
impl Binary for Store with fn write(value, w) {
  Binary::write(value.encoding, w)
  Binary::write(value.tables, w)
  Binary::write(value.objects, w)
  Binary::write(value.cookie, w)
  Binary::write(value.foreign_keys, w)
}

///|
impl Binary for Store with fn read(r) {
  r.enter()
  defer r.leave()
  let encoding : Int32? = Binary::read(r)
  let tables : Array[Table] = Binary::read(r)
  let objects : Array[SchemaObject] = Binary::read(r)
  let cookie : Int32 = Binary::read(r)
  let foreign_keys : Bool = Binary::read(r)
  let value : Store = {
    encoding,
    tables,
    objects,
    cookie,
    foreign_keys,
    changes: 0,
    last_rowid: 0L,
    deferred: false,
    indexes: Map([]),
    primary_indexes: Map([]),
    declaration_sources: Map([]),
    generated_plans: Map([]),
    dirty: dirty_state(),
    transactions: transaction_runtime(),
    triggers: trigger_runtime(),
  }

  value
}

///|
impl Binary for Insertion with fn write(value, w) {
  Binary::write(value.table, w)
  Binary::write(value.columns, w)
  Binary::write(value.values, w)
  Binary::write(value.conflict, w)
  Binary::write(value.target, w)
  Binary::write(value.updates, w)
  Binary::write(value.predicate, w)
  Binary::write(value.returning, w)
  Binary::write(value.conflict_override, w)
  Binary::write(value.target_predicate, w)
  Binary::write(value.selection, w)
}

///|
impl Binary for Insertion with fn read(r) {
  r.enter()
  defer r.leave()
  let table : String = Binary::read(r)
  let columns : Array[String] = Binary::read(r)
  let values : Array[Array[Expr]] = Binary::read(r)
  let conflict : String = Binary::read(r)
  let target : Array[String] = Binary::read(r)
  let updates : Array[(String, Expr)] = Binary::read(r)
  let predicate : Expr = Binary::read(r)
  let returning : Array[Projection] = Binary::read(r)
  let conflict_override : String? = Binary::read(r)
  let target_predicate : Expr? = Binary::read(r)
  let selection : Selection? = Binary::read(r)
  let value : Insertion = {
    table,
    columns,
    values,
    conflict,
    target,
    updates,
    predicate,
    returning,
    conflict_override,
    target_predicate,
    selection,
  }

  value
}

///|
impl Binary for TriggerDefinition with fn write(value, w) {
  w.require_feature(2U)
  Binary::write(value.timing, w)
  Binary::write(value.event, w)
  Binary::write(value.columns, w)
  Binary::write(value.condition, w)
  Binary::write(value.body, w)
}

///|
impl Binary for TriggerDefinition with fn read(r) {
  if FEATURE_TRIGGERS {
    r.enter()
    defer r.leave()
    let timing : String = Binary::read(r)
    let event : String = Binary::read(r)
    let columns : Array[String] = Binary::read(r)
    let condition : Expr = Binary::read(r)
    let body : Array[DataStatement] = Binary::read(r)
    let value : TriggerDefinition = { timing, event, columns, condition, body, }
    r.require_feature(2U)
    value
  } else {
    fail("feature disabled: triggers")
  }
}

///|
impl Binary for WindowFrame with fn write(value, w) {
  Binary::write(value.kind, w)
  Binary::write(value.start, w)
  Binary::write(value.end, w)
}

///|
impl Binary for WindowFrame with fn read(r) {
  r.enter()
  defer r.leave()
  let kind : String = Binary::read(r)
  let start : WindowBound = Binary::read(r)
  let end : WindowBound = Binary::read(r)
  let value : WindowFrame = { kind, start, end, }

  value
}

///|
impl Binary for CompiledQuery with fn write(value, w) {
  Binary::write(value.name, w)
  Binary::write(value.parameters, w)
  Binary::write(value.names, w)
  Binary::write(value.statement, w)
}

///|
impl Binary for CompiledQuery with fn read(r) {
  r.enter()
  defer r.leave()
  let name : String = Binary::read(r)
  let parameters : Int32 = Binary::read(r)
  let names : Array[String] = Binary::read(r)
  let statement : DataStatement = Binary::read(r)
  let value : CompiledQuery = { name, parameters, names, statement, }

  value
}

///|
impl Binary for StoredRow with fn write(value, w) {
  Binary::write(value.id, w)
  Binary::write(value.values, w)
}

///|
impl Binary for StoredRow with fn read(r) {
  r.enter()
  defer r.leave()
  let id : Int64 = Binary::read(r)
  let values : Array[Value] = Binary::read(r)
  let value : StoredRow = { id, values, }

  value
}

///|
impl Binary for StorageTree with fn write(value, w) {
  Binary::write(value.name, w)
  Binary::write(value.table, w)
  Binary::write(value.root, w)
  Binary::write(value.kind, w)
  Binary::write(value.fields, w)
  Binary::write(value.predicate, w)
}

///|
impl Binary for StorageTree with fn read(r) {
  r.enter()
  defer r.leave()
  let name : String = Binary::read(r)
  let table : String = Binary::read(r)
  let root : Int32 = Binary::read(r)
  let kind : String = Binary::read(r)
  let fields : Array[StorageField] = Binary::read(r)
  let predicate : Expr? = Binary::read(r)
  let value : StorageTree = { name, table, root, kind, fields, predicate, }

  value
}

///|
impl Binary for StorageField with fn write(value, w) {
  Binary::write(value.column, w)
  Binary::write(value.collation, w)
  Binary::write(value.descending, w)
  Binary::write(value.expression, w)
}

///|
impl Binary for StorageField with fn read(r) {
  r.enter()
  defer r.leave()
  let column : Int32 = Binary::read(r)
  let collation : String = Binary::read(r)
  let descending : Bool = Binary::read(r)
  let expression : Expr? = Binary::read(r)
  let value : StorageField = { column, collation, descending, expression, }

  value
}

///|
impl Binary for Expr with fn write(value, w) {
  match value {
    Literal(v0) => {
      w.uint(0U)

      Binary::write(v0, w)
    }
    TruthLiteral(v0) => {
      w.uint(1U)

      Binary::write(v0, w)
    }
    CurrentTime(v0) => {
      w.uint(2U)
      w.require_feature(32U)
      Binary::write(v0, w)
    }
    Parameter(v0) => {
      w.uint(3U)

      Binary::write(v0, w)
    }
    Column(v0, v1) => {
      w.uint(4U)

      Binary::write(v0, w)
      Binary::write(v1, w)
    }
    Star(v0) => {
      w.uint(5U)

      Binary::write(v0, w)
    }
    Unary(v0, v1) => {
      w.uint(6U)

      Binary::write(v0, w)
      Binary::write(v1, w)
    }
    Binary(v0, v1, v2) => {
      w.uint(7U)

      Binary::write(v0, w)
      Binary::write(v1, w)
      Binary::write(v2, w)
    }
    Call(v0, v1) => {
      w.uint(8U)
      w.require_feature(function_features(v0))
      Binary::write(v0, w)
      Binary::write(v1, w)
    }
    Collate(v0, v1) => {
      w.uint(9U)

      Binary::write(v0, w)
      Binary::write(v1, w)
    }
    Cast(v0, v1) => {
      w.uint(10U)

      Binary::write(v0, w)
      Binary::write(v1, w)
    }
    RowNumber(v0) => {
      w.uint(11U)
      w.require_feature(64U)
      Binary::write(v0, w)
    }
    Window(v0, v1, v2, v3, v4) => {
      w.uint(12U)
      w.require_feature(64U)
      Binary::write(v0, w)
      Binary::write(v1, w)
      Binary::write(v2, w)
      Binary::write(v3, w)
      Binary::write(v4, w)
    }
    Between(v0, v1, v2) => {
      w.uint(13U)

      Binary::write(v0, w)
      Binary::write(v1, w)
      Binary::write(v2, w)
    }
    Case(v0, v1, v2) => {
      w.uint(14U)

      Binary::write(v0, w)
      Binary::write(v1, w)
      Binary::write(v2, w)
    }
    InSelect(v0, v1) => {
      w.uint(15U)

      Binary::write(v0, w)
      Binary::write(v1, w)
    }
    ScalarSelect(v0) => {
      w.uint(16U)

      Binary::write(v0, w)
    }
    Exists(v0) => {
      w.uint(17U)

      Binary::write(v0, w)
    }
  }
}

///|
impl Binary for Expr with fn read(r) {
  r.enter()
  defer r.leave()
  match r.uint() {
    0U => {
      let v0 : Value = Binary::read(r)

      Literal(v0)
    }
    1U => {
      let v0 : Bool = Binary::read(r)

      TruthLiteral(v0)
    }
    2U => {
      let v0 : String = Binary::read(r)
      r.require_feature(32U)
      CurrentTime(v0)
    }
    3U => {
      let v0 : Int32 = Binary::read(r)

      Parameter(v0)
    }
    4U => {
      let v0 : String = Binary::read(r)
      let v1 : String = Binary::read(r)

      Column(v0, v1)
    }
    5U => {
      let v0 : String = Binary::read(r)

      Star(v0)
    }
    6U => {
      let v0 : String = Binary::read(r)
      let v1 : Expr = Binary::read(r)

      Unary(v0, v1)
    }
    7U => {
      let v0 : String = Binary::read(r)
      let v1 : Expr = Binary::read(r)
      let v2 : Expr = Binary::read(r)

      Binary(v0, v1, v2)
    }
    8U =>
      if CAP_EXPRESSION_CALL {
        let v0 : String = Binary::read(r)
        let v1 : Array[Expr] = Binary::read(r)
        r.require_feature(function_features(v0))
        Call(v0, v1)
      } else {
        fail("catalog capability disabled: expression call")
      }
    9U => {
      let v0 : Expr = Binary::read(r)
      let v1 : String = Binary::read(r)

      Collate(v0, v1)
    }
    10U =>
      if CAP_EXPRESSION_CAST {
        let v0 : Expr = Binary::read(r)
        let v1 : String = Binary::read(r)

        Cast(v0, v1)
      } else {
        fail("catalog capability disabled: expression cast")
      }
    11U => {
      let v0 : Array[Ordering] = Binary::read(r)
      r.require_feature(64U)
      RowNumber(v0)
    }
    12U => {
      let v0 : String = Binary::read(r)
      let v1 : Array[Expr] = Binary::read(r)
      let v2 : Array[Expr] = Binary::read(r)
      let v3 : Array[Ordering] = Binary::read(r)
      let v4 : WindowFrame = Binary::read(r)
      r.require_feature(64U)
      Window(v0, v1, v2, v3, v4)
    }
    13U =>
      if CAP_EXPRESSION_BETWEEN {
        let v0 : Expr = Binary::read(r)
        let v1 : Expr = Binary::read(r)
        let v2 : Expr = Binary::read(r)

        Between(v0, v1, v2)
      } else {
        fail("catalog capability disabled: expression between")
      }
    14U =>
      if CAP_EXPRESSION_CASE {
        let v0 : Expr? = Binary::read(r)
        let v1 : Array[(Expr, Expr)] = Binary::read(r)
        let v2 : Expr = Binary::read(r)

        Case(v0, v1, v2)
      } else {
        fail("catalog capability disabled: expression case")
      }
    15U =>
      if CAP_EXPRESSION_SUBQUERY {
        let v0 : Expr = Binary::read(r)
        let v1 : Selection = Binary::read(r)

        InSelect(v0, v1)
      } else {
        fail("catalog capability disabled: expression subquery")
      }
    16U =>
      if CAP_EXPRESSION_SUBQUERY {
        let v0 : Selection = Binary::read(r)

        ScalarSelect(v0)
      } else {
        fail("catalog capability disabled: expression subquery")
      }
    17U =>
      if CAP_EXPRESSION_SUBQUERY {
        let v0 : Selection = Binary::read(r)

        Exists(v0)
      } else {
        fail("catalog capability disabled: expression subquery")
      }
    _ => fail("unknown binary Expr tag")
  }
}

///|
impl Binary for DataStatement with fn write(value, w) {
  match value {
    PreparedTransaction(v0, v1) => {
      w.uint(0U)

      Binary::write(v0, w)
      Binary::write(v1, w)
    }
    PreparedSelect(v0) => {
      w.uint(1U)

      Binary::write(v0, w)
    }
    PreparedPragma(v0, v1) => {
      w.uint(2U)
      w.require_feature(pragma_features(v0))
      Binary::write(v0, w)
      Binary::write(v1, w)
    }
    PreparedInsert(v0) => {
      w.uint(3U)

      Binary::write(v0, w)
    }
    PreparedUpdate(v0, v1, v2, v3) => {
      w.uint(4U)

      Binary::write(v0, w)
      Binary::write(v1, w)
      Binary::write(v2, w)
      Binary::write(v3, w)
    }
    PreparedDelete(v0, v1, v2) => {
      w.uint(5U)

      Binary::write(v0, w)
      Binary::write(v1, w)
      Binary::write(v2, w)
    }
  }
}

///|
impl Binary for DataStatement with fn read(r) {
  r.enter()
  defer r.leave()
  match r.uint() {
    0U => {
      let v0 : String = Binary::read(r)
      let v1 : String = Binary::read(r)

      PreparedTransaction(v0, v1)
    }
    1U => {
      let v0 : Selection = Binary::read(r)

      PreparedSelect(v0)
    }
    2U => {
      let v0 : String = Binary::read(r)
      let v1 : String = Binary::read(r)
      r.require_feature(pragma_features(v0))
      PreparedPragma(v0, v1)
    }
    3U => {
      let v0 : Insertion = Binary::read(r)

      PreparedInsert(v0)
    }
    4U => {
      let v0 : String = Binary::read(r)
      let v1 : Array[(String, Expr)] = Binary::read(r)
      let v2 : Expr = Binary::read(r)
      let v3 : Array[Projection] = Binary::read(r)

      PreparedUpdate(v0, v1, v2, v3)
    }
    5U => {
      let v0 : String = Binary::read(r)
      let v1 : Expr = Binary::read(r)
      let v2 : Array[Projection] = Binary::read(r)

      PreparedDelete(v0, v1, v2)
    }
    _ => fail("unknown binary DataStatement tag")
  }
}

///|
impl Binary for WindowBound with fn write(value, w) {
  match value {
    UnboundedPreceding => w.uint(0U)
    Preceding(v0) => {
      w.uint(1U)

      Binary::write(v0, w)
    }
    Current => w.uint(2U)
    Following(v0) => {
      w.uint(3U)

      Binary::write(v0, w)
    }
    UnboundedFollowing => w.uint(4U)
  }
}

///|
impl Binary for WindowBound with fn read(r) {
  r.enter()
  defer r.leave()
  match r.uint() {
    0U => UnboundedPreceding
    1U => {
      let v0 : Expr = Binary::read(r)

      Preceding(v0)
    }
    2U => Current
    3U => {
      let v0 : Expr = Binary::read(r)

      Following(v0)
    }
    4U => UnboundedFollowing
    _ => fail("unknown binary WindowBound tag")
  }
}

///|
impl Binary for RowEdit with fn write(value, w) {
  match value {
    AppendRow(v0, v1) => {
      w.uint(0U)

      Binary::write(v0, w)
      Binary::write(v1, w)
    }
    ReplaceRow(v0, v1, v2) => {
      w.uint(1U)

      Binary::write(v0, w)
      Binary::write(v1, w)
      Binary::write(v2, w)
    }
    DeleteRow(v0, v1) => {
      w.uint(2U)

      Binary::write(v0, w)
      Binary::write(v1, w)
    }
    PatchRow(v0, v1, v2, v3) => {
      w.uint(3U)

      Binary::write(v0, w)
      Binary::write(v1, w)
      Binary::write(v2, w)
      Binary::write(v3, w)
    }
  }
}

///|
impl Binary for RowEdit with fn read(r) {
  r.enter()
  defer r.leave()
  match r.uint() {
    0U => {
      let v0 : String = Binary::read(r)
      let v1 : StoredRow = Binary::read(r)

      AppendRow(v0, v1)
    }
    1U => {
      let v0 : String = Binary::read(r)
      let v1 : Int64 = Binary::read(r)
      let v2 : StoredRow = Binary::read(r)

      ReplaceRow(v0, v1, v2)
    }
    2U => {
      let v0 : String = Binary::read(r)
      let v1 : Int64 = Binary::read(r)

      DeleteRow(v0, v1)
    }
    3U => {
      let v0 : String = Binary::read(r)
      let v1 : Int64 = Binary::read(r)
      let v2 : Int64 = Binary::read(r)
      let v3 : Array[(Int32, Value)] = Binary::read(r)

      PatchRow(v0, v1, v2, v3)
    }
    _ => fail("unknown binary RowEdit tag")
  }
}

// Source: binary_io.mbt

///|
// Wire v1: SQLK, version:u8, kind:u8, reserved:u16, features:u32le,
// payloadLength:u32le, string-pool + typed payload, SHA256(header + payload).
// Format ownership is independent of JSON derives and generated JS internals.
priv struct BinaryWriter {
  out : @buffer.Buffer
  strings : Array[String]
  ids : Map[String, UInt32]
  mut features : UInt32
}

///|
priv struct BinaryReader {
  bytes : BytesView
  mut position : Int32
  strings : Array[String]
  mut depth : Int32
  declared : UInt32
  mut features : UInt32
}

///|
priv trait Binary {
  fn write(Self, BinaryWriter) -> Unit raise SqlError
  fn read(BinaryReader) -> Self raise SqlError
}

///|
fn binary_writer() -> BinaryWriter {
  { out: @buffer.Buffer(), strings: [], ids: Map([]), features: 0U, }
}

///|
fn BinaryWriter::require_feature(w : BinaryWriter, flag : UInt32) -> Unit {
  w.features = w.features | flag
}

///|
fn BinaryReader::require_feature(r : BinaryReader, flag : UInt32) -> Unit {
  r.features = r.features | flag
}

///|
fn BinaryWriter::uint(w : BinaryWriter, value : UInt32) -> Unit {
  let mut n = value
  while n >= 128U {
    w.out.write_byte(((n & 127U) | 128U).to_byte())
    n = n >> 7
  }
  w.out.write_byte(n.to_byte())
}

///|
fn BinaryReader::byte(r : BinaryReader) -> Byte raise SqlError {
  guard r.position < r.bytes.length() else {
    fail("truncated binary definition")
  }
  let value = r.bytes[r.position]
  r.position += 1
  value
}

///|
fn BinaryReader::uint(r : BinaryReader) -> UInt32 raise SqlError {
  let mut value = 0U
  for i in 0..<5 {
    let b = r.byte().to_uint()
    guard i < 4 || b < 16U else { fail("binary integer overflow") }
    value = value | ((b & 127U) << (i * 7))
    if b < 128U {
      guard i == 0 || b != 0U else { fail("noncanonical binary integer") }
      return value
    }
  }
  fail("binary integer overflow")
}

///|
fn BinaryReader::length(r : BinaryReader) -> Int32 raise SqlError {
  let n = r.uint()
  guard n <= 67108864U &&
    n <= (r.bytes.length() - r.position).reinterpret_as_uint() else {
    fail("binary length resource limit")
  }
  n.reinterpret_as_int()
}

///|
fn BinaryReader::blob(r : BinaryReader) -> Bytes raise SqlError {
  let n = r.length()
  let value = r.bytes[r.position:r.position + n].to_owned()
  r.position += n
  value
}

///|
fn BinaryReader::enter(r : BinaryReader) -> Unit raise SqlError {
  guard r.depth < 256 else { fail("binary nesting resource limit") }
  r.depth += 1
}

///|
fn BinaryReader::leave(r : BinaryReader) -> Unit {
  r.depth -= 1
}

///|
fn BinaryReader::finish(r : BinaryReader) -> Unit raise SqlError {
  guard r.position == r.bytes.length() && r.features == r.declared else {
    fail("binary trailing bytes or feature mismatch")
  }
}

///|
fn binary_hex(bytes : BytesView) -> String {
  let out = StringBuilder()
  let digits = "0123456789abcdef"
  for byte in bytes {
    out.write_char(digits[byte.to_int() >> 4].to_int().unsafe_to_char())
    out.write_char(digits[byte.to_int() & 15].to_int().unsafe_to_char())
  }
  out.to_string()
}

///|
fn binary_id(bytes : Bytes) -> String {
  binary_hex(bytes[bytes.length() - 32:])
}

///|
fn binary_finish(w : BinaryWriter, kind : Int32) -> Bytes raise SqlError {
  let payload = @buffer.Buffer()
  let pool = binary_writer()
  pool.uint(w.strings.length().reinterpret_as_uint())
  payload.write_bytes(pool.out.to_bytes()[:])
  for text in w.strings {
    let bytes = @utf8.encode(text)
    guard (@utf8.decode(bytes[:]) catch { _ => "" }) == text else {
      fail("binary text must be valid UTF8")
    }
    let prefix = binary_writer()
    prefix.uint(bytes.length().reinterpret_as_uint())
    payload.write_bytes(prefix.out.to_bytes()[:])
    payload.write_bytes(bytes[:])
  }
  payload.write_bytes(w.out.to_bytes()[:])
  guard payload.length() <= 67108816 && w.strings.length() <= 100000 else {
    fail("binary output resource limit")
  }
  let out = @buffer.Buffer()
  out.write_bytes(b"SQLK"[:])
  out.write_byte(b'\x01')
  out.write_byte(kind.to_byte())
  out.write_byte(b'\x00')
  out.write_byte(b'\x00')
  out.write_uint_le(w.features)
  out.write_uint_le(payload.length().reinterpret_as_uint())
  out.write_bytes(payload.to_bytes()[:])
  out.write_iter(@crypto.sha256(out.to_bytes()).iter())
  out.to_bytes()
}

///|
fn binary_reader(
  bytes : Bytes,
  kind : Int32,
  limit : Int32,
) -> BinaryReader raise SqlError {
  guard bytes.length() >= 48 &&
    bytes.length() <= limit &&
    bytes[0:4] == b"SQLK"[:] &&
    bytes[4] == b'\x01' &&
    bytes[5].to_int() == kind &&
    bytes[6] == b'\x00' &&
    bytes[7] == b'\x00' else {
    fail("unsupported binary definition header")
  }
  let word = fn(start : Int32) {
    let mut n = 0U
    for i in 0..<4 {
      n = n | (bytes[start + i].to_uint() << (i * 8))
    }
    n
  }
  let declared = word(8)
  let allowed = (if FEATURE_SQL_JSON { 16U } else { 0U }) |
    (if FEATURE_DATETIME { 32U } else { 0U }) |
    (if FEATURE_WINDOWS { 64U } else { 0U }) |
    (if FEATURE_SCHEMA_METADATA { 128U } else { 0U }) |
    (if FEATURE_AGGREGATE_FILTER { 256U } else { 0U }) |
    (if FEATURE_AGGREGATE_ORDER { 512U } else { 0U }) |
    (if FEATURE_ROW_VALUES { 1024U } else { 0U }) |
    (if FEATURE_UPDATE_FROM { 2048U } else { 0U }) |
    (if FEATURE_GENERATED_COLUMNS { 4096U } else { 0U }) |
    (if FEATURE_JSON_TABLE { 8192U } else { 0U }) |
    (if FEATURE_FOREIGN_KEYS { 1U } else { 0U }) |
    (if FEATURE_TRIGGERS { 2U } else { 0U }) |
    (if FEATURE_STRICT { 4U } else { 0U }) |
    (if FEATURE_OUTER_JOIN { 8U } else { 0U })
  guard (declared & allowed) == declared &&
    word(12) == (bytes.length() - 48).reinterpret_as_uint() else {
    fail("binary length or required feature mismatch")
  }
  let digest = @crypto.sha256(bytes[0:bytes.length() - 32])
  for i in 0..<32 {
    guard digest[i] == bytes[bytes.length() - 32 + i] else {
      fail("binary checksum mismatch")
    }
  }
  let r = {
    bytes: bytes[16:bytes.length() - 32],
    position: 0,
    strings: [],
    depth: 0,
    declared,
    features: 0U,
  }
  let count = r.length()
  guard count <= 100000 else { fail("binary string pool limit") }
  let unique : Map[String, Bool] = Map([])
  for _ in 0..<count {
    let text = @utf8.decode(r.blob()[:]) catch {
      _ => fail("invalid binary UTF8")
    }
    guard !unique.contains(text) else {
      fail("duplicate binary string pool entry")
    }
    unique[text] = true
    r.strings.push(text)
  }
  r
}

///|
impl Binary for Int32 with fn write(value, w) {
  w.uint(
    (value.reinterpret_as_uint() << 1) ^ (value >> 31).reinterpret_as_uint(),
  )
}

///|
impl Binary for Int32 with fn read(r) {
  let n = r.uint()
  let v = (n >> 1).reinterpret_as_int()
  if (n & 1U) == 1U {
    -v - 1
  } else {
    v
  }
}

///|
impl Binary for Int64 with fn write(value, w) {
  w.out.write_int64_le(value)
}

///|
impl Binary for Int64 with fn read(r) {
  let mut n = 0UL
  for i in 0..<8 {
    n = n | (r.byte().to_uint64() << (i * 8))
  }
  n.reinterpret_as_int64()
}

///|
impl Binary for Double with fn write(value, w) {
  guard !value.is_nan() else { fail("invalid binary REAL") }
  Binary::write(value.reinterpret_as_int64(), w)
}

///|
impl Binary for Double with fn read(r) {
  let bits : Int64 = Binary::read(r)
  let value = bits.reinterpret_as_double()
  guard !value.is_nan() else { fail("invalid binary REAL") }
  value
}

///|
impl Binary for Bool with fn write(value, w) {
  w.uint(if value { 1U } else { 0U })
}

///|
impl Binary for Bool with fn read(r) {
  match r.uint() {
    0U => false
    1U => true
    _ => fail("invalid binary bool")
  }
}

///|
impl Binary for String with fn write(value, w) {
  let id = match w.ids.get(value) {
    Some(id) => id
    None => {
      let id = w.strings.length().reinterpret_as_uint()
      w.ids[value] = id
      w.strings.push(value)
      id
    }
  }
  w.uint(id)
}

///|
impl Binary for String with fn read(r) {
  let n = r.uint()
  guard n < r.strings.length().reinterpret_as_uint() else {
    fail("invalid binary string reference")
  }
  r.strings[n.reinterpret_as_int()]
}

///|
impl Binary for Bytes with fn write(value, w) {
  w.uint(value.length().reinterpret_as_uint())
  w.out.write_bytes(value[:])
}

///|
impl Binary for Bytes with fn read(r) {
  r.blob()
}

///|
impl[A : Binary] Binary for Array[A] with fn write(values, w) {
  guard values.length() <= 100000 else { fail("binary array resource limit") }
  w.uint(values.length().reinterpret_as_uint())
  for value in values {
    Binary::write(value, w)
  }
}

///|
impl[A : Binary] Binary for Array[A] with fn read(r) {
  r.enter()
  defer r.leave()
  let n = r.length()
  guard n <= 100000 else { fail("binary array resource limit") }
  let values = []
  for _ in 0..<n {
    values.push(Binary::read(r))
  }
  values
}

///|
impl[A : Binary] Binary for A? with fn write(value, w) {
  match value {
    None => w.uint(0U)
    Some(value) => {
      w.uint(1U)
      Binary::write(value, w)
    }
  }
}

///|
impl[A : Binary] Binary for A? with fn read(r) {
  match r.uint() {
    0U => None
    1U => Some(Binary::read(r))
    _ => fail("invalid binary option")
  }
}

///|
impl[A : Binary, B : Binary] Binary for (A, B) with fn write(value, w) {
  Binary::write(value.0, w)
  Binary::write(value.1, w)
}

///|
impl[A : Binary, B : Binary] Binary for (A, B) with fn read(r) {
  (Binary::read(r), Binary::read(r))
}

///|
impl Binary for Value with fn write(value, w) {
  match value {
    Null => w.uint(0U)
    Integer(v) => {
      w.uint(1U)
      Binary::write(v, w)
    }
    Real(v) => {
      w.uint(2U)
      Binary::write(v, w)
    }
    Text(v) => {
      w.uint(3U)
      Binary::write(v, w)
    }
    Blob(v) => {
      w.uint(4U)
      Binary::write(v, w)
    }
  }
}

///|
impl Binary for Value with fn read(r) {
  match r.uint() {
    0U => Null
    1U => Integer(Binary::read(r))
    2U => Real(Binary::read(r))
    3U => Text(Binary::read(r))
    4U => Blob(Binary::read(r))
    _ => fail("unknown binary value tag")
  }
}

// Source: binary_state.mbt

///|
fn defined_state_write(db : DefinedDatabase, w : BinaryWriter) -> Unit raise {
  let (connection, _) = db.core.ready()
  let store = connection.database.store
  guard database_autocommit(connection.database) && !store.deferred else {
    fail("cannot persist an active defined transaction")
  }
  Binary::write(db.schema_id, w)
  Binary::write(connection.database.serial, w)
  Binary::write(store.changes, w)
  Binary::write(store.last_rowid, w)
  Binary::write(store.foreign_keys, w)
  w.uint(store.tables.length().reinterpret_as_uint())
  for table in store.tables {
    Binary::write(table.sequence, w)
    Binary::write(table.sequence_present, w)
    Binary::write(
      table.rows.map(row => persistent_generated_row(table, row)),
      w,
    )
  }
}

///|
fn defined_snapshot(db : DefinedDatabase) -> BinaryResult {
  try {
    let (connection, _) = db.core.ready()
    let w = binary_writer()
    defined_state_write(db, w)
    {
      data: binary_finish(w, 4),
      full: true,
      serial: connection.database.serial,
      error: "",
    }
  } catch {
    e => { data: b"", full: true, serial: 0, error: public_error(e), }
  }
}

///|
fn defined_restore_checked(db : DefinedDatabase, bytes : Bytes) -> Unit raise {
  let (connection, program) = db.core.ready()
  guard database_autocommit(connection.database) else {
    fail("cannot restore an active transaction")
  }
  let r = binary_reader(bytes, 4, 67108864)
  let schema_id : String = Binary::read(r)
  guard schema_id == db.schema_id else {
    fail("defined snapshot schema mismatch")
  }
  let serial : Int32 = Binary::read(r)
  let changes : Int32 = Binary::read(r)
  let last_rowid : Int64 = Binary::read(r)
  let foreign_keys : Bool = Binary::read(r)
  let count = r.length()
  let store = copy_store(program.schema)
  guard serial >= 0 &&
    changes >= 0 &&
    count == store.tables.length() &&
    foreign_keys == store.foreign_keys else {
    fail("invalid defined snapshot metadata")
  }
  for table in store.tables {
    table.sequence = Binary::read(r)
    table.sequence_present = Binary::read(r)
    let rows : Array[StoredRow] = Binary::read(r)
    table.rows = row_pages(rows)
  }
  r.finish()
  store.changes = changes
  store.last_rowid = last_rowid
  validate_store_rows(store, storage=true)
  publish_flush(connection.database, store, serial)
}

///|
fn defined_restore(db : DefinedDatabase, bytes : Bytes) -> String {
  try {
    defined_restore_checked(db, bytes)
    "{}"
  } catch {
    e => ({ "error": public_error(e) } : Json).stringify()
  }
}

///|
fn defined_delta(db : DefinedDatabase, force_snapshot : Bool) -> BinaryResult {
  try {
    let (connection, _) = db.core.ready()
    let database = connection.database
    let store = database.store
    if force_snapshot || store.dirty.full || database.serial == store.dirty.base {
      return defined_snapshot(db)
    }
    guard database_autocommit(database) && !store.deferred else {
      fail("cannot persist an active defined transaction")
    }
    let w = binary_writer()
    Binary::write(db.schema_id, w)
    Binary::write(store.dirty.base, w)
    Binary::write(database.serial, w)
    Binary::write(store.changes, w)
    Binary::write(store.last_rowid, w)
    Binary::write(store.foreign_keys, w)
    Binary::write(store.tables.map(t => (t.sequence, t.sequence_present)), w)
    Binary::write(store.dirty.edits, w)
    {
      data: binary_finish(w, 5),
      full: false,
      serial: database.serial,
      error: "",
    }
  } catch {
    e => { data: b"", full: false, serial: 0, error: public_error(e), }
  }
}

///|
fn defined_apply_delta(db : DefinedDatabase, bytes : Bytes) -> String {
  try {
    let (connection, _) = db.core.ready()
    let database = connection.database
    guard database_autocommit(database) else {
      fail("cannot replay into an active transaction")
    }
    let r = binary_reader(bytes, 5, 67108864)
    let schema_id : String = Binary::read(r)
    let base : Int32 = Binary::read(r)
    let serial : Int32 = Binary::read(r)
    let changes : Int32 = Binary::read(r)
    let last_rowid : Int64 = Binary::read(r)
    let foreign_keys : Bool = Binary::read(r)
    let sequences : Array[(Int64, Bool?)] = Binary::read(r)
    let edits : Array[RowEdit] = Binary::read(r)
    r.finish()
    guard schema_id == db.schema_id &&
      base == database.serial &&
      serial > base &&
      changes >= 0 &&
      sequences.length() == database.store.tables.length() &&
      foreign_keys == database.store.foreign_keys else {
      fail("defined delta schema/serial mismatch")
    }
    let store = copy_store(database.store)
    store.dirty = dirty_state()
    apply_materialized_edits(store, edits)
    for i, (sequence, present) in sequences {
      store.tables[i].sequence = sequence
      store.tables[i].sequence_present = present
    }
    store.changes = changes
    store.last_rowid = last_rowid
    validate_foreign_keys(store)
    publish_flush(database, store, serial)
    "{}"
  } catch {
    e => ({ "error": public_error(e) } : Json).stringify()
  }
}

///|
// Optional entry point. Only this path loads a SQLite layout/template.
fn defined_export_sqlite(
  schema : Bytes,
  statements : Bytes,
  layout : Bytes,
  image : Bytes,
) -> SqliteResult {
  try {
    let db = defined_open(schema, statements, image)
    let (connection, _) = db.core.ready()
    let plan = defined_sqlite_plan(db, layout)
    {
      data: sqlite_export(
        connection.database.store,
        connection.database.serial,
        plan,
      ),
      info: "{}",
    }
  } catch {
    e => { data: b"", info: ({ "error": public_error(e) } : Json).stringify(), }
  }
}

///|
fn defined_sqlite_plan(
  db : DefinedDatabase,
  layout : Bytes,
) -> StoragePlan raise {
  let r = binary_reader(layout, 3, 1048576)
  let schema_id : String = Binary::read(r)
  guard schema_id == db.schema_id else { fail("SQLite layout schema mismatch") }
  let format : String = Binary::read(r)
  let page_size : Int32 = Binary::read(r)
  let template : Bytes = Binary::read(r)
  let trees : Array[StorageTree] = Binary::read(r)
  r.finish()
  let plan : StoragePlan = {
    format,
    page_size,
    image: @base64.encode(template),
    trees,
  }

  plan
}

// Source: bound_access.mbt

///|
/// Access paths retain schema facts and parameter positions, never live indexes.
priv enum BoundAccess {
  BoundScan
  BoundRowid(BoundValue, Bool)
  BoundPrimary(Array[BoundKeyPart])
}

///|
priv struct BoundKeyPart {
  value : BoundValue
  affinity : String
  collation : String
}

///|
fn bind_key_terms(
  e : Expr,
  layout : Environment,
  terms : Map[Int32, BoundValue],
) -> Unit raise SqlError {
  match e {
    Binary("and", left, right) => {
      bind_key_terms(left, layout, terms)
      bind_key_terms(right, layout, terms)
    }
    Binary(op, left, right) =>
      if op == "=" || op == "==" {
        for (column, value) in [(left, right), (right, left)] {
          if column is Column(q, name) && bind_key_value(value) is Some(value) {
            terms[bound_column(layout, q, name)] = value
          }
        }
      }
    _ => ()
  }
}

///|
fn bind_access(
  table : Table,
  predicate : Expr,
  layout : Environment,
) -> BoundAccess raise SqlError {
  let terms : Map[Int32, BoundValue] = Map([])
  bind_key_terms(predicate, layout, terms)
  let ipk = integer_primary(table)
  let rowid = match terms.get(-1) {
    Some(value) => Some(value)
    None => if ipk >= 0 { terms.get(ipk) } else { None }
  }
  if rowid is Some(value) {
    // Preserve the existing non-indexed shortcut only for a whole rowid equality
    // with an INTEGER value; other storage classes retain the scan fallback.
    let linear = match predicate {
      Binary(op, _, _) => op == "=" || op == "=="
      _ => false
    }
    return BoundRowid(value, linear)
  }
  let keys = primary_key(table)
  guard !keys.is_empty() && keys.all(i => terms.contains(i)) else {
    return BoundScan
  }
  BoundPrimary(
    keys.map(i => {
      value: terms[i],
      affinity: column_affinity(table, table.columns[i]),
      collation: table.columns[i].collation,
    }),
  )
}

///|
fn bound_rowid(value : Value) -> Int64? {
  match apply_affinity(value, "integer") {
    Integer(id) => Some(id)
    Real(n) =>
      if n >= -9223372036854775808.0 &&
        n < 9223372036854775808.0 &&
        n.to_int64().to_double() == n {
        Some(n.to_int64())
      } else {
        None
      }
    _ => None
  }
}

///|
fn bound_candidates(
  access : BoundAccess,
  store : Store,
  table : Table,
  params : Array[Value],
) -> Array[StoredRow] raise SqlError {
  match access {
    BoundScan => table.rows.copy()
    BoundRowid(value, linear) => {
      let value = read_key_value(value, params)
      if !FEATURE_PRIMARY_INDEX {
        return match value {
          Integer(id) =>
            if linear {
              candidate_rows(store, table, Some(id))
            } else {
              table.rows.copy()
            }
          _ => table.rows.copy()
        }
      }
      match bound_rowid(value) {
        Some(id) =>
          primary_row(primary_index(store, table), table, id)
          .map(row => [row])
          .unwrap_or([])
        None => []
      }
    }
    BoundPrimary(fields) => {
      if !FEATURE_PRIMARY_INDEX {
        return table.rows.copy()
      }
      let parts : Array[Json] = []
      for field in fields {
        guard primary_part_key(
            read_key_value(field.value, params),
            field.affinity,
            field.collation,
          )
          is Some(part) else {
          return []
        }
        parts.push(part)
      }
      primary_key_row(
        primary_index(store, table),
        table,
        Json::array(parts).stringify(),
      )
      .map(row => [row])
      .unwrap_or([])
    }
  }
}

// Source: bound_expression.mbt

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

// Source: bound_point.mbt

///|
priv struct PreparedPoint {
  table_slot : Int32
  layout : Environment
  columns : Array[RowProjection]?
  projection : BoundProjection
  predicate : BoundExpression
  access : BoundAccess
  limit : BoundValue
  offset : BoundValue
}

///|
fn prepare_point(
  store : Store,
  select : Selection,
  table : Table,
  slot : Int32,
  layout : Environment,
  columns : Array[RowProjection]?,
  parameters : Int32,
) -> PreparedPoint? raise SqlError {
  let source = select.sources[0]
  guard OPT_POINT_PROJECTION &&
    select.compound is None &&
    select.ctes.is_empty() &&
    !select.distinct &&
    select.groups.is_empty() &&
    select.projections.all(p => point_scalar(p.expression)) &&
    select.having is Literal(Integer(1L)) &&
    !source.left &&
    source.right != Some(true) &&
    source.natural != Some(true) &&
    source.using_columns.unwrap_or([]).is_empty() &&
    source.on is Literal(Integer(1L)) &&
    select.orders.all(o => {
      match o.expression {
        Column(_, _) | Literal(Integer(_)) => true
        _ => false
      }
    }) &&
    bind_key_value(select.limit) is Some(limit) &&
    bind_key_value(select.offset) is Some(offset) else {
    return None
  }
  let access = bind_access(table, select.predicate, layout)
  guard !(access is BoundScan) else { return None }
  let context = evaluation(store, Array::make(parameters, Null), layout)
  Some({
    table_slot: slot,
    layout,
    columns,
    projection: bind_projection(select.projections, context),
    predicate: bind_expression(select.predicate, context),
    access,
    limit,
    offset,
  })
}

///|
/// Expressions needing relation/group/window scopes retain the general plan.
fn point_scalar(e : Expr) -> Bool {
  match e {
    ScalarSelect(_)
    | Exists(_)
    | InSelect(_, _)
    | Window(_, _, _, _, _)
    | RowNumber(_) => false
    Call(name, args) =>
      !aggregate_name(name, args.length()) && args.all(point_scalar)
    Binary(_, a, b) => point_scalar(a) && point_scalar(b)
    Unary(_, e) | Cast(e, _) | Collate(e, _) => point_scalar(e)
    Between(e, a, b) => point_scalar(e) && point_scalar(a) && point_scalar(b)
    Case(base, arms, other) =>
      base.map(point_scalar).unwrap_or(true) &&
      arms.all(p => point_scalar(p.0) && point_scalar(p.1)) &&
      point_scalar(other)
    _ => true
  }
}

///|
fn execute_bound_point(
  plan : PreparedPoint,
  store : Store,
  params : Array[Value],
) -> Array[Environment]? raise SqlError {
  // Unsupported LIMIT binding classes retain the existing general validator.
  guard read_key_value(plan.limit, params) is Integer(limit) &&
    read_key_value(plan.offset, params) is Integer(offset) else {
    return None
  }
  if limit == 0L {
    return Some([])
  }
  let table = store.tables[plan.table_slot]
  for row in bound_candidates(plan.access, store, table, params) {
    let input : BoundInput = {
      store,
      params,
      row,
      layout: plan.layout,
      context: None,
      joined: None,
      in_lists: [],
    }
    if truth(evaluate_bound(plan.predicate, input)) == 1 && offset <= 0L {
      return Some([
        match plan.columns {
          Some(columns) =>
            project_stored_row(columns, plan.projection.output, row)
          None => project_bound(plan.projection, input)
        },
      ])
    }
  }
  Some([])
}

// Source: bound_value.mbt

///|
/// Literal/bind key operands shared by access plans and execution-local IN sets.

///|
priv enum BoundValue {
  KeyLiteral(Value)
  KeyParameter(Int32)
}

///|
fn bind_key_value(e : Expr) -> BoundValue? {
  match e {
    Literal(value) => Some(KeyLiteral(value))
    Parameter(index) => Some(KeyParameter(index))
    _ => None
  }
}

///|
fn read_key_value(
  value : BoundValue,
  params : Array[Value],
) -> Value raise SqlError {
  match value {
    KeyLiteral(value) => value
    KeyParameter(index) => {
      guard index >= 0 && index < params.length() else {
        fail("missing SQL binding")
      }
      params[index]
    }
  }
}

// Source: capability_config_generated.mbt
// Generated by scripts/generate-runtime-capabilities.ts.
// Capability SHA256: 29619c2e072435a6815a66a53f186049bab9599699b36935570352fe81d0b0be
// Contract SHA256: f3e811d415bf6e48620b30d666547b023504647406200f3b8e0f9abbe367dd96

///|
const CAP_CATALOG_SPECIALIZED : Bool = true

///|
const CAP_FUNCTION_GLOB : Bool = true

///|
const CAP_FUNCTION_LIKE : Bool = true

///|
const CAP_FUNCTION_CHARACTER : Bool = true

///|
const CAP_FUNCTION_SUBSTRING : Bool = true

///|
const CAP_FUNCTION_TRIM : Bool = true

///|
const CAP_FUNCTION_INSTR : Bool = true

///|
const CAP_FUNCTION_REPLACE : Bool = true

///|
const CAP_FUNCTION_CONCAT : Bool = true

///|
const CAP_FUNCTION_OCTET_LENGTH : Bool = true

///|
const CAP_FUNCTION_QUOTE : Bool = true

///|
const CAP_FUNCTION_UNICODE : Bool = true

///|
const CAP_FUNCTION_SIGN : Bool = true

///|
const CAP_FUNCTION_ROUND : Bool = true

///|
const CAP_FUNCTION_MATH_ROUNDING : Bool = true

///|
const CAP_FUNCTION_NULLIF : Bool = true

///|
const CAP_FUNCTION_COALESCE : Bool = true

///|
const CAP_FUNCTION_CONDITIONAL : Bool = true

///|
const CAP_FUNCTION_CONNECTION_COUNTERS : Bool = true

///|
const CAP_FUNCTION_TYPEOF : Bool = true

///|
const CAP_FUNCTION_HEX : Bool = true

///|
const CAP_FUNCTION_LENGTH : Bool = true

///|
const CAP_FUNCTION_CASE_CONVERSION : Bool = true

///|
const CAP_FUNCTION_ABS : Bool = true

///|
const CAP_FUNCTION_IN_LIST : Bool = true

///|
const CAP_FUNCTION_EXTREMA : Bool = true

///|
const CAP_FUNCTION_AGGREGATES : Bool = true

///|
const CAP_FUNCTION_GROUP_CONCAT : Bool = true

///|
const CAP_FUNCTION_RAISE : Bool = false

///|
const CAP_FUNCTION_JSON_NORMALIZE : Bool = false

///|
const CAP_FUNCTION_JSON_CONSTRUCT : Bool = false

///|
const CAP_FUNCTION_JSON_READ : Bool = false

///|
const CAP_FUNCTION_JSON_ARROW : Bool = false

///|
const CAP_FUNCTION_JSON_EDIT : Bool = false

///|
const CAP_FUNCTION_JSON_PATCH : Bool = false

///|
const CAP_FUNCTION_JSON_AGGREGATE : Bool = false

///|
const CAP_FUNCTION_FORMAT : Bool = true

///|
const CAP_EXPRESSION_CALL : Bool = true

///|
const CAP_EXPRESSION_SUBQUERY : Bool = true

///|
const CAP_EXPRESSION_CAST : Bool = true

///|
const CAP_EXPRESSION_CASE : Bool = true

///|
const CAP_EXPRESSION_BETWEEN : Bool = true

///|
const CAP_STATEMENT_SELECT : Bool = true

///|
const CAP_STATEMENT_INSERT : Bool = true

///|
const CAP_STATEMENT_UPDATE : Bool = true

///|
const CAP_STATEMENT_DELETE : Bool = true

///|
const CAP_STATEMENT_TRANSACTION : Bool = true

///|
const CAP_STATEMENT_PRAGMA : Bool = true

///|
const CAP_QUERY_SOURCE : Bool = true

///|
const CAP_QUERY_ORDER_BY : Bool = true

///|
const CAP_QUERY_DISTINCT : Bool = true

///|
const CAP_QUERY_LIMIT_OFFSET : Bool = true

///|
const CAP_QUERY_GROUP_BY : Bool = true

///|
const CAP_QUERY_JSON_SUBTYPE : Bool = false

///|
const CAP_QUERY_CTE : Bool = false

///|
const CAP_QUERY_RECURSIVE_CTE : Bool = false

///|
const CAP_QUERY_JOIN : Bool = true

///|
const CAP_QUERY_COMPOUND : Bool = false

///|
const CAP_QUERY_IN_SELECT : Bool = true

///|
const CAP_QUERY_AGGREGATE_REPRESENTATIVE : Bool = true

///|
fn runtime_call_capability(name : String, arity : Int32) -> String? {
  if (name == "min" || name == "max") && arity == 1 {
    return Some("aggregates")
  }
  match name {
    "glob" => Some("glob")
    "like" => Some("like")
    "char" => Some("character")
    "substr" | "substring" => Some("substring")
    "trim" | "ltrim" | "rtrim" => Some("trim")
    "instr" => Some("instr")
    "replace" => Some("replace")
    "concat" | "concat_ws" => Some("concat")
    "octet_length" => Some("octetLength")
    "quote" => Some("quote")
    "unicode" => Some("unicode")
    "sign" => Some("sign")
    "round" => Some("round")
    "ceil" | "ceiling" | "floor" | "trunc" => Some("mathRounding")
    "nullif" => Some("nullif")
    "coalesce" | "ifnull" => Some("coalesce")
    "iif" | "if" => Some("conditional")
    "changes" | "last_insert_rowid" => Some("connectionCounters")
    "typeof" => Some("typeof")
    "hex" => Some("hex")
    "length" => Some("length")
    "lower" | "upper" => Some("caseConversion")
    "abs" => Some("abs")
    "in" => Some("inList")
    "min" | "max" => Some("extrema")
    "count" | "sum" | "total" | "avg" => Some("aggregates")
    "group_concat" | "string_agg" => Some("groupConcat")
    "raise" => Some("raise")
    "json" | "json_valid" => Some("jsonNormalize")
    "json_quote" | "json_array" | "json_object" => Some("jsonConstruct")
    "json_extract" | "json_type" | "json_array_length" => Some("jsonRead")
    "->" | "->>" => Some("jsonArrow")
    "json_set" | "json_insert" | "json_replace" | "json_remove" =>
      Some("jsonEdit")
    "json_patch" => Some("jsonPatch")
    "json_group_array" | "json_group_object" => Some("jsonAggregate")
    "format" | "printf" => Some("format")
    _ => None
  }
}

///|
fn runtime_call_allowed(name : String, arity : Int32) -> Bool {
  if (name == "min" || name == "max") && arity == 1 {
    return CAP_FUNCTION_AGGREGATES
  }
  match name {
    "glob" => CAP_FUNCTION_GLOB
    "like" => CAP_FUNCTION_LIKE
    "char" => CAP_FUNCTION_CHARACTER
    "substr" | "substring" => CAP_FUNCTION_SUBSTRING
    "trim" | "ltrim" | "rtrim" => CAP_FUNCTION_TRIM
    "instr" => CAP_FUNCTION_INSTR
    "replace" => CAP_FUNCTION_REPLACE
    "concat" | "concat_ws" => CAP_FUNCTION_CONCAT
    "octet_length" => CAP_FUNCTION_OCTET_LENGTH
    "quote" => CAP_FUNCTION_QUOTE
    "unicode" => CAP_FUNCTION_UNICODE
    "sign" => CAP_FUNCTION_SIGN
    "round" => CAP_FUNCTION_ROUND
    "ceil" | "ceiling" | "floor" | "trunc" => CAP_FUNCTION_MATH_ROUNDING
    "nullif" => CAP_FUNCTION_NULLIF
    "coalesce" | "ifnull" => CAP_FUNCTION_COALESCE
    "iif" | "if" => CAP_FUNCTION_CONDITIONAL
    "changes" | "last_insert_rowid" => CAP_FUNCTION_CONNECTION_COUNTERS
    "typeof" => CAP_FUNCTION_TYPEOF
    "hex" => CAP_FUNCTION_HEX
    "length" => CAP_FUNCTION_LENGTH
    "lower" | "upper" => CAP_FUNCTION_CASE_CONVERSION
    "abs" => CAP_FUNCTION_ABS
    "in" => CAP_FUNCTION_IN_LIST
    "min" | "max" => CAP_FUNCTION_EXTREMA
    "count" | "sum" | "total" | "avg" => CAP_FUNCTION_AGGREGATES
    "group_concat" | "string_agg" => CAP_FUNCTION_GROUP_CONCAT
    "raise" => CAP_FUNCTION_RAISE
    "json" | "json_valid" => CAP_FUNCTION_JSON_NORMALIZE
    "json_quote" | "json_array" | "json_object" => CAP_FUNCTION_JSON_CONSTRUCT
    "json_extract" | "json_type" | "json_array_length" => CAP_FUNCTION_JSON_READ
    "->" | "->>" => CAP_FUNCTION_JSON_ARROW
    "json_set" | "json_insert" | "json_replace" | "json_remove" =>
      CAP_FUNCTION_JSON_EDIT
    "json_patch" => CAP_FUNCTION_JSON_PATCH
    "json_group_array" | "json_group_object" => CAP_FUNCTION_JSON_AGGREGATE
    "format" | "printf" => CAP_FUNCTION_FORMAT
    _ => true
  }
}

///|
fn validate_runtime_call(name : String, arity : Int32) -> Unit raise SqlError {
  if CAP_CATALOG_SPECIALIZED && !runtime_call_allowed(name, arity) {
    fail("catalog capability disabled: function " + name)
  }
}

///|
fn validate_runtime_query_part(name : String) -> Unit raise SqlError {
  if CAP_CATALOG_SPECIALIZED {
    let enabled = match name {
      "source" => CAP_QUERY_SOURCE
      "orderBy" => CAP_QUERY_ORDER_BY
      "distinct" => CAP_QUERY_DISTINCT
      "limitOffset" => CAP_QUERY_LIMIT_OFFSET
      "groupBy" => CAP_QUERY_GROUP_BY
      "jsonSubtype" => CAP_QUERY_JSON_SUBTYPE
      "cte" => CAP_QUERY_CTE
      "recursiveCte" => CAP_QUERY_RECURSIVE_CTE
      "join" => CAP_QUERY_JOIN
      "compound" => CAP_QUERY_COMPOUND
      "inSelect" => CAP_QUERY_IN_SELECT
      "aggregateRepresentative" => CAP_QUERY_AGGREGATE_REPRESENTATIVE
      _ => false
    }
    guard enabled else { fail("catalog capability disabled: query " + name) }
  }
}

///|
fn validate_runtime_statement(name : String) -> Unit raise SqlError {
  if CAP_CATALOG_SPECIALIZED {
    let enabled = match name {
      "select" => CAP_STATEMENT_SELECT
      "insert" => CAP_STATEMENT_INSERT
      "update" => CAP_STATEMENT_UPDATE
      "delete" => CAP_STATEMENT_DELETE
      "transaction" => CAP_STATEMENT_TRANSACTION
      "pragma" => CAP_STATEMENT_PRAGMA
      _ => false
    }
    guard enabled else {
      fail("catalog capability disabled: statement " + name)
    }
  }
}

// Source: cast.mbt

///|
/// CAST integer reads a decimal prefix (unlike numeric affinity), saturating int64.
fn cast_integer(value : Value) -> Int64 {
  match value {
    Integer(n) => n
    Real(n) =>
      if n >= 9223372036854775808.0 {
        9223372036854775807L
      } else if n <= -9223372036854775808.0 {
        -9223372036854775808L
      } else {
        n.to_int64()
      }
    _ => {
      let bytes = @utf8.encode(
        text_value(value).trim_start(chars=" \t\n\r\u{b}\u{c}").to_owned(),
      )
      let negative = bytes.length() > 0 && bytes[0] == b'-'
      let start = if bytes.length() > 0 &&
        (bytes[0] == b'-' || bytes[0] == b'+') {
        1
      } else {
        0
      }
      let mut end = start
      while end < bytes.length() && bytes[end] >= b'0' && bytes[end] <= b'9' {
        end += 1
      }
      if end == start {
        return 0L
      }
      @string.parse_int64(@utf8.decode_lossy(bytes[0:end])) catch {
        _ => if negative { -9223372036854775808L } else { 9223372036854775807L }
      }
    }
  }
}

///|
fn cast_value(value : Value, target : String) -> Value raise SqlError {
  if value is Null {
    return Null
  }
  match target {
    "integer" => Integer(cast_integer(value))
    "text" => Text(checked_text_value(value))
    "blob" =>
      match value {
        Blob(_) => value
        _ => Blob(@utf8.encode(text_value(value)))
      }
    "real" =>
      match cast_numeric(value) {
        Integer(n) => Real(n.to_double())
        Real(_) as v => v
        _ => Real(0.0)
      }
    _ =>
      match value {
        Integer(_) | Real(_) => value
        _ =>
          match cast_numeric(value) {
            Real(n) =>
              if n >= -2251799813685248.0 &&
                n < 2251799813685248.0 &&
                n.to_int64().to_double() == n {
                Integer(n.to_int64())
              } else {
                Real(n)
              }
            v => v
          }
      }
  }
}

///|
fn cast_numeric(value : Value) -> Value {
  if value is Integer(_) || value is Real(_) {
    return value
  }
  let b = @utf8.encode(
    text_value(value).trim_start(chars=" \t\n\r\u{b}\u{c}").to_owned(),
  )
  let mut end = if b.length() > 0 && (b[0] == b'-' || b[0] == b'+') {
    1
  } else {
    0
  }
  let start = end
  while end < b.length() && b[end] >= b'0' && b[end] <= b'9' {
    end += 1
  }
  let mut digits = end - start
  if end < b.length() && b[end] == b'.' {
    end += 1
    let start = end
    while end < b.length() && b[end] >= b'0' && b[end] <= b'9' {
      end += 1
    }
    digits += end - start
  }
  if digits == 0 {
    return Integer(0L)
  }
  if end < b.length() && (b[end] == b'e' || b[end] == b'E') {
    let saved = end
    end += 1
    if end < b.length() && (b[end] == b'-' || b[end] == b'+') {
      end += 1
    }
    let start = end
    while end < b.length() && b[end] >= b'0' && b[end] <= b'9' {
      end += 1
    }
    if end == start {
      end = saved
    }
  }
  parse_number(@utf8.decode_lossy(b[0:end])) catch {
    _ => Integer(0L)
  }
}

// Source: changeset.mbt

///|
/// Native SQLite Session wire format; this does not embed or invoke SQLite.
fn session_varint(out : @buffer.Buffer, n : Int32) -> Unit {
  if n >= 16384 {
    out.write_byte(((n >> 14) | 128).to_byte())
  }
  if n >= 128 {
    out.write_byte((((n >> 7) & 127) | 128).to_byte())
  }
  out.write_byte((n & 127).to_byte())
}

///|
fn session_value(out : @buffer.Buffer, value : Value) -> Unit {
  match value {
    Null => out.write_byte(b'\x05')
    Integer(n) => {
      out.write_byte(b'\x01')
      out.write_int64_be(n)
    }
    Real(n) => {
      out.write_byte(b'\x02')
      out.write_double_be(n)
    }
    Text(s) => {
      let b = @utf8.encode(s)
      out.write_byte(b'\x03')
      session_varint(out, b.length())
      out.write_bytes(b)
    }
    Blob(b) => {
      out.write_byte(b'\x04')
      session_varint(out, b.length())
      out.write_bytes(b)
    }
  }
}

///|
fn internal_table(name : String) -> Bool {
  let n = identifier(name)
  n.has_prefix("_bls_") ||
  n.has_prefix("_litestream_") ||
  n.has_prefix("sqlite_") ||
  n.has_prefix("__turso_")
}

///|
fn session_schema(table : Table) -> Unit raise SqlError {
  guard !has_generated_columns(table) else {
    fail("unsupported generated columns in Session changesets; use SQL or LTX")
  }
  let pk = primary_key(table)
  guard !pk.is_empty() &&
    pk.all(i => {
      table.columns[i].not_null ||
      integer_primary(table) == i ||
      table.without_rowid ||
      table.strict == Some(true)
    }) else {
    fail("binary mode requires declared non-null primary keys on every table")
  }
}

///|
fn session_rows_equal(table : Table, a : StoredRow, b : StoredRow) -> Bool {
  primary_key(table).all(i => a.values[i] == b.values[i])
}

///|
fn database_changeset(db : Database, before : Database) -> String {
  if !FEATURE_BINARY_SYNC {
    return ({ "error": "feature disabled: binarySync" } : Json).stringify()
  }
  try {
    let previous = before.store
    guard previous.cookie == db.store.cookie else {
      fail("DDL must use SQL mode")
    }
    let out = @buffer.Buffer()
    for table in db.store.tables {
      if internal_table(table.name) {
        continue
      }
      session_schema(table)
      let old = get_table(previous, table.name)
      let operations = @buffer.Buffer()
      for row in old.rows {
        let matching = table.rows.filter(next => {
          session_rows_equal(table, row, next)
        })
        if matching.is_empty() {
          operations.write_byte(b'\x09')
          operations.write_byte(b'\x00')
          for value in row.values {
            session_value(operations, value)
          }
        } else {
          let next = matching[0]
          if row.values == next.values {
            continue
          }
          operations.write_byte(b'\x17')
          operations.write_byte(b'\x00')
          for i, value in row.values {
            if table.columns[i].primary > 0 || value != next.values[i] {
              session_value(operations, value)
            } else {
              operations.write_byte(b'\x00')
            }
          }
          for i, value in next.values {
            if table.columns[i].primary == 0 && value != row.values[i] {
              session_value(operations, value)
            } else {
              operations.write_byte(b'\x00')
            }
          }
        }
      }
      for row in table.rows {
        if old.rows.any(previous => session_rows_equal(table, previous, row)) {
          continue
        }
        operations.write_byte(b'\x12')
        operations.write_byte(b'\x00')
        for value in row.values {
          session_value(operations, value)
        }
      }
      let data = operations.to_bytes()
      if data.length() == 0 {
        continue
      }
      guard table.columns.length() <= 255 else {
        fail("changeset column limit")
      }
      out.write_byte(b'T')
      session_varint(out, table.columns.length())
      for col in table.columns {
        out.write_byte(col.primary.to_byte())
      }
      out.write_bytes(@utf8.encode(table.name))
      out.write_byte(b'\x00')
      out.write_bytes(data)
    }
    let data = out.to_bytes()
    guard data.length() <= 1048576 else { fail("changeset resource limit") }
    ({ "data": data.to_array().map(b => b.to_int()) } : Json).stringify()
  } catch {
    e => ({ "error": public_error(e) } : Json).stringify()
  }
}

///|
pub fn database_is_readonly(sql : String) -> Bool {
  try {
    match parse_statement(lex(sql)) {
      Select(_) | Pragma(_, _, None) => true
      _ => false
    }
  } catch {
    _ => false
  }
}

// Source: compound.mbt

///|
#derive(ToJson)
priv struct LegacySelection {
  ctes : Array[(String, Selection)]
  projections : Array[Projection]
  sources : Array[Source]
  predicate : Expr
  groups : Array[Expr]
  having : Expr
  orders : Array[Ordering]
  limit : Expr
  offset : Expr
  distinct : Bool
}

///|
impl @json.ToJson for Selection with fn to_json(self) {
  let old : LegacySelection = {
    ctes: self.ctes,
    projections: self.projections,
    sources: self.sources,
    predicate: self.predicate,
    groups: self.groups,
    having: self.having,
    orders: self.orders,
    limit: self.limit,
    offset: self.offset,
    distinct: self.distinct,
  }
  let json = @json.to_json(old)
  if json is Object(fields) {
    if self.compound is Some(v) {
      fields["compound"] = @json.to_json(v)
    }
    if self.recursive is Some(v) {
      fields["recursive"] = @json.to_json(v)
    }
    if self.cte_names is Some(v) {
      fields["cte_names"] = @json.to_json(v)
    }
  }
  json
}

///|
fn compound_relation(
  select : Selection,
  context : Evaluation,
  existence : Bool,
) -> Relation raise SqlError {
  let output = selection_template(select, context)
  let ctes : Map[String, Relation] = Map(context.ctes.to_array())
  if CAP_QUERY_CTE {
    for (name, selection) in select.ctes {
      ctes[identifier(name)] = execute_cte(select, name, selection, {
        ..context,
        ctes,
      })
    }
  }
  let ctx = { ..context, ctes, }
  let core = {
    ..select,
    ctes: [],
    compound: None,
    orders: [],
    limit: Literal(Integer(-1L)),
    offset: Literal(Integer(0L)),
  }
  let mut rows = select_relation_in(core, ctx, false).rows
  fn same(a : Environment, b : Environment) -> Bool {
    a.length() == b.length() &&
    a
    .mapi((i, v) => {
      compare_stored(context.store, v.value, b[i].value, output[i].collation) ==
      0
    })
    .all(v => v)
  }
  if select.compound is Some(arms) {
    for (op, arm) in arms {
      let right = select_relation_in(arm, ctx, false).rows
      if op == "union all" {
        rows = rows + right
      } else {
        let candidates = if op == "union" { rows + right } else { rows }
        let next : Array[Environment] = []
        for row in candidates {
          let present = right.any(r => same(row, r))
          if op == "union" {
            let mut duplicate = -1
            for i, previous in next {
              if same(row, previous) {
                duplicate = i
                break
              }
            }
            if duplicate >= 0 {
              next[duplicate] = row
              continue
            }
          }
          if ((op == "intersect" && !present) || (op == "except" && present)) ||
            next.any(r => same(row, r)) {
            continue
          }
          next.push(row)
        }
        next.sort_by((a, b) => {
          for i, field in output {
            let c = compare_stored(
              context.store,
              a[i].value,
              b[i].value,
              field.collation,
            )
            if c != 0 {
              return c
            }
          }
          0
        })
        rows = next
      }
      guard rows.length() <= 100000 else { fail("SQL result resource limit") }
    }
  }
  rows = rows.map(row => row.mapi((i, b) => { ..output[i], value: b.value, }))
  let ranked = rows.mapi((i, row) => {
    output: row,
    context: { ..ctx, row, position: i, },
    keys: if CAP_QUERY_ORDER_BY {
      select.orders.map(o => {
        row[compound_order_index(
          select,
          ordering_expression(o.expression),
          output.length(),
        )].value
      })
    } else {
      []
    },
  })
  if CAP_QUERY_ORDER_BY {
    sort_query_rows(
      ranked,
      select.orders,
      select.orders.map(o => {
        match ordering_expression(o.expression) {
          Collate(_, name) => name
          _ =>
            output[compound_order_index(
              select,
              ordering_expression(o.expression),
              output.length(),
            )].collation
        }
      }),
    )
  }
  let selected = if CAP_QUERY_LIMIT_OFFSET {
    let (count, start) = query_limit(select, ctx)
    ranked
    .mapi((i, r) => (i, r.output))
    .filter(p => {
      p.0.to_int64() >= start.max(0L) &&
      (count < 0L || p.0.to_int64() - start.max(0L) < count)
    })
    .map(p => p.1)
  } else {
    ranked.map(r => r.output)
  }
  {
    rows: if existence {
      selected.map(_ => [])
    } else {
      selected
    },
    template: output,
  }
}

///|
fn compound_order_index(
  select : Selection,
  e : Expr,
  width : Int32,
) -> Int32 raise SqlError {
  let e = match e {
    Collate(inner, _) => inner
    _ => e
  }
  if e is Literal(Integer(n)) {
    guard n >= 1L && n <= width.to_int64() else {
      fail("ORDER BY position out of range")
    }
    return n.to_int() - 1
  }
  let arms = [select] + select.compound.unwrap_or([]).map(p => p.1)
  for arm in arms {
    for i, p in arm.projections {
      if (e is Column("", name) && identifier(name) == identifier(p.label)) ||
        @json.to_json(e) == @json.to_json(p.expression) {
        return i
      }
    }
  }
  fail("ORDER BY term does not match a result column")
}

// Source: compound_metadata.mbt

///|
/// sqlite3SubqueryColumnTypes / sqlite3ExprDataType, SQLite 3.53/3.54.
/// A derived compound column is distinct from a scalar subquery's rightmost
/// expression affinity. Preserve values; only derive their comparison metadata.
fn compound_probe(
  select : Selection,
  e : Expr,
  context : Evaluation,
) -> Environment raise SqlError {
  selection_template(
    {
      ..select,
      ctes: [],
      projections: [
        { expression: e, explicit_label: true, label: "$metadata", },
      ],
      predicate: yes(),
      groups: [],
      having: yes(),
      orders: [],
      compound: None,
      distinct: false,
      limit: Literal(Integer(-1L)),
      offset: Literal(Integer(0L)),
    },
    context,
  )
}

///|
fn compound_affinity_types(affinity : String) -> Int32 {
  if ["integer", "numeric", "real"].contains(affinity) {
    5
  } else if affinity == "text" {
    6
  } else {
    7
  }
}

///|
fn compound_expression_types(
  e : Expr,
  select : Selection,
  context : Evaluation,
  affinity~ : String? = None,
) -> Int32 raise SqlError {
  match e {
    Literal(Null) => 0
    Literal(Text(_)) => 2
    Literal(Blob(_)) => 4
    Literal(_) => 1
    Collate(inner, _) =>
      compound_expression_types(inner, select, context, affinity~)
    Unary("+", inner) => compound_expression_types(inner, select, context)
    Column(_, _) | Cast(_, _) | ScalarSelect(_) =>
      compound_affinity_types(
        affinity.unwrap_or_else(() => {
          compound_probe(select, e, context)[0].affinity
        }),
      )
    TruthLiteral(value) =>
      // TRUE/FALSE can resolve to a source column, including a column having
      // no affinity. Probe the identifier, not the literal fallback.
      compound_affinity_types(
        compound_probe(
          select,
          Column("", if value { "true" } else { "false" }),
          context,
        )[0].affinity,
      ) catch {
        SqlError(message) =>
          if message.has_prefix("no such column") {
            1
          } else {
            fail(message)
          }
        error => raise error
      }
    Case(_, arms, otherwise) => {
      let mut types = compound_expression_types(otherwise, select, context)
      for (_, value) in arms {
        types = types | compound_expression_types(value, select, context)
      }
      types
    }
    Binary("||", _, _) => 6
    Call(_, _)
    | CurrentTime(_)
    | Parameter(_)
    | Window(_, _, _, _, _)
    | RowNumber(_) => 7
    _ => 1
  }
}

///|
fn compound_projection_origins(
  select : Selection,
  context : Evaluation,
) -> Array[Expr?] raise SqlError {
  let result : Array[Expr?] = []
  for p in select.projections {
    if p.expression is Star(_) {
      for _ in compound_probe(select, p.expression, context) {
        result.push(None)
      }
    } else {
      result.push(Some(p.expression))
    }
  }
  result
}

///|
fn compound_column_template(
  select : Selection,
  context : Evaluation,
  templates : Array[Environment],
) -> Environment raise SqlError {
  if templates.length() <= 1 {
    return templates[0]
  }
  let arms = [{ ..select, ctes: [], compound: None, }] +
    select.compound.unwrap_or([]).map(p => p.1)
  let origins = arms.map(arm => compound_projection_origins(arm, context))
  let type_at = fn(arm : Int32, column : Int32) -> Int32 raise SqlError {
    match origins[arm][column] {
      Some(e) =>
        compound_expression_types(
          e,
          arms[arm],
          context,
          affinity=Some(templates[arm][column].affinity),
        )
      None => compound_affinity_types(templates[arm][column].affinity)
    }
  }
  templates[0].mapi((column, binding) => {
    let mut chosen = 0
    let mut affinity = binding.affinity
    let mut types = 0
    while affinity == "" && chosen + 1 < templates.length() {
      types = types | type_at(chosen, column)
      chosen += 1
      affinity = templates[chosen][column].affinity
    }
    if affinity != "" {
      for i in (chosen + 1)..<templates.length() {
        types = types | type_at(i, column)
      }
      if (affinity == "text" && (types & 1) != 0) ||
        (["integer", "numeric", "real"].contains(affinity) && (types & 2) != 0) {
        affinity = "blob"
      }
      // FLEXNUM preserves the source cells. NUMERIC is its comparison affinity;
      // CTAS over compounds remains rejected until initial storage is modeled.
      if ["integer", "numeric", "real"].contains(affinity) &&
        origins[0][column] is Some(Cast(_, _)) {
        affinity = "numeric"
      }
    }
    { ..binding, affinity, }
  })
}

// Source: create_table_as.mbt

///|
/// CTAS persists a normalized CREATE TABLE, never the source SELECT. SQL text
/// formatting follows SQLite build.c (public domain), including its width rule.
fn ctas_identifier(name : String) -> String {
  let bytes = @utf8.encode(name)
  let safe = !bytes.is_empty() &&
    !(bytes[0] >= b'0' && bytes[0] <= b'9') &&
    bytes
    .to_array()
    .all(b => {
      (b >= b'a' && b <= b'z') ||
      (b >= b'A' && b <= b'Z') ||
      (b >= b'0' && b <= b'9') ||
      b == b'_'
    })
  let keywords = " abort action add after all alter always analyze and as asc attach autoincrement before begin between by cascade case cast check collate column commit conflict constraint create cross current current_date current_time current_timestamp database default deferrable deferred delete desc detach distinct do drop each else end escape except exclude exclusive exists explain fail filter first following for foreign from full generated glob group groups having if ignore immediate in index indexed initially inner insert instead intersect into is isnull join key last left like limit match materialized natural no not nothing notnull null nulls of offset on or order others outer over partition plan pragma preceding primary query raise range recursive references regexp reindex release rename replace restrict returning right rollback row rows savepoint select set table temp temporary then ties to transaction trigger unbounded union unique update using vacuum values view virtual when where window with without "
  if safe && !keywords.contains(" " + identifier(name) + " ") {
    name
  } else {
    "\"" + name.replace(old="\"", new="\"\"") + "\""
  }
}

///|
fn ctas_identifier_length(name : String) -> Int32 {
  @utf8.encode(name).length() +
  @utf8.encode(name).to_array().filter(b => b == b'"').length() +
  2
}

///|
fn ctas_sql(name : String, columns : Array[ColumnDef]) -> String {
  let width = columns.fold(init=ctas_identifier_length(name), (n, c) => {
    n + ctas_identifier_length(c.name) + 5
  })
  let multiline = width >= 50
  "CREATE TABLE " +
  ctas_identifier(name) +
  "(" +
  (if multiline { "\n  " } else { "" }) +
  columns
  .map(c => {
    ctas_identifier(c.name) +
    (if c.declared == "" { "" } else { " " + c.declared })
  })
  .join(if multiline { ",\n  " } else { "," }) +
  (if multiline { "\n)" } else { ")" })
}

///|
fn ctas_column_name(
  name : String,
  names : Map[String, Bool],
) -> String raise SqlError {
  let mut candidate = name
  let mut suffix = 0
  while names.contains(identifier(candidate)) {
    guard suffix < 4 else {
      fail(
        "unsupported CTAS random duplicate column suffix; use explicit aliases",
      )
    }
    let bytes = @utf8.encode(candidate)
    let mut j = bytes.length() - 1
    while j > 0 && bytes[j] >= b'0' && bytes[j] <= b'9' {
      j -= 1
    }
    let base = if j >= 0 && bytes[j] == b':' {
      @utf8.decode_lossy(bytes[0:j])
    } else {
      candidate
    }
    suffix += 1
    candidate = base + ":" + suffix.to_string()
  }
  names[identifier(candidate)] = true
  candidate
}

///|
/// Compound-derived affinities have additional SQLite rules. Reject them until
/// those metadata rules are implemented; ordinary SELECT/CTE/JOIN remain usable.
fn validate_ctas_selection(
  store : Store,
  select : Selection,
  build_only : Bool,
  depth : Int32,
) -> Unit raise SqlError {
  guard depth <= 16 else { fail("CTAS query recursion limit") }
  guard select.compound.unwrap_or([]).is_empty() else {
    fail("unsupported compound affinity in CTAS")
  }
  for (_, cte) in select.ctes {
    validate_ctas_selection(store, cte, build_only, depth + 1)
  }
  for source in select.sources {
    validate_ctas_expression(store, source.on, build_only, depth)
    for object in store.objects {
      if object.kind == "view" &&
        matches_identifier(object.name, identifier(source.name)) &&
        object.selection is Some(view) {
        validate_ctas_selection(store, view, build_only, depth + 1)
      }
    }
  }
  for p in select.projections {
    validate_ctas_expression(store, p.expression, build_only, depth)
  }
  for e in select.groups {
    validate_ctas_expression(store, e, build_only, depth)
  }
  for o in select.orders {
    validate_ctas_expression(store, o.expression, build_only, depth)
  }
  for e in [select.predicate, select.having, select.limit, select.offset] {
    validate_ctas_expression(store, e, build_only, depth)
  }
}

///|
fn validate_ctas_expression(
  store : Store,
  e : Expr,
  build_only : Bool,
  depth : Int32,
) -> Unit raise SqlError {
  match e {
    CurrentTime(_) => {
      guard !build_only else { fail("nondeterministic clock in catalog CTAS") }
    }
    Unary(_, e) | Cast(e, _) | Collate(e, _) =>
      validate_ctas_expression(store, e, build_only, depth)
    Binary(_, a, b) => {
      validate_ctas_expression(store, a, build_only, depth)
      validate_ctas_expression(store, b, build_only, depth)
    }
    Between(e, a, b) =>
      for item in [e, a, b] {
        validate_ctas_expression(store, item, build_only, depth)
      }
    Case(base, arms, otherwise) => {
      if base is Some(e) {
        validate_ctas_expression(store, e, build_only, depth)
      }
      for (a, b) in arms {
        validate_ctas_expression(store, a, build_only, depth)
        validate_ctas_expression(store, b, build_only, depth)
      }
      validate_ctas_expression(store, otherwise, build_only, depth)
    }
    Call(name, args) => {
      guard !build_only ||
        (
          (function_features(name) & 32U) == 0U &&
          !["changes", "last_insert_rowid", "random", "randomblob"].contains(
            name,
          )
        ) else {
        fail("nondeterministic function in catalog CTAS: " + name)
      }
      for arg in args {
        validate_ctas_expression(store, arg, build_only, depth)
      }
    }
    InSelect(left, select) => {
      validate_ctas_expression(store, left, build_only, depth)
      validate_ctas_selection(store, select, build_only, depth + 1)
    }
    ScalarSelect(select) | Exists(select) =>
      validate_ctas_selection(store, select, build_only, depth + 1)
    RowNumber(orders) =>
      for o in orders {
        validate_ctas_expression(store, o.expression, build_only, depth)
      }
    Window(_, args, partitions, orders, frame) => {
      for bound in [frame.start, frame.end] {
        match bound {
          Preceding(value) | Following(value) =>
            validate_ctas_expression(store, value, build_only, depth)
          _ => ()
        }
      }
      for e in args + partitions {
        validate_ctas_expression(store, e, build_only, depth)
      }
      for o in orders {
        validate_ctas_expression(store, o.expression, build_only, depth)
      }
    }
    _ => ()
  }
}

///|
fn create_table_as(
  store : Store,
  name : String,
  select : Selection,
  params : Array[Value],
) -> Table raise SqlError {
  guard !identifier(name).has_prefix("sqlite_") else {
    fail("reserved table name: " + name)
  }
  validate_ctas_selection(store, select, false, 0)
  let naming = {
    ..select,
    projections: select.projections.map(p => {
      let mut expression = p.expression
      while expression is Collate(inner, _) {
        expression = inner
      }
      if !p.explicit_label && expression is Column(_, _) {
        { ..p, expression, }
      } else {
        p
      }
    }),
  }
  let template = selection_template(naming, evaluation(store, params, []))
  guard !template.is_empty() && template.length() <= 2000 else {
    fail("CTAS column resource limit")
  }
  let names : Map[String, Bool] = Map([])
  let columns = template.mapi((i, b) => {
    let label = if ["true", "false"].contains(identifier(b.name)) {
      "column" + (i + 1).to_string()
    } else {
      b.name
    }
    let declared = match b.affinity {
      "text" => "TEXT"
      "numeric" => "NUM"
      "integer" => "INT"
      "real" => "REAL"
      _ => ""
    }
    (
      {
        name: ctas_column_name(label, names),
        declared,
        not_null: false,
        primary: 0,
        primary_desc: None,
        default_value: Literal(Null),
        default_source: Some(""),
        collation: "binary",
      } : ColumnDef)
  })
  let selected = select_rows(store, select, params, 0)
  guard selected.length() <= 100000 else { fail("CTAS row resource limit") }
  let rows = selected.mapi((i, row) => {
    (
      {
        id: (i + 1).to_int64(),
        values: row
        .filter(b => !b.hidden)
        .mapi((j, b) => {
          apply_affinity(b.value, affinity_name(columns[j].declared))
        }),
      } : StoredRow)
  })
  {
    name,
    sql: ctas_sql(name, columns),
    columns,
    unique_keys: [],
    checks: [],
    foreign_keys: [],
    without_rowid: false,
    strict: None,
    autoincrement: false,
    sequence: 0L,
    sequence_present: None,
    rows: row_pages(rows),
  }
}

// Source: cte.mbt

///|
fn cte_names(
  owner : Selection,
  name : String,
  relation : Relation,
) -> Relation raise SqlError {
  if name.has_prefix("\u{0}derived:") {
    let seen : Map[String, Bool] = Map([])
    for binding in relation.template {
      let column = identifier(binding.name)
      guard !seen.contains(column) else {
        fail("unsupported derived-table duplicate column names")
      }
      seen[column] = true
    }
  }
  if owner.cte_names is Some(names) {
    for (n, columns) in names {
      if identifier(n) != identifier(name) {
        continue
      }
      guard columns.length() == relation.template.length() else {
        fail("CTE column count mismatch")
      }
      return {
        template: relation.template.mapi((i, b) => {
          ..b,
          name: columns[i],
          display_name: columns[i],
        }),
        rows: relation.rows.map(row => {
          row.mapi((i, b) => {
            ..b,
            name: columns[i],
            display_name: columns[i],
          })
        }),
      }
    }
  }
  relation
}

///|
fn recursive_cte(owner : Selection, name : String, query : Selection) -> Bool {
  owner.recursive == Some(true) &&
  query.compound
  .map(arms => {
    arms.any(p => p.1.sources.any(s => identifier(s.name) == identifier(name)))
  })
  .unwrap_or(false)
}

///|
fn prepare_cte(
  owner : Selection,
  name : String,
  query : Selection,
  ctx : Evaluation,
) -> Relation raise SqlError {
  if CAP_QUERY_RECURSIVE_CTE && recursive_cte(owner, name, query) {
    let seed = {
      ..query,
      compound: None,
      orders: [],
      limit: Literal(Integer(-1L)),
      offset: Literal(Integer(0L)),
    }
    let relation = cte_names(owner, name, {
      template: selection_template(seed, { ..ctx, depth: ctx.depth + 1, }),
      rows: [],
    })
    ctx.ctes[identifier(name)] = relation
  }
  cte_names(owner, name, {
    template: selection_template(query, { ..ctx, depth: ctx.depth + 1, }),
    rows: [],
  })
}

///|
fn execute_cte(
  owner : Selection,
  name : String,
  query : Selection,
  ctx : Evaluation,
) -> Relation raise SqlError {
  if !CAP_QUERY_RECURSIVE_CTE || !recursive_cte(owner, name, query) {
    return cte_names(
      owner,
      name,
      select_relation_in(query, { ..ctx, depth: ctx.depth + 1, }, false),
    )
  }
  execute_recursive_cte(owner, name, query, ctx)
}

///|
fn execute_recursive_cte(
  owner : Selection,
  name : String,
  query : Selection,
  ctx : Evaluation,
) -> Relation raise SqlError {
  guard query.compound is Some(arms) && query.orders.is_empty() else {
    fail("unsupported recursive CTE ordering")
  }
  guard arms.all(p => p.0 == "union" || p.0 == "union all") else {
    fail("recursive CTE requires UNION")
  }
  let template = prepare_cte(owner, name, query, ctx).template
  let core = {
    ..query,
    compound: None,
    orders: [],
    limit: Literal(Integer(-1L)),
    offset: Literal(Integer(0L)),
  }
  let seed = cte_names(owner, name, select_relation_in(core, ctx, false))
  let queue : Array[Environment] = []
  let result : Array[Environment] = []
  let distinct = arms[0].0 == "union"
  fn enqueue(row : Environment) -> Unit {
    if !distinct ||
      !queue.any(r => {
        r
        .mapi((i, b) => {
          compare_stored(
            ctx.store,
            b.value,
            row[i].value,
            template[i].collation,
          ) ==
          0
        })
        .all(v => v)
      }) {
      queue.push(row)
    }
  }
  for row in seed.rows {
    enqueue(row)
  }
  let limit = apply_affinity(evaluate(query.limit, ctx), "integer")
  let offset = apply_affinity(evaluate(query.offset, ctx), "integer")
  guard limit is Integer(count) && offset is Integer(skip) else {
    fail("datatype mismatch: LIMIT/OFFSET")
  }
  let mut cursor = 0
  while cursor < queue.length() {
    guard cursor < 100000 && queue.length() <= 100000 else {
      fail("recursive CTE resource limit")
    }
    if count >= 0L && result.length().to_int64() >= count {
      break
    }
    let row = queue[cursor]
    if cursor.to_int64() >= skip.max(0L) {
      result.push(row)
    }
    ctx.ctes[identifier(name)] = { template, rows: [row], }
    for (_, arm) in arms {
      let next = cte_names(owner, name, select_relation_in(arm, ctx, false))
      for r in next.rows {
        enqueue(r)
      }
    }
    cursor += 1
  }
  { template, rows: result, }
}

// Source: data.mbt

///|
/// Parser-free data execution shared by SQL and precompiled entry points.
fn execute_data_statement(
  store : Store,
  statement : DataStatement,
  params : Array[Value],
  prepared_selection~ : PreparedSelection? = None,
  prepared_update~ : PreparedUpdatePlan? = None,
) -> Array[Environment] raise SqlError {
  let previous = store.triggers.prior_changes
  store.triggers.prior_changes = connection_changes(store)
  store.triggers.data_depth += 1
  if !data_readonly(statement) {
    store.triggers.failed_statement = false
  }
  defer {
    store.triggers.prior_changes = previous
    store.triggers.data_depth -= 1
  }
  let result = match statement {
    PreparedTransaction(op, name) => {
      guard CAP_STATEMENT_TRANSACTION else {
        fail("catalog capability disabled: transaction")
      }
      return execute_transaction(store, op, name)
    }
    PreparedSelect(select) => {
      guard CAP_STATEMENT_SELECT else {
        fail("catalog capability disabled: select")
      }
      if CAP_QUERY_SOURCE &&
        prepared_selection is Some(metadata) &&
        metadata.point is Some(plan) &&
        execute_bound_point(plan, store, params) is Some(rows) {
        return rows
      }
      return select_rows(store, select, params, 0, prepared=prepared_selection)
    }
    PreparedPragma(name, table) => {
      guard CAP_STATEMENT_PRAGMA else {
        fail("catalog capability disabled: pragma")
      }
      return execute_pragma(store, name, table, None, params)
    }
    PreparedInsert(insertion) => {
      guard CAP_STATEMENT_INSERT else {
        fail("catalog capability disabled: insert")
      }
      insert_rows(store, insertion, params)
    }
    PreparedUpdate(name, setters, predicate, returning) => {
      guard CAP_STATEMENT_UPDATE else {
        fail("catalog capability disabled: update")
      }
      if FEATURE_UPDATE_FROM && update_from_expression(predicate) {
        let plan = match prepared_update {
          Some(plan) => plan
          None => {
            let (plan, _) = prepare_update(
              store,
              name,
              setters,
              predicate,
              returning,
              params.length(),
            )
            plan
          }
        }
        execute_update_from(store, plan, params, returning)
      } else {
        execute_update(
          store, name, setters, predicate, returning, params, prepared_update,
        )
      }
    }
    PreparedDelete(name, predicate, returning) => {
      guard CAP_STATEMENT_DELETE else {
        fail("catalog capability disabled: delete")
      }
      let table = get_table(store, name)
      prepare_foreign_table(store, table)
      prepare_trigger_event(store, table, "delete", [])
      let with_triggers = store.objects.any(o => {
        o.kind == "trigger" &&
        matches_identifier(o.table, identifier(table.name))
      })
      let rows : Array[Environment] = []
      store.changes = 0
      let template = row_environment(
        table,
        { id: 0L, values: Array::make(table.columns.length(), Null), },
        table.name,
      )
      prepare_expression(
        predicate,
        evaluation(store, params, template),
        false,
        false,
      )
      prepare_returning(returning, evaluation(store, params, template))
      let in_lists = in_list_frames(
        statement_in_lists(
          [predicate] + returning.map(p => p.expression),
          evaluation(store, params, template),
        ),
      )
      for
        candidate in primary_candidates(store, table, predicate, params, name).unwrap_or_else(() => {
            candidate_rows(
              store,
              table,
              rowid_equality(table, predicate, params, name),
            )
          },
        ) {
        let row = if with_triggers {
          guard table_row_by_id(store, table, candidate.id) is Some(current) else {
            continue
          }
          current
        } else {
          candidate
        }
        let ctx = {
          ..evaluation(store, params, row_environment_from(template, row)),
          in_lists,
        }
        if truth(evaluate(predicate, ctx)) != 1 {
          continue
        }
        if delete_row(store, table, row, 0, true) {
          if !returning.is_empty() {
            rows.push(project(returning, ctx))
          }
          store.changes += 1
        }
      }
      rows
    }
  }
  if !store.deferred && store.triggers.active.is_empty() {
    validate_foreign_keys(store, immediate=true)
  }
  result
}

///|
fn updated_row_from_plan(
  plan : PreparedUpdatePlan,
  previous : StoredRow,
  input : BoundInput,
) -> StoredRow raise SqlError {
  let values = previous.values.copy()
  for setter in plan.setters {
    values[setter.column] = apply_affinity(
      evaluate_bound(setter.expression, input),
      setter.affinity,
    )
  }
  finish_updated_row(previous, values, plan.integer_primary)
}

// Source: datetime.mbt

///|
/// Proleptic Gregorian arithmetic, independent of host Date/timezone APIs.
fn date_floor(a : Int64, b : Int64) -> Int64 {
  let q = a / b
  if a % b < 0L {
    q - 1L
  } else {
    q
  }
}

///|
fn civil_days(year : Int64, month : Int64, day : Int64) -> Int64 {
  let y = year - (if month <= 2L { 1L } else { 0L })
  let era = date_floor(y, 400L)
  let yoe = y - era * 400L
  let m = month + (if month > 2L { -3L } else { 9L })
  era * 146097L +
  yoe * 365L +
  yoe / 4L -
  yoe / 100L +
  (153L * m + 2L) / 5L +
  day -
  1L -
  719468L
}

///|
fn date_civil(days : Int64) -> (Int64, Int64, Int64) {
  let z = days + 719468L
  let era = date_floor(z, 146097L)
  let doe = z - era * 146097L
  let yoe = (doe - doe / 1460L + doe / 36524L - doe / 146096L) / 365L
  let y = yoe + era * 400L
  let doy = doe - (365L * yoe + yoe / 4L - yoe / 100L)
  let mp = (5L * doy + 2L) / 153L
  let d = doy - (153L * mp + 2L) / 5L + 1L
  let m = mp + (if mp < 10L { 3L } else { -9L })
  (y + (if m <= 2L { 1L } else { 0L }), m, d)
}

///|
fn date_pad(n : Int64, width : Int32) -> String {
  let s = n.abs().to_string()
  (if n < 0L { "-" } else { "" }) + decimal_zeros(width - s.length()) + s
}

///|
fn date_digits(b : Bytes, start : Int32, count : Int32) -> Int64? {
  if start < 0 || start + count > b.length() {
    return None
  }
  let mut value = 0L
  for i in start..<(start + count) {
    if b[i] < b'0' || b[i] > b'9' {
      return None
    }
    value = value * 10L + (b[i].to_int() - 48).to_int64()
  }
  Some(value)
}

///|
fn date_parse(
  value : Value,
  epoch : Bool,
  auto : Bool,
  clock : Int64?,
) -> Int64? {
  if value is Null {
    return None
  }
  if identifier(text_value(value)) == "now" {
    return clock
  }
  let raw = text_value(value)
  let number = match value {
    Integer(n) => Some(n.to_double())
    Real(n) => Some(n)
    _ =>
      match cast_numeric(value) {
        Integer(_) | Real(_) =>
          Some(@string.parse_double(raw)) catch {
            _ => None
          }
        _ => None
      }
  }
  if number is Some(n) {
    let ms = if epoch || (auto && (n < 0.0 || n >= 5373484.5)) {
      n * 1000.0
    } else {
      (n - 2440587.5) * 86400000.0
    }
    if !ms.is_finite() || ms < -210866760000000.0 || ms > 253402300799999.0 {
      return None
    }
    return Some((ms + 210866760000000.5).to_int64() - 210866760000000L)
  }
  let b = @utf8.encode(raw)
  let mut pos = 0
  let mut y = 2000L
  let mut m = 1L
  let mut d = 1L
  if b.length() >= 10 && b[4] == b'-' && b[7] == b'-' {
    guard date_digits(b, 0, 4) is Some(yy) &&
      date_digits(b, 5, 2) is Some(mm) &&
      date_digits(b, 8, 2) is Some(dd) else {
      return None
    }
    y = yy
    m = mm
    d = dd
    pos = 10
    if m < 1L || m > 12L || d < 1L || d > 31L {
      return None
    }
    while pos < b.length() && (b[pos] == b' ' || b[pos] == b'T') {
      pos += 1
    }
  }
  let mut hour = 0L
  let mut minute = 0L
  let mut second = 0L
  let mut fraction = 0L
  if pos < b.length() && b[pos] != b'Z' && b[pos] != b'z' {
    guard pos + 5 <= b.length() &&
      b[pos + 2] == b':' &&
      date_digits(b, pos, 2) is Some(h) &&
      date_digits(b, pos + 3, 2) is Some(mi) else {
      return None
    }
    hour = h
    minute = mi
    pos += 5
    if pos < b.length() && b[pos] == b':' {
      guard date_digits(b, pos + 1, 2) is Some(sec) else { return None }
      second = sec
      pos += 3
      if pos < b.length() && b[pos] == b'.' {
        pos += 1
        let start = pos
        while pos < b.length() && b[pos] >= b'0' && b[pos] <= b'9' {
          pos += 1
        }
        if pos == start {
          return None
        }
        let digits = @utf8.decode_lossy(b[start:pos]) + "000"
        fraction = ((@string.parse_double("0." + digits) catch { _ => 0.0 }) *
        1000.0 +
        0.5).to_int64()
      }
    }
    if hour > 24L || minute > 59L || second > 59L {
      return None
    }
  }
  let mut offset = 0L
  while pos < b.length() && b[pos] == b' ' {
    pos += 1
  }
  if pos < b.length() && (b[pos] == b'+' || b[pos] == b'-') {
    let sign = if b[pos] == b'-' { -1L } else { 1L }
    guard pos + 6 <= b.length() &&
      b[pos + 3] == b':' &&
      date_digits(b, pos + 1, 2) is Some(h) &&
      date_digits(b, pos + 4, 2) is Some(mi) &&
      h <= 14L &&
      mi < 60L else {
      return None
    }
    offset = sign * (h * 60L + mi) * 60000L
    pos += 6
  } else if pos < b.length() && (b[pos] == b'Z' || b[pos] == b'z') {
    pos += 1
  }
  while pos < b.length() && b[pos] == b' ' {
    pos += 1
  }
  if pos != b.length() || b.length() == 0 {
    return None
  }
  Some(
    civil_days(y, m, d) * 86400000L +
    hour * 3600000L +
    minute * 60000L +
    second * 1000L +
    fraction -
    offset,
  )
}

///|
fn datetime_arity(name : String, count : Int32) -> Bool {
  ["date", "time", "datetime", "julianday", "unixepoch"].contains(name) ||
  (name == "strftime" && count >= 1)
}

///|
fn datetime_call(
  name : String,
  values : Array[Value],
  clock : Int64?,
) -> Value raise SqlError {
  for value in values {
    if value is Blob(_) {
      ignore(checked_text_value(value))
    }
  }
  let begin = if name == "strftime" { 1 } else { 0 }
  if values.any(v => v is Null) {
    return Null
  }
  let input = if values.length() > begin { values[begin] } else { Text("now") }
  let mods = if values.length() > begin + 1 {
    values[begin + 1:].to_owned().map(v => identifier(text_value(v)))
  } else {
    []
  }
  let epoch = !mods.is_empty() && mods[0] == "unixepoch"
  let auto = !mods.is_empty() && mods[0] == "auto"
  guard date_parse(input, epoch, auto, clock) is Some(parsed) else {
    return Null
  }
  let mut ms = parsed
  let mut overflow = 0L
  let mut subsec = false
  for i, modifier in mods {
    if i == 0 &&
      (modifier == "unixepoch" || modifier == "auto" || modifier == "julianday") {
      continue
    }
    if modifier == "subsec" || modifier == "subsecond" {
      subsec = true
      continue
    }
    if modifier == "floor" {
      ms -= overflow * 86400000L
      overflow = 0L
      continue
    }
    if modifier == "ceiling" {
      overflow = 0L
      continue
    }
    overflow = 0L
    let days = date_floor(ms, 86400000L)
    let remainder = ms - days * 86400000L
    let (y, m, d) = date_civil(days)
    if modifier == "start of day" {
      ms = days * 86400000L
    } else if modifier == "start of month" {
      ms = civil_days(y, m, 1L) * 86400000L
    } else if modifier == "start of year" {
      ms = civil_days(y, 1L, 1L) * 86400000L
    } else if modifier.has_prefix("weekday ") {
      guard (@string.parse_int64(modifier[8:].to_owned()) catch { _ => -1L })
        is n &&
        n >= 0L &&
        n <= 6L else {
        return Null
      }
      let weekday = ((days + 4L) % 7L + 7L) % 7L
      ms += (n - weekday + 7L) % 7L * 86400000L
    } else {
      let parts = modifier.split(" ").to_array().filter(v => !v.is_empty())
      if parts.length() != 2 {
        return Null
      }
      let n = @string.parse_double(parts[0].to_owned()) catch {
        _ => return Null
      }
      let unit = parts[1].to_owned().trim_end(chars="s").to_owned()
      if unit == "month" || unit == "year" {
        let months = if unit == "year" { n * 12.0 } else { n }
        let whole = months.to_int64()
        let target = y * 12L + m - 1L + whole
        let yy = date_floor(target, 12L)
        let mm = target - yy * 12L + 1L
        let max = civil_days(yy, mm + 1L, 1L) - civil_days(yy, mm, 1L)
        ms = civil_days(yy, mm, d) * 86400000L +
          remainder +
          ((months - whole.to_double()) * 30.0 * 86400000.0).to_int64()
        overflow = (d - max).max(0L)
      } else {
        let factor = match unit {
          "day" => 86400000.0
          "hour" => 3600000.0
          "minute" => 60000.0
          "second" => 1000.0
          _ => return Null
        }
        let increment = n * factor
        if !increment.is_finite() || increment.abs() > 464269060799999.0 {
          return Null
        }
        ms += increment.to_int64()
      }
    }
  }
  if ms < -210866760000000L || ms > 253402300799999L {
    return Null
  }
  if name == "julianday" {
    return Real(ms.to_double() / 86400000.0 + 2440587.5)
  }
  if name == "unixepoch" {
    return if subsec {
      Real(ms.to_double() / 1000.0)
    } else {
      Integer(date_floor(ms, 1000L))
    }
  }
  let days = date_floor(ms, 86400000L)
  let (y, m, d) = date_civil(days)
  let rest = ms - days * 86400000L
  let hour = rest / 3600000L
  let minute = rest / 60000L % 60L
  let second = rest / 1000L % 60L
  let date = date_pad(y, 4) + "-" + date_pad(m, 2) + "-" + date_pad(d, 2)
  let time = date_pad(hour, 2) +
    ":" +
    date_pad(minute, 2) +
    ":" +
    date_pad(second, 2) +
    (if subsec { "." + date_pad(rest % 1000L, 3) } else { "" })
  if name == "date" {
    return Text(date)
  }
  if name == "time" {
    return Text(time)
  }
  if name == "datetime" {
    return Text(date + " " + time)
  }
  let format = @utf8.encode(text_value(values[0]))
  let out = @buffer.Buffer()
  let mut i = 0
  while i < format.length() {
    if format[i] != b'%' {
      out.write_byte(format[i])
      i += 1
      continue
    }
    i += 1
    if i == format.length() {
      return Null
    }
    let value = match format[i].to_int() {
      37 => "%"
      89 => date_pad(y, 4)
      109 => date_pad(m, 2)
      100 => date_pad(d, 2)
      101 => d.to_string()
      72 => date_pad(hour, 2)
      107 => hour.to_string()
      73 => date_pad((hour + 11L) % 12L + 1L, 2)
      108 => ((hour + 11L) % 12L + 1L).to_string()
      77 => date_pad(minute, 2)
      83 => date_pad(second, 2)
      102 => date_pad(second, 2) + "." + date_pad(rest % 1000L, 3)
      70 => date
      82 => date_pad(hour, 2) + ":" + date_pad(minute, 2)
      84 =>
        date_pad(hour, 2) +
        ":" +
        date_pad(minute, 2) +
        ":" +
        date_pad(second, 2)
      115 => date_floor(ms, 1000L).to_string()
      119 => (((days + 4L) % 7L + 7L) % 7L).to_string()
      117 => (((days + 3L) % 7L + 7L) % 7L + 1L).to_string()
      106 => date_pad(days - civil_days(y, 1L, 1L) + 1L, 3)
      85 =>
        date_pad(
          (days - civil_days(y, 1L, 1L) + 7L - ((days + 4L) % 7L + 7L) % 7L) /
          7L,
          2,
        )
      87 =>
        date_pad(
          (days - civil_days(y, 1L, 1L) + 7L - ((days + 3L) % 7L + 7L) % 7L) /
          7L,
          2,
        )
      86 | 71 | 103 => {
        let thursday = days + 3L - ((days + 3L) % 7L + 7L) % 7L
        let (iso_year, _, _) = date_civil(thursday)
        if format[i].to_int() == 71 {
          date_pad(iso_year, 4)
        } else if format[i].to_int() == 103 {
          date_pad(iso_year % 100L, 2)
        } else {
          date_pad((thursday - civil_days(iso_year, 1L, 1L)) / 7L + 1L, 2)
        }
      }
      112 => if hour < 12L { "AM" } else { "PM" }
      80 => if hour < 12L { "am" } else { "pm" }
      74 => text_value(Real(ms.to_double() / 86400000.0 + 2440587.5))
      _ => return Null
    }
    out.write_bytes(@utf8.encode(value))
    i += 1
  }
  Text(@utf8.decode_lossy(out.to_bytes()))
}

///|
/// One clock instant is supplied by the host before executing a statement.
pub fn database_set_clock(db : Database, milliseconds : String) -> String {
  try {
    let value = @string.parse_int64(milliseconds)
    db.store.triggers.clock = Some(value)
    "{}"
  } catch {
    e => public_error_json(e).stringify()
  }
}

// Source: evaluate.mbt

///|
/// A row carries source/affinity metadata independently of its stored values.
priv enum JoinColumn {
  SuppressedJoinColumn
  MergedJoinColumn(Value, String, String)
}

///|
priv struct Binding {
  qualifier : String
  name : String
  display_name : String
  value : Value
  affinity : String
  collation : String
  hidden : Bool
  readable : Bool
  join_column : JoinColumn?
  // 0: ordinary/primitive; 1: direct TVF container; 2: relation provenance.
  json_value : Int32
}

///|
type Environment = Array[Binding]

///|
priv struct Evaluation {
  store : Store
  params : Array[Value]
  row : Environment
  group : Array[Environment]?
  position : Int32
  outer : Array[Environment]
  ctes : Map[String, Relation]
  depth : Int32
  window_values : Map[String, Value]
  forbid_json_inputs : Bool
  row_metadata : Array[PreparedRowMetadata]
  in_lists : Array[InListFrame]
  in_selects : Array[InSelectFrame]
}

///|
priv struct QueryRow {
  output : Environment
  context : Evaluation
  keys : Array[Value]
}

///|
fn binding(name : String, value : Value) -> Binding {
  {
    qualifier: "",
    name,
    display_name: name,
    value,
    affinity: "",
    collation: "binary",
    hidden: false,
    readable: true,
    join_column: None,
    json_value: 0,
  }
}

///|
fn find_binding(
  row : Environment,
  qualifier : String,
  name : String,
) -> Binding? raise SqlError {
  let key = identifier(name)
  let scope = identifier(qualifier)
  let mut found : Binding? = None
  let mut ambiguous = false
  for original in row {
    let b = if scope == "" {
      guard unqualified_binding(original) is Some(value) else { continue }
      value
    } else {
      original
    }
    if !matches_identifier(b.name, key) {
      continue
    }
    if scope == "" {
      if matches_identifier(b.qualifier, "excluded") {
        continue
      }
      // Projected columns take precedence; retain the first duplicate label.
      if b.qualifier == "" {
        return Some(b)
      }
    } else if !matches_identifier(b.qualifier, scope) {
      continue
    }
    if found is Some(_) {
      ambiguous = true
    } else {
      found = Some(b)
    }
  }
  guard !ambiguous else { fail("ambiguous column name: " + name) }
  found
}

///|
fn find_context(
  ctx : Evaluation,
  qualifier : String,
  name : String,
) -> Binding? raise SqlError {
  if find_binding(ctx.row, qualifier, name) is Some(b) {
    return Some(b)
  }
  for row in ctx.outer {
    if find_binding(row, qualifier, name) is Some(b) {
      return Some(b)
    }
  }
  None
}

///|
fn resolve_context(
  ctx : Evaluation,
  qualifier : String,
  name : String,
) -> Binding raise SqlError {
  match find_context(ctx, qualifier, name) {
    Some(b) => {
      guard b.readable else {
        fail("unsupported physical schema column: " + b.name)
      }
      b
    }
    None =>
      fail(
        "no such column: " +
        (if qualifier == "" { "" } else { qualifier + "." }) +
        name,
      )
  }
}

///|
fn Evaluation::nested(ctx : Evaluation) -> Evaluation {
  {
    ..ctx,
    row: [],
    window_values: Map([]),
    outer: [ctx.row] + ctx.outer,
    group: None,
    position: 0,
    depth: ctx.depth + 1,
    row_metadata: [],
    in_lists: [],
    in_selects: [],
  }
}

///|
fn expression_affinity(
  expression : Expr,
  context : Evaluation,
) -> String raise SqlError {
  match expression {
    Column(q, n) => resolve_context(context, q, n).affinity
    TruthLiteral(value) =>
      find_context(context, "", if value { "true" } else { "false" })
      .map(b => b.affinity)
      .unwrap_or("")
    Cast(_, name) => name
    Collate(e, _) => expression_affinity(e, context)
    ScalarSelect(select) =>
      if CAP_EXPRESSION_SUBQUERY {
        selection_template(
          subquery_metadata_selection(select),
          context.nested(),
        )[0].affinity
      } else {
        fail("catalog capability disabled: expression subquery")
      }
    _ => ""
  }
}

///|
fn expression_collation(
  expression : Expr,
  context : Evaluation,
) -> String raise SqlError {
  if explicit_collation(expression) is Some(name) {
    return name
  }
  match expression {
    Cast(e, _) | Unary("+", e) => expression_collation(e, context)
    Collate(_, name) => name
    Column(q, n) => resolve_context(context, q, n).collation
    TruthLiteral(value) =>
      find_context(context, "", if value { "true" } else { "false" })
      .map(b => b.collation)
      .unwrap_or("binary")
    ScalarSelect(_) => "binary"
    _ => "binary"
  }
}

///|
fn evaluate(expression : Expr, ctx : Evaluation) -> Value raise SqlError {
  match expression {
    Literal(value) => expression_value(value, ctx.store)
    CurrentTime(name) => {
      guard FEATURE_DATETIME else { fail("feature disabled: dateTime") }
      datetime_call(name, [Text("now")], ctx.store.triggers.clock)
    }
    TruthLiteral(value) =>
      match find_context(ctx, "", if value { "true" } else { "false" }) {
        Some(b) => b.value
        None => boolean(value)
      }
    Parameter(index) => {
      guard index < ctx.params.length() else { fail("missing SQL binding") }
      expression_value(ctx.params[index], ctx.store)
    }
    Column(qualifier, name) =>
      expression_value(resolve_context(ctx, qualifier, name).value, ctx.store)
    Star(_) => fail("SQL * outside result columns or COUNT")
    Cast(e, name) =>
      if CAP_EXPRESSION_CAST {
        guard name != "blob" || ctx.store.encoding.unwrap_or(1) == 1 else {
          fail("unsupported SQL: TEXT to BLOB cast in UTF-16 database")
        }
        cast_value(evaluate(e, ctx), name)
      } else {
        fail("catalog capability disabled: expression cast")
      }
    Collate(e, _) => evaluate(e, ctx)
    Window(_, _, _, _, _) => {
      guard FEATURE_WINDOWS else { fail("feature disabled: windowFunctions") }
      ctx.window_values
      .get(@json.to_json(expression).stringify())
      .unwrap_or(Null)
    }
    RowNumber(_) => {
      guard FEATURE_WINDOWS else { fail("feature disabled: windowFunctions") }
      Integer((ctx.position + 1).to_int64())
    }
    Unary(op, e) => unary_value(op, evaluate(e, ctx))
    Binary(op, left, right) => {
      if FEATURE_ROW_VALUES &&
        (row_value_expression(left) || row_value_expression(right)) {
        return compare_row_values(
          op,
          row_value(left, ctx, false),
          row_value(right, ctx, false),
          ctx,
        )
      }
      let a = evaluate(left, ctx)
      let b = evaluate(right, ctx)
      if comparison_operator(op) {
        compare_expression(op, left, a, right, b, ctx)
      } else {
        binary_value(op, a, b)
      }
    }
    Between(e, low, high) =>
      if CAP_EXPRESSION_BETWEEN {
        if FEATURE_ROW_VALUES && row_value_expression(e) {
          let base = row_value(e, ctx, true)
          let low = compare_row_values(
            ">=",
            base,
            row_value(low, ctx, false),
            ctx,
          )
          let high = compare_row_values(
            "<=",
            base,
            row_value(high, ctx, false),
            ctx,
          )
          return if truth(low) == 0 || truth(high) == 0 {
            Integer(0L)
          } else if low is Null || high is Null {
            Null
          } else {
            Integer(1L)
          }
        }
        let value = evaluate(e, ctx)
        let a = compare_expression(">=", e, value, low, evaluate(low, ctx), ctx)
        let b = compare_expression(
          "<=",
          e,
          value,
          high,
          evaluate(high, ctx),
          ctx,
        )
        if truth(a) == 0 || truth(b) == 0 {
          Integer(0L)
        } else if a is Null || b is Null {
          Null
        } else {
          Integer(1L)
        }
      } else {
        fail("catalog capability disabled: expression between")
      }
    Case(base, arms, otherwise) =>
      if CAP_EXPRESSION_CASE {
        if FEATURE_ROW_VALUES && base is Some(e) && row_value_expression(e) {
          let base = row_value(e, ctx, true)
          for (condition, result) in arms {
            if truth(
                compare_row_values(
                  "=",
                  base,
                  row_value(condition, ctx, false),
                  ctx,
                ),
              ) ==
              1 {
              return evaluate(result, ctx)
            }
          }
          return evaluate(otherwise, ctx)
        }
        let value = base.map(e => evaluate(e, ctx))
        for (condition, result) in arms {
          let matches = if base is Some(e) && value is Some(value) {
            truth(
              compare_expression(
                "=",
                e,
                value,
                condition,
                evaluate(condition, ctx),
                ctx,
              ),
            ) ==
            1
          } else {
            truth(evaluate(condition, ctx)) == 1
          }
          if matches {
            return evaluate(result, ctx)
          }
        }
        evaluate(otherwise, ctx)
      } else {
        fail("catalog capability disabled: expression case")
      }
    InSelect(value, select) =>
      if CAP_EXPRESSION_SUBQUERY && CAP_QUERY_IN_SELECT {
        if OPT_IN_SELECT_LOOKUP {
          if in_select_lookup(expression, ctx) is Some(value) {
            return value
          }
        }
        if FEATURE_ROW_VALUES && row_value_expression(value) {
          return row_in_select(value, select, ctx)
        }
        let left = evaluate(value, ctx)
        let relation = select_relation_in(select, ctx.nested(), false)
        let source = subquery_metadata_selection(select)
        let metadata = selection_template(source, ctx.nested())[0]
        let la = expression_affinity(value, ctx)
        let affinity = in_comparison_affinity(la, metadata.affinity)
        let left = apply_affinity(
          merged_comparison_value(value, left, la, ctx),
          affinity,
        )
        let collation = comparison_collation(
          value,
          source.projections[0].expression,
          ctx,
          right_default=Some(metadata.collation),
        )
        let mut unknown = false
        for row in relation.rows {
          let right = apply_affinity(row[0].value, affinity)
          if !(left is Null) &&
            !(right is Null) &&
            compare_stored(ctx.store, left, right, collation) == 0 {
            return Integer(1L)
          }
          if left is Null || right is Null {
            unknown = true
          }
        }
        if unknown {
          Null
        } else {
          Integer(0L)
        }
      } else {
        fail("catalog capability disabled: query inSelect")
      }
    ScalarSelect(select) =>
      if CAP_EXPRESSION_SUBQUERY {
        let relation = select_relation_in(select, ctx.nested(), false)
        if relation.rows.is_empty() {
          Null
        } else {
          relation.rows[0][0].value
        }
      } else {
        fail("catalog capability disabled: expression subquery")
      }
    Exists(select) =>
      if CAP_EXPRESSION_SUBQUERY {
        boolean(!select_relation_in(select, ctx.nested(), true).rows.is_empty())
      } else {
        fail("catalog capability disabled: expression subquery")
      }
    Call(name, args) =>
      if CAP_EXPRESSION_CALL {
        evaluate_call(name, args, ctx)
      } else {
        fail("catalog capability disabled: expression call")
      }
  }
}

///|
fn evaluate_call(
  name : String,
  args : Array[Expr],
  ctx : Evaluation,
) -> Value raise SqlError {
  if OPT_IN_LIST_LOOKUP && CAP_FUNCTION_IN_LIST && name == "in" {
    if in_list_lookup(args, ctx) is Some(value) {
      return value
    }
  }
  if FEATURE_ROW_VALUES &&
    CAP_FUNCTION_IN_LIST &&
    name == "in" &&
    !args.is_empty() &&
    row_value_expression(args[0]) {
    return row_in_list(args, ctx)
  }
  if FEATURE_AGGREGATE_ORDER &&
    !args.is_empty() &&
    filter_input(args[0]) is Call("$aggregate-order", _) {
    return ordered_aggregate(name, args, ctx)
  }
  if CAP_FUNCTION_RAISE && name == "raise" {
    guard !ctx.store.triggers.active.is_empty() else {
      fail("RAISE() may only be used within a trigger-program")
    }
    if trigger_raise_action(args) == "ignore" {
      raise TriggerIgnore
    }
    raise TriggerAbort(text_value(evaluate(args[1], ctx)))
  }
  if FEATURE_SQL_JSON &&
    CAP_FUNCTION_JSON_AGGREGATE &&
    (name == "json_group_array" || name == "json_group_object") {
    return json_aggregate(name, args, ctx)
  }
  if CAP_FUNCTION_GROUP_CONCAT &&
    (name == "group_concat" || name == "string_agg") {
    return group_concat(args, ctx)
  }
  if CAP_FUNCTION_AGGREGATES &&
    ["count", "sum", "total", "avg", "max", "min"].contains(name) &&
    args.length() == 1 {
    let group = ctx.group.unwrap_or([ctx.row])
    let values : Array[Value] = []
    let input = filter_input(args[0])
    let distinct = input is Call("$distinct", _)
    let arg = match input {
      Call("$distinct", [e]) => e
      _ => input
    }
    let predicate = aggregate_predicate(args[0])
    for row in group {
      let here = if arg is Star(_) && predicate is None {
        ctx
      } else {
        { ..ctx, row, group: None, }
      }
      if predicate is Some(p) && truth(evaluate(p, here)) != 1 {
        continue
      }
      let value : Value = if arg is Star(_) {
        Integer(1L)
      } else {
        evaluate(arg, here)
      }
      if !(value is Null) &&
        (
          !distinct ||
          !values.any(v => {
            compare_stored(ctx.store, v, value, expression_collation(arg, ctx)) ==
            0
          })
        ) {
        values.push(value)
      }
    }
    if name == "count" {
      return Integer(values.length().to_int64())
    }
    if values.is_empty() {
      return if name == "total" { Real(0) } else { Null }
    }
    if name == "max" || name == "min" {
      let mut result = values[0]
      for v in values {
        let c = compare_stored(
          ctx.store,
          v,
          result,
          expression_collation(arg, ctx),
        )
        if (name == "max" && c > 0) || (name == "min" && c < 0) {
          result = v
        }
      }
      return result
    }
    let sum = sum_state()
    for value in values {
      sum.add(value)
    }
    return sum.finish(name)
  }

  if CAP_FUNCTION_COALESCE && (name == "coalesce" || name == "ifnull") {
    for e in args {
      let value = evaluate(e, ctx)
      if !(value is Null) {
        return value
      }
    }
    return Null
  }
  if CAP_FUNCTION_CONDITIONAL && (name == "iif" || name == "if") {
    let mut index = 0
    while index + 1 < args.length() {
      if truth(evaluate(args[index], ctx)) == 1 {
        return evaluate(args[index + 1], ctx)
      }
      index += 2
    }
    return if index < args.length() { evaluate(args[index], ctx) } else { Null }
  }
  let values = args.map(e => evaluate(e, ctx))
  match name {
    "like" => {
      guard CAP_FUNCTION_LIKE else { fail("catalog capability disabled: like") }
      like_value(values)
    }
    "min" | "max" => {
      guard CAP_FUNCTION_EXTREMA else {
        fail("catalog capability disabled: extrema")
      }
      if values.any(v => v is Null) {
        return Null
      }
      let collation = function_collation(args, ctx, false).unwrap_or("binary")
      let mut best = values[0]
      for v in values[1:] {
        let order = compare_stored(ctx.store, v, best, collation)
        if (name == "min" && order <= 0) || (name == "max" && order > 0) {
          best = v
        }
      }
      best
    }
    "nullif" => {
      guard CAP_FUNCTION_NULLIF else {
        fail("catalog capability disabled: nullif")
      }
      let mut collation = "binary"
      for arg in args {
        if arg is Column(_, _) || arg is Collate(_, _) {
          collation = expression_collation(arg, ctx)
          break
        }
      }
      if values[0] is Null ||
        (
          !(values[1] is Null) &&
          compare_stored(ctx.store, values[0], values[1], collation) == 0
        ) {
        Null
      } else {
        values[0]
      }
    }
    "changes" => {
      guard CAP_FUNCTION_CONNECTION_COUNTERS else {
        fail("catalog capability disabled: changes")
      }
      guard values.is_empty() else {
        fail("wrong number of arguments: changes")
      }
      Integer(
        (if ctx.store.triggers.data_depth > 0 {
          ctx.store.triggers.prior_changes
        } else {
          connection_changes(ctx.store)
        }).to_int64(),
      )
    }
    "last_insert_rowid" => {
      guard CAP_FUNCTION_CONNECTION_COUNTERS else {
        fail("catalog capability disabled: last_insert_rowid")
      }
      guard values.is_empty() else {
        fail("wrong number of arguments: last_insert_rowid")
      }
      Integer(ctx.store.last_rowid)
    }
    "coalesce" | "ifnull" => {
      guard CAP_FUNCTION_COALESCE else {
        fail("catalog capability disabled: coalesce")
      }
      guard values.length() >= 2 && (name != "ifnull" || values.length() == 2) else {
        fail("wrong number of arguments: coalesce")
      }
      for value in values {
        if !(value is Null) {
          return value
        }
      }
      Null
    }
    "typeof" => {
      guard CAP_FUNCTION_TYPEOF else {
        fail("catalog capability disabled: typeof")
      }
      guard values.length() == 1 else {
        fail("wrong number of arguments: typeof")
      }
      Text(
        match values[0] {
          Null => "null"
          Integer(_) => "integer"
          Real(_) => "real"
          Text(_) => "text"
          Blob(_) => "blob"
        },
      )
    }
    "hex" => {
      guard CAP_FUNCTION_HEX else { fail("catalog capability disabled: hex") }
      guard values.length() == 1 else { fail("wrong number of arguments: hex") }
      let bytes = match values[0] {
        Blob(b) => b
        Text(s) =>
          if ctx.store.encoding.unwrap_or(1) == 1 {
            @utf8.encode(s)
          } else {
            @utf16.encode(
              s,
              endianness=if ctx.store.encoding == Some(2) {
                Little
              } else {
                Big
              },
            )
          }
        other => @utf8.encode(text_value(other))
      }
      let hex = @buffer.Buffer()
      let digits = b"0123456789ABCDEF"
      for b in bytes {
        hex.write_byte(digits[b.to_int() / 16])
        hex.write_byte(digits[b.to_int() % 16])
      }
      Text(@utf8.decode_lossy(hex.to_bytes()))
    }
    "length" => {
      guard CAP_FUNCTION_LENGTH else {
        fail("catalog capability disabled: length")
      }
      guard values.length() == 1 else {
        fail("wrong number of arguments: length")
      }
      match values[0] {
        Null => Null
        Blob(b) => Integer(b.length().to_int64())
        v => {
          let mut count = 0L
          for c in text_value(v).iter() {
            if c == '\u{0}' {
              break
            }
            count += 1L
          }
          Integer(count)
        }
      }
    }
    "lower" | "upper" => {
      guard CAP_FUNCTION_CASE_CONVERSION else {
        fail("catalog capability disabled: case conversion")
      }
      guard values.length() == 1 else {
        fail("wrong number of arguments: case")
      }
      if values[0] is Null {
        Null
      } else {
        let lower = identifier(checked_text_value(values[0]))
        if name == "lower" {
          Text(lower)
        } else {
          let b = @utf8.encode(lower)
            .to_array()
            .map(c => {
              if c >= b'a' && c <= b'z' {
                (c.to_int() - 32).to_byte()
              } else {
                c
              }
            })
          Text(@utf8.decode_lossy(Bytes::from_array(b)))
        }
      }
    }
    "abs" => {
      guard CAP_FUNCTION_ABS else { fail("catalog capability disabled: abs") }
      guard values.length() == 1 else { fail("wrong number of arguments: abs") }
      match numeric(values[0], false) {
        Null => Null
        Integer(n) => {
          guard n != -9223372036854775808L else { fail("integer overflow") }
          Integer(n.abs())
        }
        Real(n) => Real(n.abs())
        _ => Real(0)
      }
    }
    "in" => {
      guard CAP_FUNCTION_IN_LIST else {
        fail("catalog capability disabled: in")
      }
      guard values.length() > 0 else { fail("invalid IN") }
      if values.length() == 1 {
        return Integer(0L)
      }
      if values[0] is Null {
        return Null
      }
      // Comparison uses NUMERIC coercion, not REAL storage affinity. Keeping
      // INTEGER RHS values exact avoids rounding beyond 2^53 before equality.
      let affinity = expression_affinity(args[0], ctx)
      let a = if affinity == "real" { "numeric" } else { affinity }
      let mut unknown = false
      for i = 1; i < values.length(); i = i + 1 {
        if values[i] is Null {
          unknown = true
        } else if compare_stored(
            ctx.store,
            values[0],
            apply_affinity(values[i], a),
            expression_collation(args[0], ctx),
          ) ==
          0 {
          return Integer(1L)
        }
      }
      if unknown {
        Null
      } else {
        Integer(0L)
      }
    }
    _ =>
      if FEATURE_SQL_JSON && json_arity(name, values.length()) {
        json_call(name, args, values, ctx)
      } else if FEATURE_DATETIME && datetime_arity(name, values.length()) {
        datetime_call(name, values, ctx.store.triggers.clock)
      } else {
        scalar_call(name, values, ctx.store.encoding.unwrap_or(1))
      }
  }
}

///|
fn row_environment(
  table : Table,
  row : StoredRow,
  qualifier : String,
) -> Environment {
  let result = table.columns.mapi((i, c) => {
    qualifier,
    name: c.name,
    display_name: c.name,
    value: row.values[i],
    affinity: column_affinity(table, c),
    collation: c.collation,
    hidden: false,
    readable: true,
    join_column: None,
    json_value: 0,
  })
  if !table.without_rowid {
    let ipk = integer_primary(table)
    for name in ["rowid", "_rowid_", "oid"] {
      if !table.columns.any(c => identifier(c.name) == name) {
        result.push({
          qualifier,
          name,
          display_name: if ipk >= 0 {
            table.columns[ipk].name
          } else {
            "rowid"
          },
          value: Integer(row.id),
          affinity: "integer",
          collation: "binary",
          hidden: true,
          readable: true,
          join_column: None,
          json_value: 0,
        })
      }
    }
  }
  result
}

///|
/// Layout metadata is immutable within one statement; only values vary by row.
fn row_environment_from(layout : Environment, row : StoredRow) -> Environment {
  layout.mapi((i, b) => {
    ..b,
    value: if b.hidden {
      Integer(row.id)
    } else {
      row.values[i]
    },
  })
}

///|
fn aggregate(expression : Expr) -> Bool {
  if !CAP_FUNCTION_AGGREGATES &&
    !CAP_FUNCTION_GROUP_CONCAT &&
    !CAP_FUNCTION_JSON_AGGREGATE {
    return false
  }
  match expression {
    Call(name, args) =>
      aggregate_name(name, args.length()) || args.any(aggregate)
    Binary(_, a, b) => aggregate(a) || aggregate(b)
    InSelect(e, _) => aggregate(e)
    Between(e, a, b) => aggregate(e) || aggregate(a) || aggregate(b)
    Case(base, arms, otherwise) =>
      base.map(aggregate).unwrap_or(false) ||
      arms.any(arm => aggregate(arm.0) || aggregate(arm.1)) ||
      aggregate(otherwise)
    Unary(_, e) | Collate(e, _) | Cast(e, _) => aggregate(e)
    Window(_, args, partitions, orders, _) =>
      args.any(aggregate) ||
      partitions.any(aggregate) ||
      orders.any(o => aggregate(o.expression))
    _ => false
  }
}

///|
fn project(
  projections : Array[Projection],
  ctx : Evaluation,
) -> Environment raise SqlError {
  let output : Environment = []
  for p in projections {
    if p.expression is Star(q) {
      for b in ctx.row {
        if !b.hidden &&
          (q != "" || !(b.join_column is Some(SuppressedJoinColumn))) &&
          (q == "" || identifier(b.qualifier) == identifier(q)) {
          guard b.readable else {
            fail("unsupported physical schema column: " + b.name)
          }
          output.push({
            ..(if b.join_column is Some(MergedJoinColumn(_, _, _)) {
              unqualified_binding(b).unwrap()
            } else {
              b
            }),
            qualifier: "",
            join_column: None,
            json_value: if FEATURE_JSON_TABLE && b.json_value > 0 {
              2
            } else {
              0
            },
          })
        }
      }
    } else {
      output.push({
        qualifier: "",
        name: projection_name(p, ctx),
        display_name: projection_name(p, ctx),
        value: match p.expression {
          Column(q, n) => resolve_context(ctx, q, n).value
          _ => evaluate(p.expression, ctx)
        },
        affinity: expression_affinity(p.expression, ctx),
        collation: expression_collation(p.expression, ctx),
        hidden: false,
        readable: true,
        join_column: None,
        json_value: if FEATURE_JSON_TABLE &&
          p.expression is Column(q, n) &&
          resolve_context(ctx, q, n).json_value > 0 {
          2
        } else {
          0
        },
      })
    }
  }
  output
}

///|
fn result_json(rows : Array[Environment]) -> Json {
  Json::array(
    rows.map(row => {
      let object : Map[String, Json] = Map([])
      for b in row {
        if !b.hidden {
          object[b.name] = value_json(b.value)
        }
      }
      Json::object(object)
    }),
  )
}

///|
/// INTEGER PRIMARY KEY aliases use the declared column name unless AS is given.
fn projection_name(p : Projection, ctx : Evaluation) -> String raise SqlError {
  if !p.explicit_label && p.expression is Column(q, n) {
    resolve_context(ctx, q, n).display_name
  } else {
    p.label
  }
}

///|
/// Comparison keeps expression affinity while evaluating each operand once.
fn compare_expression(
  op : String,
  left : Expr,
  a : Value,
  right : Expr,
  b : Value,
  ctx : Evaluation,
) -> Value raise SqlError {
  if (op == "is" || op == "is not") &&
    right is TruthLiteral(expected) &&
    find_context(ctx, "", if expected { "true" } else { "false" }) is None {
    return boolean((truth(a) == (if expected { 1 } else { 0 })) == (op == "is"))
  }
  if a is Null || b is Null {
    if op == "is" || op == "is not" {
      boolean((a is Null && b is Null) == (op == "is"))
    } else {
      Null
    }
  } else {
    let la = expression_affinity(left, ctx)
    let ra = expression_affinity(right, ctx)
    let a = merged_comparison_value(left, a, la, ctx)
    let b = merged_comparison_value(right, b, ra, ctx)
    let collation = comparison_collation(left, right, ctx)
    compare_nonnull(op, a, b, la, ra, collation, ctx.store)
  }
}

///|
fn aggregate_number(value : Value) -> Value {
  let parsed = numeric(value, true)
  match parsed {
    Integer(_) | Real(_) => parsed
    _ => Real(as_double(value))
  }
}

///|
fn unary_value(op : String, value : Value) -> Value {
  if op == "not" {
    let t = truth(value)
    if t == -1 {
      Null
    } else {
      boolean(t == 0)
    }
  } else if op == "+" {
    value
  } else if op == "~" {
    if value is Null {
      Null
    } else {
      Integer(integer_value(value) ^ -1L)
    }
  } else {
    match numeric(value, false) {
      Null => Null
      Integer(n) =>
        if n == -9223372036854775808L {
          Real(9223372036854775808.0)
        } else {
          Integer(-n)
        }
      Real(n) => Real(-n)
      _ => Integer(0L)
    }
  }
}

///|
fn binary_value(op : String, a : Value, b : Value) -> Value raise SqlError {
  if op == "and" || op == "or" {
    let a = truth(a)
    let b = truth(b)
    if op == "and" {
      if a == 0 || b == 0 {
        Integer(0L)
      } else if a < 0 || b < 0 {
        Null
      } else {
        Integer(1L)
      }
    } else if a == 1 || b == 1 {
      Integer(1L)
    } else if a < 0 || b < 0 {
      Null
    } else {
      Integer(0L)
    }
  } else if ["+", "-", "*", "/", "%"].contains(op) {
    arithmetic(op, a, b)
  } else if op == "<<" || op == ">>" {
    shift_value(op, a, b)
  } else if op == "&" || op == "|" {
    if a is Null || b is Null {
      Null
    } else {
      let x = integer_value(a)
      let y = integer_value(b)
      Integer(if op == "&" { x & y } else { x | y })
    }
  } else if op == "||" {
    if a is Null || b is Null {
      Null
    } else {
      Text(checked_text_value(a) + checked_text_value(b))
    }
  } else if op == "like" {
    guard CAP_FUNCTION_LIKE else { fail("catalog capability disabled: like") }
    like_value([b, a])
  } else {
    fail("unsupported SQL operator: " + op)
  }
}

///|
fn comparison_operator(op : String) -> Bool {
  match op {
    "=" | "==" | "!=" | "<>" | "<" | ">" | "<=" | ">=" | "is" | "is not" => true
    _ => false
  }
}

///|
fn compare_nonnull(
  op : String,
  a : Value,
  b : Value,
  la : String,
  ra : String,
  collation : String,
  store : Store,
) -> Value raise SqlError {
  let a = if ["integer", "numeric", "real"].contains(ra) &&
    !["integer", "numeric", "real"].contains(la) {
    apply_affinity(a, "numeric")
  } else if ra == "text" && la == "" {
    apply_affinity(a, "text")
  } else {
    a
  }
  let b = if ["integer", "numeric", "real"].contains(la) &&
    !["integer", "numeric", "real"].contains(ra) {
    apply_affinity(b, "numeric")
  } else if la == "text" && ra == "" {
    apply_affinity(b, "text")
  } else {
    b
  }
  let comparison = compare_stored(store, a, b, collation)
  boolean(
    match op {
      "=" | "==" | "is" => comparison == 0
      "<>" | "!=" | "is not" => comparison != 0
      "<" => comparison < 0
      ">" => comparison > 0
      "<=" => comparison <= 0
      ">=" => comparison >= 0
      _ => fail("unsupported SQL operator: " + op)
    },
  )
}

// Source: execute.mbt

///|
/// Constraints and mutation operate on the row store, independently of parsing.
fn primary_key(table : Table) -> Array[Int32] {
  let keys = table.columns.mapi((i, c) => (i, c.primary)).filter(p => p.1 > 0)
  keys.sort_by((a, b) => a.1.compare(b.1))
  keys.map(p => p.0)
}

///|
fn integer_primary(table : Table) -> Int32 {
  if table.without_rowid {
    return -1
  }
  let mut primary = -1
  for i, column in table.columns {
    if column.primary > 0 {
      if primary >= 0 {
        return -1
      }
      primary = i
    }
  }
  if primary >= 0 &&
    table.columns[primary].declared == "INTEGER" &&
    table.columns[primary].primary_desc != Some(true) {
    primary
  } else {
    -1
  }
}

///|
fn evaluation(
  store : Store,
  params : Array[Value],
  row : Environment,
) -> Evaluation {
  {
    store,
    params,
    row,
    group: None,
    position: 0,
    outer: if store.triggers.row.is_empty() {
      []
    } else {
      [store.triggers.row]
    },
    ctes: Map([]),
    window_values: Map([]),
    forbid_json_inputs: false,
    row_metadata: [],
    in_lists: [],
    in_selects: [],
    depth: 0,
  }
}

///|
fn unique_keys(
  store : Store,
  table : Table,
) -> Array[Array[Int32]] raise SqlError {
  let keys = table.unique_keys.copy()
  for obj in store.objects {
    if obj.kind == "index" &&
      obj.unique &&
      identifier(obj.table) == identifier(table.name) {
      let fields = index_keys(table, obj)
      // A parent FK requires the table column's declared collation.
      if obj.index_predicate is None &&
        fields.all(f => {
          f.column >= 0 && f.collation == table.columns[f.column].collation
        }) {
        keys.push(fields.map(f => f.column))
      }
    }
  }
  keys
}

///|
fn unique_indexes(
  store : Store,
  table : Table,
) -> Array[UniqueIndex] raise SqlError {
  let keys = table.unique_keys.map(key => {
    (
      {
        parts: key.map(column => {
          column,
          expression: Column("", table.columns[column].name),
          collation: table.columns[column].collation,
          descending: false,
        }),
        predicate: None,
      } : UniqueIndex)
  })
  for obj in store.objects {
    if obj.kind == "index" &&
      obj.unique &&
      identifier(obj.table) == identifier(table.name) {
      keys.push(object_index(obj, table))
    }
  }
  keys
}

///|
fn conflict_row(
  store : Store,
  table : Table,
  values : Array[Value],
  excluded : Int64?,
  target : Array[Int32]?,
  target_predicate~ : Expr? = None,
) -> StoredRow? raise SqlError {
  let keys = unique_indexes(store, table).filter(index => {
    target is None ||
    (
      target == Some(index.parts.map(f => f.column)) &&
      (
        index.predicate is None ||
        (
          index.predicate is Some(required) &&
          target_predicate is Some(predicate) &&
          index_predicate_implied(required, predicate)
        )
      )
    )
  })
  for key in keys {
    if find_index_conflict(store, table, key, values, excluded) is Some(row) {
      return Some(row)
    }
  }
  None
}

///|
fn check_row(
  store : Store,
  table : Table,
  values : Array[Value],
  params : Array[Value],
) -> Unit raise SqlError {
  if FEATURE_STRICT && table.strict == Some(true) {
    check_strict_values(table, values)
  }
  for i, col in table.columns {
    if (
        col.not_null ||
        ((table.without_rowid || table.strict == Some(true)) && col.primary > 0)
      ) &&
      values[i] is Null {
      fail("NOT NULL constraint failed: " + table.name + "." + col.name)
    }
  }
  for obj in store.objects {
    if obj.kind == "index" &&
      matches_identifier(obj.table, identifier(table.name)) {
      ignore(index_values(store, table, object_index(obj, table), values))
    }
  }
  if !table.checks.is_empty() {
    let ctx = evaluation(
      store,
      params,
      row_environment(table, { id: 0L, values, }, table.name),
    )
    for check in table.checks {
      if truth(evaluate(check, ctx)) == 0 {
        fail("CHECK constraint failed: " + table.name)
      }
    }
  }
}

///|
fn foreign_key_errors(
  store : Store,
  immediate~ : Bool = false,
  definitions~ : Bool = false,
  only_table~ : String? = None,
) -> Array[Environment] raise SqlError {
  if !FEATURE_FOREIGN_KEYS {
    return []
  }
  let errors : Array[Environment] = []
  for table in store.tables {
    if (only_table is Some(name) && identifier(table.name) != identifier(name)) ||
      (!definitions && table.rows.is_empty()) {
      continue
    }
    for i, fk in table.foreign_keys {
      if immediate &&
        !store.transactions.frames.is_empty() &&
        fk.initially_deferred == Some(true) {
        continue
      }
      let parent = get_table(store, fk.parent)
      let targets = foreign_targets(parent, fk)
      guard unique_keys(store, parent).any(k => {
        k.length() == targets.length() && targets.all(i => k.contains(i))
      }) else {
        fail("foreign key mismatch: " + table.name)
      }
      let columns = foreign_columns(fk)
      for row in table.rows {
        if columns.any(i => row.values[i] is Null) {
          continue
        }
        if !parent.rows.any(r => foreign_matches(store, parent, r, row, fk)) {
          errors.push([
            binding("table", Text(table.name)),
            binding(
              "rowid",
              if table.without_rowid {
                Null
              } else {
                Integer(row.id)
              },
            ),
            binding("parent", Text(parent.name)),
            binding(
              "fkid",
              Integer((table.foreign_keys.length() - 1 - i).to_int64()),
            ),
          ])
        }
      }
    }
  }
  errors
}

///|
fn validate_foreign_keys(
  store : Store,
  immediate~ : Bool = false,
) -> Unit raise SqlError {
  if store.foreign_keys && !foreign_key_errors(store, immediate~).is_empty() {
    fail("FOREIGN KEY constraint failed")
  }
}

///|
fn updated_row(
  store : Store,
  table : Table,
  previous : StoredRow,
  setters : Array[(String, Expr)],
  extra : Environment,
  params : Array[Value],
  generated~ : Bool = true,
  in_lists~ : Array[InListFrame] = [],
) -> StoredRow raise SqlError {
  let values = previous.values.copy()
  let ctx = {
    ..evaluation(
      store,
      params,
      row_environment(table, previous, table.name) + extra,
    ),
    in_lists,
  }
  for (name, expression) in setters {
    let i = writable_column(table, name)
    values[i] = apply_affinity(
      evaluate(expression, ctx),
      column_affinity(table, table.columns[i]),
    )
  }
  let next = finish_updated_row(previous, values, integer_primary(table))
  if generated {
    generated_row(store, table, next)
  } else {
    next
  }
}

///|
fn finish_updated_row(
  previous : StoredRow,
  values : Array[Value],
  ipk : Int32,
) -> StoredRow raise SqlError {
  let id = if ipk >= 0 {
    guard values[ipk] is Integer(id) else {
      fail("datatype mismatch: INTEGER PRIMARY KEY")
    }
    id
  } else {
    previous.id
  }
  { id, values, }
}

///|
fn check_updated_row(
  store : Store,
  table : Table,
  previous : StoredRow,
  next : StoredRow,
  params : Array[Value],
  policy~ : String? = None,
) -> Bool raise SqlError {
  let values = next.values
  check_row(store, table, values, params) catch {
    SqlError(message) =>
      if policy == Some("ignore") && ignorable_row_constraint(message) {
        return false
      } else {
        fail(message)
      }
    error => raise error
  }
  for fields in unique_indexes(store, table) {
    let key = fields.parts.map(f => f.column)
    if fields.predicate is Some(_) ||
      key.any(i => i < 0) ||
      key_changed(key, previous.values, values) {
      while find_index_conflict(store, table, fields, values, Some(previous.id))
            is Some(duplicate) {
        if policy == Some("ignore") {
          return false
        }
        guard policy == Some("replace") &&
          delete_row(store, table, duplicate, 0, store.triggers.recursive) else {
          fail("UNIQUE constraint failed: " + table.name)
        }
      }
    }
  }
  true
}

///|
/// Unmodified keys cannot introduce a duplicate in a previously valid table.
fn key_changed(
  key : Array[Int32],
  before : Array[Value],
  after : Array[Value],
) -> Bool {
  key.any(i => before[i] != after[i])
}

///|
fn delete_row(
  store : Store,
  table : Table,
  row : StoredRow,
  depth : Int32,
  fire_events : Bool,
) -> Bool raise SqlError {
  if FEATURE_FOREIGN_KEYS {
    guard depth <= 32 else { fail("foreign key cascade depth limit") }
  }
  if fire_events {
    prepare_trigger_event(store, table, "delete", [])
    if !run_triggers(store, table, "before", "delete", [], Some(row), None) {
      return false
    }
  }
  foreign_restrict(store, table, row, None)
  remove_table_row(store, table, row)
  if !store.foreign_keys {
    if fire_events {
      ignore(run_triggers(store, table, "after", "delete", [], Some(row), None))
    }
    return true
  }
  foreign_actions(store, table, row, None, depth)
  if fire_events {
    ignore(run_triggers(store, table, "after", "delete", [], Some(row), None))
  }
  true
}

///|
fn insert_rows(
  store : Store,
  stmt : Insertion,
  params : Array[Value],
) -> Array[Environment] raise SqlError {
  let prior_override = store.triggers.conflict_override
  let stmt = if prior_override is Some(conflict) {
    { ..stmt, conflict, }
  } else {
    stmt
  }
  if prior_override is None {
    store.triggers.conflict_override = stmt.conflict_override
  }
  defer {
    store.triggers.conflict_override = prior_override
  }
  let stmt = if stmt.selection is Some(select) {
    let rows = select_rows(store, select, params, 0)
    {
      ..stmt,
      selection: None,
      values: rows.map(row => {
        row.filter(b => !b.hidden).map(b => Literal(b.value))
      }),
    }
  } else {
    stmt
  }
  let table = get_table(store, stmt.table)
  prepare_foreign_table(store, table)
  prepare_trigger_event(store, table, "insert", [])
  if stmt.conflict == "update" {
    prepare_trigger_event(store, table, "update", stmt.updates.map(p => p.0))
  }
  let columns = if stmt.columns.is_empty() {
    insert_columns(table)
  } else {
    stmt.columns.map(n => insertion_column(table, n))
  }
  guard columns.length() ==
    columns.filter(i => columns.filter(j => i == j).length() == 1).length() else {
    fail("duplicate INSERT column")
  }
  let mut target : Array[Int32]? = None
  if !stmt.target.is_empty() {
    let key = stmt.target.map(n => column_index(table, n))
    guard unique_indexes(store, table).any(index => {
      index.parts.map(f => f.column) == key &&
      (
        index.predicate is None ||
        (
          index.predicate is Some(required) &&
          stmt.target_predicate is Some(predicate) &&
          index_predicate_implied(required, predicate)
        )
      )
    }) else {
      fail(
        "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint",
      )
    }
    target = Some(key)
  }
  let result : Array[Environment] = []
  let empty_row = { id: 0L, values: Array::make(table.columns.length(), Null), }
  let template = row_environment(table, empty_row, table.name)
  let excluded = row_environment(table, empty_row, "excluded")
  for (name, e) in stmt.updates {
    ignore(writable_column(table, name))
    prepare_expression(
      e,
      evaluation(store, params, template + excluded),
      false,
      false,
    )
  }
  prepare_expression(
    stmt.predicate,
    evaluation(store, params, template + excluded),
    false,
    false,
  )
  prepare_returning(stmt.returning, evaluation(store, params, template))
  for expressions in stmt.values {
    for e in expressions {
      prepare_expression(e, evaluation(store, params, []), false, false)
    }
  }
  let ipk = integer_primary(table)
  let before_generated = FEATURE_TRIGGERS &&
    has_generated_columns(table) &&
    store.objects.any(o => {
      matches_identifier(o.table, identifier(table.name)) &&
      o.trigger is Some(t) &&
      t.timing == "before" &&
      t.event == "insert"
    })
  let supplied = Array::make(table.columns.length(), false)
  if !stmt.values.is_empty() && !stmt.values[0].is_empty() {
    for column in columns {
      if column >= 0 {
        supplied[column] = true
      } else if ipk >= 0 {
        supplied[ipk] = true
      }
    }
  }
  let defaults = table.columns.mapi((i, _) => i).filter(i => !supplied[i])
  store.changes = 0
  for expressions in stmt.values {
    guard expressions.is_empty() || expressions.length() == columns.length() else {
      fail("table column/value count mismatch")
    }
    let mut values : Array[Value] = Array::make(table.columns.length(), Null)
    for i in defaults {
      values[i] = column_default(store, table, table.columns[i], params)
    }
    let mut explicit_id : Value = Null
    for i, e in expressions {
      if columns[i] < 0 {
        explicit_id = evaluate(e, evaluation(store, params, []))
        if ipk >= 0 {
          values[ipk] = explicit_id
        }
        continue
      }
      values[columns[i]] = apply_affinity(
        evaluate(e, evaluation(store, params, [])),
        column_affinity(table, table.columns[columns[i]]),
      )
    }
    if ipk >= 0 {
      explicit_id = values[ipk]
    }
    let id = if !(explicit_id is Null) {
      let explicit_id = apply_affinity(explicit_id, "integer")
      guard explicit_id is Integer(n) else { fail("datatype mismatch: rowid") }
      n
    } else if ipk >= 0 && !(values[ipk] is Null) {
      guard values[ipk] is Integer(n) else {
        fail("datatype mismatch: INTEGER PRIMARY KEY")
      }
      n
    } else {
      let maximum = maximum_rowid(store, table)
      guard maximum < 9223372036854775807L else {
        fail("rowid allocation limit")
      }
      maximum + 1L
    }
    if ipk >= 0 {
      values[ipk] = Integer(id)
    }
    let proposed = generated_row(store, table, { id, values, })
    values = proposed.values
    let trigger_row = if before_generated &&
      explicit_id is Null &&
      !table.without_rowid {
      let before_values = values.copy()
      if ipk >= 0 {
        before_values[ipk] = Integer(-1L)
      }
      generated_row(store, table, { id: -1L, values: before_values, })
    } else {
      proposed
    }
    if !run_triggers(
        store,
        table,
        "before",
        "insert",
        [],
        None,
        Some(trigger_row),
      ) {
      continue
    }
    let mut event = "insert"
    let mut before : StoredRow? = None
    let mut after = proposed
    table.sequence = table.sequence.max(id)
    if table.autoincrement {
      table.sequence_present = Some(true)
    }
    if stmt.conflict == "replace" {
      for i, c in table.columns {
        if c.not_null && values[i] is Null {
          values[i] = column_default(store, table, c, params)
        }
      }
      after = generated_row(store, table, { id, values, })
      values = after.values
    }
    check_row(store, table, values, params) catch {
      SqlError(message) =>
        if stmt.conflict == "ignore" && ignorable_row_constraint(message) {
          continue
        } else {
          fail(message)
        }
      error => raise error
    }
    let rowid_duplicate = if !table.without_rowid && !(explicit_id is Null) {
      candidate_rows(store, table, Some(id)).iter().next()
    } else {
      None
    }
    let duplicate = match rowid_duplicate {
      Some(row) => Some(row)
      None => conflict_row(store, table, values, None, None)
    }
    if duplicate is Some(previous) {
      if stmt.conflict == "ignore" {
        continue
      }
      if stmt.conflict == "nothing" || stmt.conflict == "update" {
        let matched = if target is None && rowid_duplicate is Some(row) {
          Some(row)
        } else {
          conflict_row(
            store,
            table,
            values,
            None,
            target,
            target_predicate=stmt.target_predicate,
          )
        }
        guard matched is Some(conflicting) && conflicting.id == previous.id else {
          fail("UNIQUE constraint failed: " + table.name)
        }
        if stmt.conflict == "nothing" {
          continue
        }
        let excluded = row_environment(table, { id, values, }, "excluded")
        if truth(
            evaluate(
              stmt.predicate,
              evaluation(
                store,
                params,
                row_environment(table, previous, table.name) + excluded,
              ),
            ),
          ) !=
          1 {
          continue
        }
        let next = updated_row(
          store,
          table,
          previous,
          stmt.updates,
          excluded,
          params,
        )
        if !run_triggers(
            store,
            table,
            "before",
            "update",
            stmt.updates.map(p => p.0),
            Some(previous),
            Some(next),
          ) {
          continue
        }
        if !check_updated_row(store, table, previous, next, params) {
          continue
        }
        event = "update"
        before = Some(previous)
        after = next
        foreign_restrict(store, table, previous, Some(next))
        replace_table_row(store, table, previous, next)
        foreign_actions(store, table, previous, Some(next), 0)
        if !stmt.returning.is_empty() {
          result.push(
            project(
              stmt.returning,
              evaluation(
                store,
                params,
                row_environment(table, next, table.name),
              ),
            ),
          )
        }
      } else if stmt.conflict == "replace" {
        if rowid_duplicate is Some(row) {
          ignore(delete_row(store, table, row, 0, store.triggers.recursive))
        }
        while conflict_row(store, table, values, None, None) is Some(row) {
          ignore(delete_row(store, table, row, 0, store.triggers.recursive))
        }
        append_table_row(store, table, { id, values, })
        store.last_rowid = id
        if !stmt.returning.is_empty() {
          result.push(
            project(
              stmt.returning,
              evaluation(
                store,
                params,
                row_environment(table, { id, values, }, table.name),
              ),
            ),
          )
        }
      } else {
        fail("UNIQUE constraint failed: " + table.name)
      }
    } else {
      append_table_row(store, table, { id, values, })
      store.last_rowid = id
      if !stmt.returning.is_empty() {
        result.push(
          project(
            stmt.returning,
            evaluation(
              store,
              params,
              row_environment(table, { id, values, }, table.name),
            ),
          ),
        )
      }
    }
    store.changes += 1
    ignore(
      run_triggers(
        store,
        table,
        "after",
        event,
        stmt.updates.map(p => p.0),
        before,
        Some(after),
      ),
    )
    guard table.rows.length() <= 100000 else {
      fail("SQL table resource limit")
    }
  }
  result
}

///|
fn execute_pragma(
  store : Store,
  name : String,
  table : String,
  value : Expr?,
  params : Array[Value],
) -> Array[Environment] raise SqlError {
  validate_pragma_features(name)
  if FEATURE_SCHEMA_METADATA && pragma_features(name) != 0U {
    guard value is None else { fail("unsupported metadata PRAGMA assignment") }
    return index_metadata(store, name, table)
  }
  if name == "recursive_triggers" {
    if value is Some(e) {
      store.triggers.recursive = if e is Column("", n) {
        ["on", "true", "yes"].contains(identifier(n))
      } else {
        truth(evaluate(e, evaluation(store, params, []))) == 1
      }
      return []
    }
    return [[binding(name, boolean(store.triggers.recursive))]]
  }
  if name == "encoding" {
    if value is Some(expression) {
      if store.cookie == 0 && store.tables.is_empty() {
        let raw = match expression {
          Column("", name) => name
          _ => text_value(evaluate(expression, evaluation(store, params, [])))
        }
        let normalized = identifier(raw).replace_all(old="-", new="")
        store.encoding = Some(
          match normalized {
            "utf8" => 1
            "utf16" | "utf16le" => 2
            "utf16be" => 3
            _ => fail("unsupported encoding: " + raw)
          },
        )
      }
      return []
    }
    return [
      [
        binding(
          name,
          Text(
            match store.encoding.unwrap_or(1) {
              1 => "UTF-8"
              2 => "UTF-16le"
              _ => "UTF-16be"
            },
          ),
        ),
      ],
    ]
  }
  if name == "table_info" || name == "table_xinfo" {
    let found = store.tables.filter(t => identifier(t.name) == identifier(table))
    if found.is_empty() {
      guard !["json_each", "json_tree"].contains(identifier(table)) else {
        fail("unsupported JSON table PRAGMA metadata")
      }
      return []
    }
    let infos = found[0].columns.mapi((i, col) => {
      let output = [
        binding("cid", Integer(i.to_int64())),
        binding("name", Text(col.name)),
        binding("type", Text(col.declared)),
        binding(
          "notnull",
          boolean(
            col.not_null ||
            (
              (
                found[0].without_rowid ||
                (
                  found[0].strict == Some(true) &&
                  integer_primary(found[0]) != i
                )
              ) &&
              col.primary > 0
            ),
          ),
        ),
        binding(
          "dflt_value",
          match col.default_source {
            Some("") => Null
            Some(source) => Text(source)
            None =>
              match store.declaration_sources.get(found[0].sql) {
                Some(sources) =>
                  if sources[i] == "" {
                    Null
                  } else {
                    Text(sources[i])
                  }
                None =>
                  fail(
                    "unsupported SQL: declaration metadata requires catalog rebuild",
                  )
              }
          },
        ),
        binding("pk", Integer(col.primary.to_int64())),
      ]
      if name == "table_xinfo" {
        output.push(
          binding(
            "hidden",
            Integer(
              if FEATURE_GENERATED_COLUMNS && generated_column(col) {
                2L
              } else {
                0L
              },
            ),
          ),
        )
      }
      output
    })
    return if name == "table_info" && has_generated_columns(found[0]) {
      infos
      .filter(row => {
        guard row[0].value is Integer(i) else { return false }
        !generated_column(found[0].columns[i.to_int()])
      })
      .mapi((i, row) => {
        row.mapi((j, b) => {
          if j == 0 {
            { ..b, value: Integer(i.to_int64()), }
          } else {
            b
          }
        })
      })
    } else {
      infos
    }
  }
  if name == "foreign_key_list" {
    let found = store.tables.filter(t => identifier(t.name) == identifier(table))
    if found.is_empty() {
      return []
    }
    let t = found[0]
    let rows : Array[Environment] = []
    for i = t.foreign_keys.length() - 1; i >= 0; i = i - 1 {
      let fk = t.foreign_keys[i]
      let columns = foreign_columns(fk)
      let targets = fk.targets.unwrap_or(
        if fk.target == "" {
          []
        } else {
          [fk.target]
        },
      )
      for seq, column in columns {
        rows.push([
          binding("id", Integer((t.foreign_keys.length() - 1 - i).to_int64())),
          binding("seq", Integer(seq.to_int64())),
          binding("table", Text(fk.parent)),
          binding("from", Text(t.columns[column].name)),
          binding(
            "to",
            if targets.is_empty() {
              Null
            } else {
              Text(targets[seq])
            },
          ),
          binding("on_update", Text(foreign_action(fk, true).to_upper())),
          binding("on_delete", Text(foreign_action(fk, false).to_upper())),
          binding("match", Text("NONE")),
        ])
      }
    }
    return rows
  }
  if name == "foreign_key_check" {
    if table != "" {
      let target = get_table(store, table)
      return foreign_key_errors(
        store,
        definitions=true,
        only_table=Some(target.name),
      )
    }
    return foreign_key_errors(store, definitions=true)
  }
  if name == "schema_version" {
    guard value is None else { fail("schema_version is read only") }
    return [[binding(name, Integer(store.cookie.to_int64()))]]
  }
  if name == "quick_check" || name == "integrity_check" {
    fail(
      "unsupported PRAGMA: " + name + " requires a complete integrity checker",
    )
  }
  if name == "foreign_keys" || name == "defer_foreign_keys" {
    if value is Some(e) {
      let on = if e is Column("", n) {
        ["on", "true", "yes"].contains(identifier(n))
      } else {
        truth(evaluate(e, evaluation(store, params, []))) == 1
      }
      if name == "foreign_keys" {
        if store.transactions.frames.is_empty() {
          store.foreign_keys = on
        }
      } else {
        store.deferred = on
      }
      return []
    }
    return [
      [
        binding(
          name,
          boolean(
            if name == "foreign_keys" {
              store.foreign_keys
            } else {
              store.deferred
            },
          ),
        ),
      ],
    ]
  }
  fail("unsupported PRAGMA: " + name)
}

///|
fn schema_name_available(
  store : Store,
  kind : String,
  name : String,
  optional : Bool,
) -> Bool raise SqlError {
  guard !identifier(name).has_prefix("sqlite_") else {
    fail("object name reserved for internal use: " + name)
  }
  let key = schema_name_key(kind, name)
  let mut existing = ""
  if kind != "trigger" &&
    store.tables.any(t => identifier(t.name) == identifier(name)) {
    existing = "table"
  }
  for object in store.objects {
    if schema_name_key(object.kind, object.name) == key {
      existing = object.kind
      break
    }
  }
  if existing == "" {
    return true
  }
  let same_kind = existing == kind ||
    (["table", "view"].contains(kind) && ["table", "view"].contains(existing))
  guard optional && same_kind else {
    fail("schema object already exists: " + name)
  }
  false
}

///|
fn execute_statement(
  store : Store,
  stmt : ParsedStatement,
  params : Array[Value],
) -> Array[Environment] raise SqlError {
  let result : Array[Environment] = match stmt {
    Transaction(op, name) => return execute_transaction(store, op, name)
    Select(select) => return select_rows(store, select, params, 0)
    Pragma(name, table, value) =>
      return execute_pragma(store, name, table, value, params)
    CreateTableAs(name, select, optional) => {
      if schema_name_available(store, "table", name, optional) {
        store.tables.push(create_table_as(store, name, select, params))
        schema_changed(store)
      }
      []
    }
    CreateTable(table, optional) => {
      validate_table_features(table)
      validate_generated_table(store, table)
      if schema_name_available(store, "table", table.name, optional) {
        // Resolve every constraint expression before installing the table.
        let template = row_environment(
          table,
          { id: 0L, values: Array::make(table.columns.length(), Null), },
          table.name,
        )
        for e in table.checks {
          guard !has_parameter(e) && !has_subquery(e) else {
            fail("parameters prohibited in CHECK constraints")
          }
          prepare_expression(
            e,
            evaluation(store, params, template),
            false,
            false,
          )
        }
        for c in table.columns {
          prepare_default(store, c)
        }
        store.tables.push(table)
        schema_changed(store)
      }
      []
    }
    CreateObject(object, optional) => {
      if schema_name_available(store, object.kind, object.name, optional) {
        if object.kind == "index" {
          let table = get_table(store, object.table)
          validate_index_definition(store, table, object)
          for row in table.rows {
            ignore(
              index_values(
                store,
                table,
                object_index(object, table),
                row.values,
              ),
            )
          }
          store.objects.push(object)
          if object.unique {
            for row in table.rows {
              guard conflict_row(store, table, row.values, Some(row.id), None)
                is None else {
                fail("UNIQUE constraint failed: " + table.name)
              }
            }
          }
        } else if object.kind == "trigger" {
          validate_trigger_metadata(get_table(store, object.table), object)
          store.objects.push(object)
        } else {
          store.objects.push(object)
        }
        schema_changed(store)
      }
      []
    }
    Drop(kind, name, optional) => {
      guard !(kind == "table" &&
        store.objects.any(o => {
          o.kind == "view" && identifier(o.name) == identifier(name)
        })) &&
        !(kind == "view" &&
        store.tables.any(t => identifier(t.name) == identifier(name))) else {
        fail("use DROP TABLE/VIEW for the object's actual kind: " + name)
      }
      if kind == "table" {
        let tables = store.tables.filter(t => {
          identifier(t.name) == identifier(name)
        })
        guard !tables.is_empty() || optional else {
          fail("no such table: " + name)
        }
        if !tables.is_empty() {
          let remaining = store.tables.filter(t => {
            identifier(t.name) != identifier(name)
          })
          store.tables.clear()
          for t in remaining {
            store.tables.push(t)
          }
          let objects = store.objects.filter(o => {
            identifier(o.table) != identifier(name) || o.kind == "view"
          })
          store.objects.clear()
          for o in objects {
            store.objects.push(o)
          }
          schema_changed(store)
        }
      } else {
        let objects = store.objects.filter(o => {
          !(identifier(o.name) == identifier(name) && o.kind == kind)
        })
        guard objects.length() != store.objects.length() || optional else {
          fail("no such " + kind + ": " + name)
        }
        if objects.length() != store.objects.length() {
          store.objects.clear()
          for o in objects {
            store.objects.push(o)
          }
          schema_changed(store)
        }
      }
      []
    }
    Insert(insertion) =>
      return execute_data_statement(store, PreparedInsert(insertion), params)
    Update(name, setters, predicate, returning) =>
      return execute_data_statement(
        store,
        PreparedUpdate(name, setters, predicate, returning),
        params,
      )
    Delete(name, predicate, returning) =>
      return execute_data_statement(
        store,
        PreparedDelete(name, predicate, returning),
        params,
      )
    AddColumn(name, col, definition) => {
      let table = get_table(store, name)
      guard !has_generated_columns(table) &&
        (!FEATURE_GENERATED_COLUMNS || !generated_column(col)) else {
        fail("unsupported ALTER ADD with generated columns")
      }
      if table.strict == Some(true) {
        validate_strict_columns([col])
      }
      guard !table.columns.any(c => identifier(c.name) == identifier(col.name)) else {
        fail("duplicate column name")
      }
      prepare_default(store, col)
      guard table.rows.is_empty() || literal_default(col.default_value) else {
        fail("Cannot add a column with non-constant default")
      }
      let value : Value = if table.rows.is_empty() {
        Null
      } else {
        apply_affinity(
          evaluate(col.default_value, evaluation(store, params, [])),
          column_affinity(table, col),
        )
      }
      guard !col.not_null || !(value is Null) || table.rows.is_empty() else {
        fail("NOT NULL constraint failed")
      }
      if FEATURE_STRICT && table.strict == Some(true) && !table.rows.is_empty() {
        let candidate = { ..table, columns: [col], }
        check_strict_values(candidate, [value])
      }
      table.columns.push(col)
      replace_table_rows(
        store,
        table,
        table.rows.map(row => { ..row, values: row.values + [value], }),
      )
      let bytes = @utf8.encode(table.sql)
      let mut end = bytes.length() - 1
      while end >= 0 && bytes[end] != b')' {
        end -= 1
      }
      guard end >= 0 else { fail("corrupt table SQL") }
      table.sql = @utf8.decode_lossy(bytes[0:end]) +
        ", " +
        definition +
        @utf8.decode_lossy(bytes[end:])
      schema_changed(store)
      []
    }
    RenameColumn(name, old, new, quoted) => {
      migrate_schema(store, name, name, old, new, false, quoted~)
      []
    }
    RenameTable(name, next) => {
      migrate_schema(store, name, next, "", "", false)
      []
    }
    DropColumn(name, column) => {
      migrate_schema(store, name, name, column, column, true)
      []
    }
  }
  result
}

///|
/// Every statement is atomic, including failures halfway through a multi-row write.
fn database_exec_inner(
  db : Database,
  sql : String,
  bindings : String,
  read_only : Bool,
  positional : Bool,
  prepared~ : SqlPrepared? = None,
) -> String {
  let mut backup : Store? = None
  let mut tracks_changes = false
  try {
    let (stmt, count) = match prepared {
      Some(query) => {
        if query.error is Some(message) {
          fail(message)
        }
        guard query.statement is Some(statement) else {
          fail("invalid SQL plan")
        }
        (statement, query.parameters)
      }
      None => {
        let parser = lex(sql)
        let statement = parse_statement(parser)
        (statement, parser.parameter)
      }
    }
    tracks_changes = stmt is Insert(_) ||
      stmt is Update(_, _, _, _) ||
      stmt is Delete(_, _, _)
    let params_json : Array[Json] = @json.from_json(@json.parse(bindings))
    let params = params_json.map(json_value) catch {
      _ => fail("invalid SQL bindings")
    }
    guard count == params.length() else { fail("SQL binding count mismatch") }
    let read = match stmt {
      Select(_) | Pragma(_, _, None) => true
      _ => false
    }
    guard !read_only || read else {
      fail("query() accepts read-only statements")
    }
    if !read {
      backup = Some(copy_store(db.store))
    }
    let cookie = db.store.cookie
    let rows = match prepared {
      Some(query) => prepared_sql_rows(query, params)
      None => execute_statement(db.store, stmt, params)
    }
    if !read {
      db.serial += 1
      if db.store.cookie != cookie {
        db.schema_epoch += 1L
      }
    }
    if positional {
      positional_result_json(rows, read)
    } else {
      ({ "rows": result_json(rows), "readonly": read } : Json).stringify()
    }
  } catch {
    e => {
      if backup is Some(previous) {
        if tracks_changes {
          previous.last_rowid = db.store.last_rowid
        }
        db.store = previous
        if tracks_changes {
          db.store.triggers.failed_statement = true
        }
      }
      public_error_json(e).stringify()
    }
  }
}

///|
pub fn database_exec(
  db : Database,
  sql : String,
  bindings : String,
  read_only : Bool,
) -> String {
  database_exec_inner(db, sql, bindings, read_only, false)
}

///|
/// SQL result columns retain ordinal position even when names are duplicated.
pub fn database_query_values(
  db : Database,
  sql : String,
  bindings : String,
) -> String {
  database_exec_inner(db, sql, bindings, true, true)
}

///|
/// Mutable execution with ordinal result columns, including DML RETURNING.
pub fn database_exec_values(
  db : Database,
  sql : String,
  bindings : String,
) -> String {
  database_exec_inner(db, sql, bindings, false, true)
}

///|
/// SQLite OR IGNORE covers row constraints, but never datatype violations or
/// evaluation errors (including an index expression or an explicit RAISE).
fn ignorable_row_constraint(message : String) -> Bool {
  message.has_prefix("NOT NULL constraint failed") ||
  message.has_prefix("CHECK constraint failed") ||
  message.has_prefix("UNIQUE constraint failed")
}

// Source: experimental_rows.mbt

///|
/// Experimental read-only result contract for optional native adapters. No JS
/// representation escapes here. Bytes stay immutable; native adapters copy them
/// before exposing mutable host byte arrays.
fn query_prepared_values(
  query : SqlPrepared,
  bindings : String,
) -> Result[Array[Array[Value]], String] {
  try {
    if query.error is Some(error) {
      fail(error)
    }
    guard query.statement is Some(Select(_)) else {
      fail("typed results accept SELECT only")
    }
    let encoded : Array[Json] = @json.from_json(@json.parse(bindings))
    let params = encoded.map(json_value) catch {
      _ => fail("invalid SQL bindings")
    }
    guard params.length() == query.parameters else {
      fail("SQL binding count mismatch")
    }
    Ok(
      prepared_sql_rows(query, params).map(row => {
        row.filter(b => !b.hidden).map(b => b.value)
      }),
    )
  } catch {
    error => Err(public_error(error))
  }
}

// Source: feature_config.mbt

///|
/// Build-time constants. The profile compiler replaces this file in an isolated workspace.
const FEATURE_OUTER_JOIN : Bool = false

///|
const FEATURE_STRICT : Bool = true

///|
const FEATURE_PRIMARY_INDEX : Bool = true

///|
const FEATURE_TRIGGERS : Bool = false

///|
const FEATURE_FOREIGN_KEYS : Bool = true

///|
const FEATURE_BINARY_SYNC : Bool = false

///|
const FEATURE_SQL_JSON : Bool = false

///|
const FEATURE_DATETIME : Bool = false

///|
const FEATURE_WINDOWS : Bool = false

///|
const FEATURE_SCHEMA_METADATA : Bool = false

///|
const FEATURE_AGGREGATE_FILTER : Bool = false

///|
const FEATURE_AGGREGATE_ORDER : Bool = false

///|
const FEATURE_ROW_VALUES : Bool = false

///|
const FEATURE_UPDATE_FROM : Bool = false

///|
const FEATURE_GENERATED_COLUMNS : Bool = false

///|
const FEATURE_JSON_TABLE : Bool = false

// Source: feature_validation.mbt

///|
fn validate_table_features(table : Table) -> Unit raise SqlError {
  for col in table.columns {
    validate_collation(col.collation)
  }
  validate_optional_features(table)
  if table.strict == Some(true) && !FEATURE_STRICT {
    fail("feature disabled: strictTables")
  }
  if !table.foreign_keys.is_empty() && !FEATURE_FOREIGN_KEYS {
    fail("feature disabled: foreignKeys")
  }
}

///|
// Shared by the binary requirement encoder and all expression validators.
// Recognition does not pull the JSON/date implementations into a small runtime.
fn function_features(name : String) -> UInt32 {
  if name == "$json-table" {
    8192U
  } else if name == "$generated-virtual" {
    4096U
  } else if name == "$filter" {
    256U
  } else if name == "$aggregate-order" {
    512U
  } else if name == "$row" {
    1024U
  } else if name == "$update-from" {
    2048U
  } else if name == "json" ||
    name.has_prefix("json_") ||
    name == "->" ||
    name == "->>" {
    16U
  } else if [
      "date", "datetime", "time", "strftime", "unixepoch", "julianday", "timediff",
    ].contains(name) {
    32U
  } else {
    0U
  }
}

///|
fn validate_function_features(name : String) -> Unit raise SqlError {
  if !FEATURE_JSON_TABLE && (function_features(name) & 8192U) != 0U {
    fail("feature disabled: jsonTableFunctions")
  }
  if !FEATURE_GENERATED_COLUMNS && (function_features(name) & 4096U) != 0U {
    fail("feature disabled: generatedColumns")
  }
  if !FEATURE_UPDATE_FROM && (function_features(name) & 2048U) != 0U {
    fail("feature disabled: updateFrom")
  }
  if !FEATURE_ROW_VALUES && (function_features(name) & 1024U) != 0U {
    fail("feature disabled: rowValues")
  }
  if !FEATURE_AGGREGATE_ORDER && (function_features(name) & 512U) != 0U {
    fail("feature disabled: aggregateOrderBy")
  }
  if !FEATURE_AGGREGATE_FILTER && (function_features(name) & 256U) != 0U {
    fail("feature disabled: aggregateFilter")
  }
  if !FEATURE_SQL_JSON && (function_features(name) & 16U) != 0U {
    fail("feature disabled: sqlJson")
  }
  if !FEATURE_DATETIME && (function_features(name) & 32U) != 0U {
    fail("feature disabled: dateTime")
  }
}

///|
fn pragma_features(name : String) -> UInt32 {
  if ["index_list", "index_info", "index_xinfo"].contains(name) {
    128U
  } else {
    0U
  }
}

///|
fn validate_pragma_features(name : String) -> Unit raise SqlError {
  if !FEATURE_SCHEMA_METADATA && pragma_features(name) != 0U {
    fail("feature disabled: schemaMetadata")
  }
}

///|
fn[T : FeatureCheck] validate_optional_features(
  value : T,
) -> Unit raise SqlError {
  if CAP_CATALOG_SPECIALIZED ||
    !FEATURE_SQL_JSON ||
    !FEATURE_DATETIME ||
    !FEATURE_WINDOWS ||
    !FEATURE_SCHEMA_METADATA ||
    !FEATURE_AGGREGATE_ORDER ||
    !FEATURE_ROW_VALUES ||
    !FEATURE_UPDATE_FROM ||
    !FEATURE_GENERATED_COLUMNS ||
    !FEATURE_JSON_TABLE ||
    !FEATURE_AGGREGATE_FILTER {
    FeatureCheck::check(value)
  }
}

// Source: feature_validation_generated.mbt
// Generated by generate-binary-codecs.ts from src/binary-wire.json.
// Contract SHA256: f3e811d415bf6e48620b30d666547b023504647406200f3b8e0f9abbe367dd96
// Capability SHA256: 29619c2e072435a6815a66a53f186049bab9599699b36935570352fe81d0b0be

///|
priv trait FeatureCheck {
  fn check(Self) -> Unit raise SqlError
}

///|
impl FeatureCheck for Int32 with fn check(_) {

}

///|
impl FeatureCheck for Bool with fn check(_) {

}

///|
impl FeatureCheck for String with fn check(_) {

}

///|
impl FeatureCheck for Value with fn check(_) {

}

///|
impl[A : FeatureCheck] FeatureCheck for Array[A] with fn check(values) {
  for v in values {
    FeatureCheck::check(v)
  }
}

///|
impl[A : FeatureCheck] FeatureCheck for A? with fn check(value) {
  if value is Some(v) {
    FeatureCheck::check(v)
  }
}

///|
impl[A : FeatureCheck, B : FeatureCheck] FeatureCheck for (A, B) with fn check(
  value,
) {
  FeatureCheck::check(value.0)
  FeatureCheck::check(value.1)
}

///|
impl FeatureCheck for Ordering with fn check(value) {
  FeatureCheck::check(value.expression)
  FeatureCheck::check(value.descending)
}

///|
impl FeatureCheck for Projection with fn check(value) {
  FeatureCheck::check(value.expression)
  FeatureCheck::check(value.explicit_label)
  FeatureCheck::check(value.label)
}

///|
impl FeatureCheck for Source with fn check(value) {
  FeatureCheck::check(value.name)
  FeatureCheck::check(value.qualifier)
  FeatureCheck::check(value.left)
  FeatureCheck::check(value.right)
  FeatureCheck::check(value.using_columns)
  FeatureCheck::check(value.natural)
  FeatureCheck::check(value.on)
}

///|
impl FeatureCheck for Selection with fn check(value) {
  for part in runtime_selection_parts(value) {
    validate_runtime_query_part(part)
  }
  FeatureCheck::check(value.ctes)
  FeatureCheck::check(value.projections)
  FeatureCheck::check(value.sources)
  FeatureCheck::check(value.predicate)
  FeatureCheck::check(value.groups)
  FeatureCheck::check(value.having)
  FeatureCheck::check(value.orders)
  FeatureCheck::check(value.limit)
  FeatureCheck::check(value.offset)
  FeatureCheck::check(value.distinct)
  FeatureCheck::check(value.compound)
  FeatureCheck::check(value.recursive)
  FeatureCheck::check(value.cte_names)
}

///|
impl FeatureCheck for ForeignKey with fn check(value) {
  FeatureCheck::check(value.column)
  FeatureCheck::check(value.parent)
  FeatureCheck::check(value.target)
  FeatureCheck::check(value.cascade)
  FeatureCheck::check(value.columns)
  FeatureCheck::check(value.targets)
  FeatureCheck::check(value.delete_action)
  FeatureCheck::check(value.update_action)
  FeatureCheck::check(value.initially_deferred)
}

///|
impl FeatureCheck for ColumnDef with fn check(value) {
  FeatureCheck::check(value.name)
  FeatureCheck::check(value.declared)
  FeatureCheck::check(value.not_null)
  FeatureCheck::check(value.primary)
  FeatureCheck::check(value.primary_desc)
  FeatureCheck::check(value.default_value)
  FeatureCheck::check(value.default_source)
  FeatureCheck::check(value.collation)
}

///|
impl FeatureCheck for Table with fn check(value) {
  FeatureCheck::check(value.name)
  FeatureCheck::check(value.sql)
  FeatureCheck::check(value.columns)
  FeatureCheck::check(value.unique_keys)
  FeatureCheck::check(value.checks)
  FeatureCheck::check(value.foreign_keys)
  FeatureCheck::check(value.without_rowid)
  FeatureCheck::check(value.strict)
  FeatureCheck::check(value.autoincrement)
}

///|
impl FeatureCheck for SchemaObject with fn check(value) {
  FeatureCheck::check(value.kind)
  FeatureCheck::check(value.name)
  FeatureCheck::check(value.table)
  FeatureCheck::check(value.sql)
  FeatureCheck::check(value.unique)
  FeatureCheck::check(value.columns)
  FeatureCheck::check(value.query)
  FeatureCheck::check(value.selection)
  FeatureCheck::check(value.index_terms)
  FeatureCheck::check(value.index_predicate)
  FeatureCheck::check(value.trigger)
}

///|
impl FeatureCheck for Insertion with fn check(value) {
  FeatureCheck::check(value.table)
  FeatureCheck::check(value.columns)
  FeatureCheck::check(value.values)
  FeatureCheck::check(value.conflict)
  FeatureCheck::check(value.target)
  FeatureCheck::check(value.updates)
  FeatureCheck::check(value.predicate)
  FeatureCheck::check(value.returning)
  FeatureCheck::check(value.conflict_override)
  FeatureCheck::check(value.target_predicate)
  FeatureCheck::check(value.selection)
}

///|
impl FeatureCheck for TriggerDefinition with fn check(value) {
  FeatureCheck::check(value.timing)
  FeatureCheck::check(value.event)
  FeatureCheck::check(value.columns)
  FeatureCheck::check(value.condition)
  FeatureCheck::check(value.body)
}

///|
impl FeatureCheck for WindowFrame with fn check(value) {
  FeatureCheck::check(value.kind)
  FeatureCheck::check(value.start)
  FeatureCheck::check(value.end)
}

///|
impl FeatureCheck for CompiledQuery with fn check(value) {
  FeatureCheck::check(value.name)
  FeatureCheck::check(value.parameters)
  FeatureCheck::check(value.names)
  FeatureCheck::check(value.statement)
}

///|
impl FeatureCheck for Expr with fn check(value) {
  match value {
    Literal(v0) => FeatureCheck::check(v0)
    TruthLiteral(v0) => FeatureCheck::check(v0)
    CurrentTime(v0) => {
      guard FEATURE_DATETIME else { fail("feature disabled: dateTime") }
      FeatureCheck::check(v0)
    }
    Parameter(v0) => FeatureCheck::check(v0)
    Column(v0, v1) => {
      FeatureCheck::check(v0)
      FeatureCheck::check(v1)
    }
    Star(v0) => FeatureCheck::check(v0)
    Unary(v0, v1) => {
      FeatureCheck::check(v0)
      FeatureCheck::check(v1)
    }
    Binary(v0, v1, v2) => {
      if CAP_CATALOG_SPECIALIZED && !CAP_FUNCTION_LIKE && v0 == "like" {
        fail("catalog capability disabled: function like")
      }
      FeatureCheck::check(v0)
      FeatureCheck::check(v1)
      FeatureCheck::check(v2)
    }
    Call(v0, v1) =>
      if CAP_EXPRESSION_CALL {
        validate_function_features(v0)
        validate_runtime_call(v0, v1.length())
        validate_runtime_json_values(v0, v1)
        FeatureCheck::check(v0)
        FeatureCheck::check(v1)
      } else {
        fail("catalog capability disabled: expression call")
      }
    Collate(v0, v1) => {
      FeatureCheck::check(v0)
      FeatureCheck::check(v1)
    }
    Cast(v0, v1) =>
      if CAP_EXPRESSION_CAST {
        FeatureCheck::check(v0)
        FeatureCheck::check(v1)
      } else {
        fail("catalog capability disabled: expression cast")
      }
    RowNumber(v0) => {
      guard FEATURE_WINDOWS else { fail("feature disabled: windowFunctions") }
      FeatureCheck::check(v0)
    }
    Window(v0, v1, v2, v3, v4) => {
      guard FEATURE_WINDOWS else { fail("feature disabled: windowFunctions") }
      FeatureCheck::check(v0)
      FeatureCheck::check(v1)
      FeatureCheck::check(v2)
      FeatureCheck::check(v3)
      FeatureCheck::check(v4)
    }
    Between(v0, v1, v2) =>
      if CAP_EXPRESSION_BETWEEN {
        FeatureCheck::check(v0)
        FeatureCheck::check(v1)
        FeatureCheck::check(v2)
      } else {
        fail("catalog capability disabled: expression between")
      }
    Case(v0, v1, v2) =>
      if CAP_EXPRESSION_CASE {
        FeatureCheck::check(v0)
        FeatureCheck::check(v1)
        FeatureCheck::check(v2)
      } else {
        fail("catalog capability disabled: expression case")
      }
    InSelect(v0, v1) =>
      if CAP_EXPRESSION_SUBQUERY {
        validate_runtime_query_part("inSelect")
        FeatureCheck::check(v0)
        FeatureCheck::check(v1)
      } else {
        fail("catalog capability disabled: expression subquery")
      }
    ScalarSelect(v0) =>
      if CAP_EXPRESSION_SUBQUERY {
        FeatureCheck::check(v0)
      } else {
        fail("catalog capability disabled: expression subquery")
      }
    Exists(v0) =>
      if CAP_EXPRESSION_SUBQUERY {
        FeatureCheck::check(v0)
      } else {
        fail("catalog capability disabled: expression subquery")
      }
  }
}

///|
impl FeatureCheck for DataStatement with fn check(value) {
  match value {
    PreparedTransaction(v0, v1) => {
      validate_runtime_statement("transaction")
      FeatureCheck::check(v0)
      FeatureCheck::check(v1)
    }
    PreparedSelect(v0) => {
      validate_runtime_statement("select")
      FeatureCheck::check(v0)
    }
    PreparedPragma(v0, v1) => {
      validate_pragma_features(v0)
      validate_runtime_statement("pragma")
      FeatureCheck::check(v0)
      FeatureCheck::check(v1)
    }
    PreparedInsert(v0) => {
      validate_runtime_statement("insert")
      FeatureCheck::check(v0)
    }
    PreparedUpdate(v0, v1, v2, v3) => {
      validate_runtime_statement("update")
      FeatureCheck::check(v0)
      FeatureCheck::check(v1)
      FeatureCheck::check(v2)
      FeatureCheck::check(v3)
    }
    PreparedDelete(v0, v1, v2) => {
      validate_runtime_statement("delete")
      FeatureCheck::check(v0)
      FeatureCheck::check(v1)
      FeatureCheck::check(v2)
    }
  }
}

///|
impl FeatureCheck for WindowBound with fn check(value) {
  match value {
    UnboundedPreceding => ()
    Preceding(v0) => FeatureCheck::check(v0)
    Current => ()
    Following(v0) => FeatureCheck::check(v0)
    UnboundedFollowing => ()
  }
}

// Source: float_text.mbt

///|
/// Parse the requested prefix of decimal digits into an unsigned integer.
fn decimal_prefix(digits : String, n : Int32) -> UInt64 {
  let mut value = 0UL
  for c in digits[0:n].to_owned().iter() {
    value = value * 10UL + (c.to_int() - 48).to_uint64()
  }
  value
}

///|
fn decimal_zeros(n : Int32) -> String {
  Array::make(n.max(0), "0").join("")
}

///|
/// SQLite 3.53's %!.17g numeric rendering: normalized binary-to-decimal conversion,
/// round-trip shortening for long 9/0 tails, then rounding to 17 digits.
/// Binary-to-decimal conversion uses integer arithmetic; shortening probes parse
/// candidate decimals back to Double. Reference: sqlite3FpDecode and numeric rendering.
fn sqlite_real_text(value : Double) -> String {
  if value == 0.0 {
    return "0.0"
  }
  if !value.is_finite() {
    return if value < 0.0 { "-Inf" } else { "Inf" }
  }
  let bits = value.abs().reinterpret_as_uint64()
  let exponent = ((bits >> 52) & 0x7ffUL).to_int()
  let mut mantissa = bits & 0xfffffffffffffUL
  let mut binary = exponent - 1086
  if exponent == 0 {
    let mut leading = 0
    while (mantissa & 0x8000000000000000UL) == 0UL {
      mantissa = mantissa << 1
      leading += 1
    }
    binary = -1074 - leading
  } else {
    mantissa = (mantissa << 11) | 0x8000000000000000UL
  }
  // Mirror SQLite's normalized 64-bit power-of-ten multiplication. Using a
  // fixed count of decimal digits here would introduce double-rounding errors.
  let decimal_power = 17 - (((binary + 63) * 78913) >> 18)
  let binary_power = (decimal_power * 108853) >> 15
  let shift = 63 - binary_power
  let ten = @bigint.BigInt::from_int(10).pow(
    @bigint.BigInt::from_int(decimal_power.abs()),
  )
  let one = @bigint.BigInt::from_int(1)
  let numerator = if decimal_power >= 0 { ten } else { one }
  let denominator = if decimal_power >= 0 { one } else { ten }
  let numerator = if shift >= 0 { numerator << shift } else { numerator }
  let denominator = if shift < 0 { denominator << -shift } else { denominator }
  let power = numerator / denominator
  let product = (@bigint.BigInt::from_uint64(mantissa) * power) >> 64
  let high = product.to_uint64() >> -(binary + binary_power + 2)
  let significand = (high + ((high << 1) & 2UL)) >> 1
  let digits = significand.to_string()
  let mut point = digits.length() - decimal_power
  let mut precision = 17
  if digits[15] == '9' && digits[14] == '9' {
    let mut count = 14
    while count > 0 && digits[count - 1] == '9' {
      count -= 1
    }
    let decimal = if count == 0 {
      1UL
    } else {
      decimal_prefix(digits, count) + 1UL
    }
    let shortened = decimal.to_string() + "e" + (point - count).to_string()
    if (@string.parse_double(shortened) catch { _ => 0.0 }) == value.abs() {
      precision = count + 1
    }
  } else if point >= digits.length() ||
    (digits[15] == '0' && digits[14] == '0' && digits[13] == '0') {
    let mut count = 13
    while count > 1 && digits[count - 1] == '0' {
      count -= 1
    }
    let shortened = decimal_prefix(digits, count).to_string() +
      "e" +
      (point - count).to_string()
    if (@string.parse_double(shortened) catch { _ => 0.0 }) == value.abs() {
      precision = count + 1
    }
  }
  let mut decimal = decimal_prefix(digits, precision)
  if digits[precision] >= '5' {
    decimal += 1UL
  }
  let rounded = decimal.to_string()
  if rounded.length() > precision {
    point += 1
  }
  let mut count = rounded.length()
  while count > 1 && rounded[count - 1] == '0' {
    count -= 1
  }
  let rounded = rounded[0:count].to_owned()
  let sign = if value < 0.0 { "-" } else { "" }
  let scientific = point - 1
  if scientific < -4 || scientific >= 17 {
    let exponent = scientific.abs().to_string()
    sign +
    rounded[0:1].to_owned() +
    "." +
    (if rounded.length() == 1 { "0" } else { rounded[1:].to_owned() }) +
    "e" +
    (if scientific < 0 { "-" } else { "+" }) +
    (if exponent.length() < 2 { "0" } else { "" }) +
    exponent
  } else if point <= 0 {
    sign + "0." + decimal_zeros(-point) + rounded
  } else if point >= count {
    sign + rounded + decimal_zeros(point - count) + ".0"
  } else {
    sign + rounded[0:point].to_owned() + "." + rounded[point:].to_owned()
  }
}

// Source: foreign_key.mbt

///|
priv struct ForeignReference {
  parent : String
  targets : Array[String]
  delete_action : String
  update_action : String
  initially_deferred : Bool
}

///|
fn Parser::foreign_reference(p : Parser) -> ForeignReference raise SqlError {
  let parent = p.name()
  let targets = if p.peek() == "(" { p.names() } else { [] }
  let mut delete_action = "no action"
  let mut update_action = "no action"
  let mut initially_deferred = false
  while true {
    if p.take("on") {
      let update = p.take("update")
      if !update {
        p.expect("delete")
      }
      let action = if p.take("no") {
        p.expect("action")
        "no action"
      } else if p.take("set") {
        if p.take("null") {
          "set null"
        } else {
          p.expect("default")
          "set default"
        }
      } else if p.take("cascade") {
        "cascade"
      } else {
        p.expect("restrict")
        "restrict"
      }
      if update {
        update_action = action
      } else {
        delete_action = action
      }
    } else if p.take("deferrable") {
      if p.take("initially") {
        initially_deferred = p.take("deferred")
        if !initially_deferred {
          p.expect("immediate")
        }
      }
    } else if p.peek() == "not" &&
      p.position + 1 < p.tokens.length() &&
      p.tokens[p.position + 1].word == "deferrable" {
      p.position += 2
      if p.take("initially") {
        if !p.take("immediate") {
          p.expect("deferred")
        }
      }
    } else {
      break
    }
  }
  { parent, targets, delete_action, update_action, initially_deferred, }
}

///|
fn make_foreign_key(
  columns : Array[Int32],
  reference : ForeignReference,
) -> ForeignKey raise SqlError {
  guard !columns.is_empty() &&
    (
      reference.targets.is_empty() ||
      columns.length() == reference.targets.length()
    ) else {
    fail("foreign key column count mismatch")
  }
  {
    column: columns[0],
    parent: reference.parent,
    target: if reference.targets.is_empty() {
      ""
    } else {
      reference.targets[0]
    },
    cascade: reference.delete_action == "cascade",
    columns: if columns.length() > 1 {
      Some(columns)
    } else {
      None
    },
    targets: if reference.targets.length() > 1 {
      Some(reference.targets)
    } else {
      None
    },
    delete_action: if reference.delete_action == "no action" ||
      reference.delete_action == "cascade" {
      None
    } else {
      Some(reference.delete_action)
    },
    update_action: if reference.update_action == "no action" {
      None
    } else {
      Some(reference.update_action)
    },
    initially_deferred: if reference.initially_deferred {
      Some(true)
    } else {
      None
    },
  }
}

///|
#derive(ToJson)
priv struct LegacyForeignKey {
  column : Int32
  parent : String
  target : String
  cascade : Bool
}

///|
impl @json.ToJson for ForeignKey with fn to_json(self) {
  let old : LegacyForeignKey = {
    column: self.column,
    parent: self.parent,
    target: self.target,
    cascade: self.cascade,
  }
  let json = @json.to_json(old)
  if json is Object(fields) {
    if self.columns is Some(v) {
      fields["columns"] = @json.to_json(v)
    }
    if self.targets is Some(v) {
      fields["targets"] = @json.to_json(v)
    }
    if self.delete_action is Some(v) {
      fields["delete_action"] = @json.to_json(v)
    }
    if self.update_action is Some(v) {
      fields["update_action"] = @json.to_json(v)
    }
    if self.initially_deferred is Some(v) {
      fields["initially_deferred"] = @json.to_json(v)
    }
  }
  json
}

///|
fn foreign_columns(fk : ForeignKey) -> Array[Int32] {
  fk.columns.unwrap_or([fk.column])
}

///|
fn foreign_targets(
  parent : Table,
  fk : ForeignKey,
) -> Array[Int32] raise SqlError {
  let names = fk.targets.unwrap_or(
    if fk.target == "" {
      []
    } else {
      [fk.target]
    },
  )
  let targets = if names.is_empty() {
    primary_key(parent)
  } else {
    names.map(n => column_index(parent, n))
  }
  guard targets.length() == foreign_columns(fk).length() else {
    fail("foreign key mismatch")
  }
  targets
}

///|
fn foreign_action(fk : ForeignKey, update : Bool) -> String {
  if update {
    fk.update_action.unwrap_or("no action")
  } else {
    fk.delete_action.unwrap_or(if fk.cascade { "cascade" } else { "no action" })
  }
}

///|
fn foreign_matches(
  store : Store,
  parent : Table,
  row : StoredRow,
  child : StoredRow,
  fk : ForeignKey,
) -> Bool raise SqlError {
  let targets = foreign_targets(parent, fk)
  foreign_columns(fk)
  .mapi((i, c) => {
    !(child.values[c] is Null) &&
    compare_stored(
      store,
      apply_affinity(
        child.values[c],
        column_affinity(parent, parent.columns[targets[i]]),
      ),
      row.values[targets[i]],
      parent.columns[targets[i]].collation,
    ) ==
    0
  })
  .all(v => v)
}

///|
fn foreign_unchanged(
  store : Store,
  parent : Table,
  old : StoredRow,
  next : StoredRow?,
  fk : ForeignKey,
) -> Bool raise SqlError {
  if next is Some(next) {
    return foreign_targets(parent, fk).all(i => {
      compare_stored(
        store,
        old.values[i],
        next.values[i],
        parent.columns[i].collation,
      ) ==
      0
    })
  }
  false
}

///|
fn foreign_restrict(
  store : Store,
  table : Table,
  old : StoredRow,
  next : StoredRow?,
) -> Unit raise SqlError {
  if !FEATURE_FOREIGN_KEYS {
    return
  }
  if !store.foreign_keys {
    return
  }
  for child in store.tables {
    for fk in child.foreign_keys {
      if identifier(fk.parent) == identifier(table.name) &&
        foreign_action(fk, next is Some(_)) == "restrict" &&
        !foreign_unchanged(store, table, old, next, fk) &&
        child.rows.any(r => foreign_matches(store, table, old, r, fk)) {
        fail("FOREIGN KEY constraint failed")
      }
    }
  }
}

///|
fn foreign_actions(
  store : Store,
  table : Table,
  old : StoredRow,
  next : StoredRow?,
  depth : Int32,
) -> Unit raise SqlError {
  if !FEATURE_FOREIGN_KEYS {
    return
  }
  if !store.foreign_keys {
    return
  }
  guard depth <= 32 else { fail("foreign key cascade depth limit") }
  let changes = store.changes
  defer {
    store.changes = changes
  }
  for child in store.tables {
    for fk in child.foreign_keys {
      if identifier(fk.parent) != identifier(table.name) ||
        foreign_unchanged(store, table, old, next, fk) {
        continue
      }
      let action = foreign_action(fk, next is Some(_))
      if action == "no action" || action == "restrict" {
        continue
      }
      for row in child.rows.copy() {
        if !foreign_matches(store, table, old, row, fk) {
          continue
        }
        if action == "cascade" && next is None {
          ignore(delete_row(store, child, row, depth + 1, true))
          continue
        }
        let targets = foreign_targets(table, fk)
        let setters = foreign_columns(fk).mapi((i, c) => {
          (
            child.columns[c].name,
            if action == "set null" {
              Literal(Null)
            } else if action == "set default" {
              Literal(column_default(store, child, child.columns[c], []))
            } else {
              Literal(next.unwrap().values[targets[i]])
            },
          )
        })
        let updated = updated_row(store, child, row, setters, [], [])
        let columns = setters.map(s => s.0)
        prepare_trigger_event(store, child, "update", columns)
        if !run_triggers(
            store,
            child,
            "before",
            "update",
            columns,
            Some(row),
            Some(updated),
          ) {
          continue
        }
        ignore(check_updated_row(store, child, row, updated, []))
        foreign_restrict(store, child, row, Some(updated))
        replace_table_row(store, child, row, updated)
        foreign_actions(store, child, row, Some(updated), depth + 1)
        ignore(
          run_triggers(
            store,
            child,
            "after",
            "update",
            columns,
            Some(row),
            Some(updated),
          ),
        )
      }
    }
  }
}

///|
fn prepare_foreign_table(store : Store, table : Table) -> Unit raise SqlError {
  if !FEATURE_FOREIGN_KEYS || !store.foreign_keys {
    return
  }
  for fk in table.foreign_keys {
    let parent = get_table(store, fk.parent)
    let targets = foreign_targets(parent, fk)
    guard unique_keys(store, parent).any(k => {
      k.length() == targets.length() && targets.all(i => k.contains(i))
    }) else {
      fail("foreign key mismatch: " + table.name)
    }
  }
}

// Source: format.mbt

///|
/// Deliberately bounded portable subset of SQLite's SQL formatter. Floating
/// conversions and newer escaping dialects fail explicitly until differential
/// tests establish their exact output across supported SQLite versions.
const FORMAT_OUTPUT_LIMIT : Int32 = 1048576

///|
priv struct FormatArguments {
  values : Array[Value]
  mut index : Int32
}

///|
fn FormatArguments::next(self : FormatArguments) -> Value {
  let index = self.index
  self.index += 1
  self.values.get(index).unwrap_or(Null)
}

///|
fn format_extent(value : Int64) -> Int32 raise SqlError {
  guard value >= -1048576L && value <= 1048576L else {
    fail("format output limit exceeded")
  }
  value.abs().to_int()
}

///|
fn format_repeat(text : String, count : Int32) -> String raise SqlError {
  let bytes = @utf8.encode(text).length()
  guard count >= 0 && (bytes == 0 || count <= FORMAT_OUTPUT_LIMIT / bytes) else {
    fail("format output limit exceeded")
  }
  let out = StringBuilder()
  for _ in 0..<count {
    out.write_string(text)
  }
  out.to_string()
}

///|
fn format_terminated(text : String) -> String {
  let out = StringBuilder()
  for c in text.iter() {
    if c == '\u{0}' {
      break
    }
    out.write_char(c)
  }
  out.to_string()
}

///|
fn format_number(
  chars : Array[Char],
  start : Int32,
) -> (Int32, Int32) raise SqlError {
  let mut value = 0
  let mut i = start
  while i < chars.length() && chars[i] >= '0' && chars[i] <= '9' {
    value = value * 10 + chars[i].to_int() - 48
    guard value <= FORMAT_OUTPUT_LIMIT else {
      fail("format output limit exceeded")
    }
    i += 1
  }
  (value, i)
}

///|
fn format_string_slice(
  text : String,
  precision : Int32,
  characters : Bool,
) -> String raise SqlError {
  if precision < 0 {
    return text
  }
  if characters {
    let chars = text.iter().to_array()
    return String::from_iter(chars[0:precision].iter())
  }
  let bytes = @utf8.encode(text)
  @utf8.decode(bytes[0:precision].to_owned()) catch {
    _ => fail("unsupported format: precision splits a UTF-8 character")
  }
}

///|
fn format_integer(
  value : Value,
  kind : Char,
  width : Int32,
  precision : Int32,
  zero : Bool,
  plus : Bool,
  space : Bool,
  alternate : Bool,
  comma : Bool,
) -> String raise SqlError {
  let n = integer_value(value)
  let signed = kind == 'd' || kind == 'i'
  let magnitude = if signed && n < 0L {
    0UL - n.reinterpret_as_uint64()
  } else {
    n.reinterpret_as_uint64()
  }
  let sign = if signed {
    if n < 0L {
      "-"
    } else if plus {
      "+"
    } else if space {
      " "
    } else {
      ""
    }
  } else {
    ""
  }
  let base = if kind == 'o' {
    8UL
  } else if ['x', 'X', 'p'].contains(kind) {
    16UL
  } else {
    10UL
  }
  let alphabet = if kind == 'X' || kind == 'p' {
    b"0123456789ABCDEF"
  } else {
    b"0123456789abcdef"
  }
  let mut remaining = magnitude
  let mut digits = ""
  while true {
    digits = alphabet[(remaining % base).to_int()]
      .to_int()
      .unsafe_to_char()
      .to_string() +
      digits
    remaining = remaining / base
    if remaining == 0UL {
      break
    }
  }
  let precision = if zero {
    precision.max(width - sign.length())
  } else {
    precision
  }
  digits = format_repeat("0", (precision - digits.length()).max(0)) + digits
  if comma && base == 10UL {
    let out = StringBuilder()
    for i, c in digits.iter().to_array() {
      if i > 0 && (digits.length() - i) % 3 == 0 {
        out.write_char(',')
      }
      out.write_char(c)
    }
    digits = out.to_string()
  }
  let prefix = if alternate && magnitude != 0UL {
    if kind == 'o' {
      "0"
    } else if kind == 'x' || kind == 'p' {
      "0x"
    } else if kind == 'X' {
      "0X"
    } else {
      ""
    }
  } else {
    ""
  }
  prefix + sign + digits
}

///|
fn format_value(values : Array[Value]) -> Value raise SqlError {
  if values.is_empty() || values[0] is Null {
    return Null
  }
  let template = format_terminated(checked_text_value(values[0]))
  if template.is_empty() {
    fail("unsupported SQL: empty format differs across SQLite versions")
  }
  guard @utf8.encode(template).length() <= FORMAT_OUTPUT_LIMIT else {
    fail("format output limit exceeded")
  }
  let chars = template.iter().to_array()
  let args : FormatArguments = { values, index: 1, }
  let out = StringBuilder()
  let mut size = 0
  let mut i = 0
  while i < chars.length() {
    if chars[i] != '%' {
      let start = i
      while i < chars.length() && chars[i] != '%' {
        i += 1
      }
      let text = String::from_iter(chars[start:i].iter())
      size += @utf8.encode(text).length()
      guard size <= FORMAT_OUTPUT_LIMIT else {
        fail("format output limit exceeded")
      }
      out.write_string(text)
      continue
    }
    i += 1
    if i == chars.length() {
      guard size < FORMAT_OUTPUT_LIMIT else {
        fail("format output limit exceeded")
      }
      out.write_char('%')
      break
    }
    let mut left = false
    let mut zero = false
    let mut plus = false
    let mut space = false
    let mut alternate = false
    let mut characters = false
    let mut comma = false
    while i < chars.length() {
      match chars[i] {
        '-' => left = true
        '0' => zero = true
        '+' => plus = true
        ' ' => space = true
        '#' => alternate = true
        '!' => characters = true
        ',' => comma = true
        _ => break
      }
      i += 1
    }
    let width = if i < chars.length() && chars[i] == '*' {
      i += 1
      let n = integer_value(args.next())
      if n < 0L {
        left = true
      }
      format_extent(n)
    } else {
      let (n, next) = format_number(chars, i)
      i = next
      n
    }
    let precision = if i < chars.length() && chars[i] == '.' {
      i += 1
      if i < chars.length() && chars[i] == '*' {
        i += 1
        format_extent(integer_value(args.next()))
      } else {
        let (n, next) = format_number(chars, i)
        i = next
        n
      }
    } else {
      -1
    }
    if i < chars.length() && chars[i] == 'l' {
      i += 1
      if i < chars.length() && chars[i] == 'l' {
        i += 1
      }
    }
    guard i < chars.length() else {
      fail("unsupported format: incomplete substitution")
    }
    let kind = chars[i]
    i += 1
    if kind == 'n' {
      continue
    }
    let value : Value = if kind == '%' { Null } else { args.next() }
    let text = if ['d', 'i', 'u', 'x', 'X', 'o', 'p'].contains(kind) {
      format_integer(
        value, kind, width, precision, zero, plus, space, alternate, comma,
      )
    } else if kind == '%' {
      "%"
    } else if kind == 'c' {
      let text = format_terminated(checked_text_value(value))
      let first = text.iter().next().unwrap_or('\u{0}')
      format_repeat(first.to_string(), precision.max(1))
    } else if ['s', 'z', 'q', 'Q', 'w'].contains(kind) {
      guard !alternate || (kind != 'q' && kind != 'Q') else {
        fail("unsupported format: alternate SQL escaping")
      }
      if value is Null && kind == 'Q' {
        format_string_slice("NULL", precision, characters)
      } else {
        let text = if value is Null {
          if kind == 'q' || kind == 'w' {
            "(NULL)"
          } else {
            ""
          }
        } else {
          format_terminated(checked_text_value(value))
        }
        guard @utf8.encode(text).length() <= FORMAT_OUTPUT_LIMIT else {
          fail("format output limit exceeded")
        }
        let text = format_string_slice(text, precision, characters)
        if kind == 'q' || kind == 'Q' || kind == 'w' {
          // Quote escaping can double the retained bytes. Check before replacing.
          guard @utf8.encode(text).length() <= (FORMAT_OUTPUT_LIMIT - 2) / 2 else {
            fail("format output limit exceeded")
          }
          let text = if kind == 'w' {
            text.replace_all(old="\"", new="\"\"")
          } else {
            text.replace_all(old="'", new="''")
          }
          if kind == 'Q' {
            "'" + text + "'"
          } else {
            text
          }
        } else {
          text
        }
      }
    } else {
      fail("unsupported format conversion: " + kind.to_string())
    }
    let length = if kind == 'c' || characters {
      text.iter().count()
    } else {
      @utf8.encode(text).length()
    }
    let padding = (width - length).max(0)
    let bytes = @utf8.encode(text).length()
    guard padding <= FORMAT_OUTPUT_LIMIT - size &&
      bytes <= FORMAT_OUTPUT_LIMIT - size - padding else {
      fail("format output limit exceeded")
    }
    let spaces = format_repeat(" ", padding)
    if !left {
      out.write_string(spaces)
    }
    out.write_string(text)
    if left {
      out.write_string(spaces)
    }
    size += bytes + padding
  }
  Text(out.to_string())
}

// Source: function_collation.mbt

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

// Source: generated_columns.mbt

///|
/// Fixed-schema derived metadata. Cached cells are immutable/recomputed at writes
/// and reopen; persistent rows carry NULL placeholders at virtual ordinals.
priv struct GeneratedPlan {
  layout : Environment
  columns : Array[(Int32, String, BoundExpression)]
}

///|
fn generated_column(col : ColumnDef) -> Bool {
  col.default_value is Call("$generated-virtual", _)
}

///|
fn has_generated_columns(table : Table) -> Bool {
  FEATURE_GENERATED_COLUMNS && table.columns.any(generated_column)
}

///|
fn writable_column(table : Table, name : String) -> Int32 raise SqlError {
  let i = column_index(table, name)
  guard !FEATURE_GENERATED_COLUMNS || !generated_column(table.columns[i]) else {
    fail("cannot write generated column: " + name)
  }
  i
}

///|
fn insert_columns(table : Table) -> Array[Int32] {
  if !FEATURE_GENERATED_COLUMNS {
    return table.columns.mapi((i, _) => i)
  }
  table.columns
  .mapi((i, _) => i)
  .filter(i => !FEATURE_GENERATED_COLUMNS || !generated_column(table.columns[i]))
}

///|
fn generated_dependencies(
  table : Table,
  e : Expr,
) -> Array[Int32] raise SqlError {
  match e {
    Literal(_) => []
    TruthLiteral(value) => {
      let name = if value { "true" } else { "false" }
      match table.columns.search_by(c => matches_identifier(c.name, name)) {
        Some(i) => [i]
        None => []
      }
    }
    Column(q, n) => {
      guard q == "" else { fail("qualified column in generated expression") }
      [column_index(table, n)]
    }
    Unary(_, e) | Cast(e, _) | Collate(e, _) => generated_dependencies(table, e)
    Binary(_, a, b) =>
      generated_dependencies(table, a) + generated_dependencies(table, b)
    Between(e, a, b) =>
      generated_dependencies(table, e) +
      generated_dependencies(table, a) +
      generated_dependencies(table, b)
    Case(base, arms, other) => {
      let result = base.map(e => generated_dependencies(table, e)).unwrap_or([])
      for (condition, value) in arms {
        for
          i in generated_dependencies(table, condition) +
          generated_dependencies(table, value) {
          result.push(i)
        }
      }
      for i in generated_dependencies(table, other) {
        result.push(i)
      }
      result
    }
    Call(name, args) => {
      guard !aggregate_name(name, args.length()) &&
        (
          [
            "abs", "length", "octet_length", "typeof", "coalesce", "ifnull", "nullif",
            "iif", "if", "lower", "upper", "substr", "substring", "trim", "ltrim",
            "rtrim", "replace", "instr", "hex", "unhex", "unicode", "char", "quote",
            "zeroblob", "round", "sign", "min", "max", "like", "glob", "in", "ceil",
            "ceiling", "floor", "trunc", "->", "->>", "json",
          ].contains(name) ||
          name.has_prefix("json_")
        ) else {
        fail(
          "unsupported nondeterministic or non-scalar generated expression: " +
          name,
        )
      }
      let result : Array[Int32] = []
      for arg in args {
        for i in generated_dependencies(table, arg) {
          result.push(i)
        }
      }
      result
    }
    _ => fail("unsupported generated expression")
  }
}

///|
fn generated_visit(
  table : Table,
  i : Int32,
  state : Array[Int32],
  order : Array[Int32],
  depth : Int32,
) -> Unit raise SqlError {
  guard depth <= 64 else { fail("generated dependency resource limit") }
  if state[i] == 2 {
    return
  }
  guard state[i] == 0 else { fail("generated column dependency cycle") }
  state[i] = 1
  if table.columns[i].default_value is Call("$generated-virtual", [expression]) {
    guard table.columns[i].default_source is None ||
      table.columns[i].default_source == Some("") else {
      fail("DEFAULT on a generated column")
    }
    guard affinity_name(table.columns[i].declared) != "real" else {
      fail("unsupported REAL affinity generated column")
    }
    guard table.columns[i].primary == 0 else {
      fail("generated column cannot be PRIMARY KEY")
    }
    for dependency in generated_dependencies(table, expression) {
      generated_visit(table, dependency, state, order, depth + 1)
    }
    order.push(i)
  } else {
    guard !generated_column(table.columns[i]) else {
      fail("invalid generated column metadata")
    }
  }
  state[i] = 2
}

///|
fn validate_generated_table(
  store : Store,
  table : Table,
) -> Unit raise SqlError {
  if !has_generated_columns(table) {
    return
  }
  guard table.columns.any(c => !generated_column(c)) else {
    fail("table requires a non-generated column")
  }
  let layout = row_environment(
    table,
    { id: 0L, values: Array::make(table.columns.length(), Null), },
    table.name,
  )
  let context = evaluation(store, [], layout)
  let order : Array[Int32] = []
  let state = Array::make(table.columns.length(), 0)
  for i in 0..<table.columns.length() {
    generated_visit(table, i, state, order, 0)
  }
  let columns = order.map(i => {
    guard table.columns[i].default_value
      is Call("$generated-virtual", [expression]) else {
      fail("invalid generated column metadata")
    }
    prepare_expression(expression, context, false, false)
    (
      i,
      column_affinity(table, table.columns[i]),
      bind_expression(expression, context),
    )
  })
  store.generated_plans[table.sql] = { layout, columns, }
}

///|
fn generated_row(
  store : Store,
  table : Table,
  row : StoredRow,
  storage~ : Bool = false,
) -> StoredRow raise SqlError {
  if !has_generated_columns(table) {
    return row
  }
  if !store.generated_plans.contains(table.sql) {
    validate_generated_table(store, table)
  }
  guard row.values.length() == table.columns.length() else {
    fail("invalid generated row width")
  }
  let plan = store.generated_plans[table.sql]
  let values = row.values.copy()
  for (i, affinity, expression) in plan.columns {
    guard !storage || values[i] is Null else {
      fail("generated value in persistent row")
    }
    let input : BoundInput = {
      store,
      params: [],
      row: { id: row.id, values, },
      layout: plan.layout,
      context: None,
      joined: None,
      in_lists: [],
    }
    values[i] = apply_affinity(evaluate_bound(expression, input), affinity)
  }
  { ..row, values, }
}

///|
fn persistent_generated_row(table : Table, row : StoredRow) -> StoredRow {
  if !has_generated_columns(table) {
    return row
  }
  {
    ..row,
    values: row.values.mapi((i, value) => {
      if generated_column(table.columns[i]) {
        Null
      } else {
        value
      }
    }),
  }
}

///|
fn column_default(
  store : Store,
  table : Table,
  col : ColumnDef,
  params : Array[Value],
) -> Value raise SqlError {
  if FEATURE_GENERATED_COLUMNS && generated_column(col) {
    return Null
  }
  // Most omitted columns have a literal NULL default. Avoid allocating an
  // evaluation context for literals; expressions still run once per row.
  let value = match col.default_value {
    Literal(Null) => return Null
    Literal(value) => value
    TruthLiteral(value) => boolean(value)
    expression =>
      evaluate(expression, { ..evaluation(store, params, []), outer: [], })
  }
  apply_affinity(value, column_affinity(table, col))
}

// Source: glob.mbt

///|
priv enum GlobAtom {
  GlobMany
  GlobOne
  GlobLiteral(Char)
  GlobClass(Bool, Array[(Char, Char)])
}

///|
fn glob_atom_matches(atom : GlobAtom, c : Char) -> Bool {
  match atom {
    GlobOne => true
    GlobLiteral(want) => c == want
    GlobClass(invert, ranges) =>
      ranges.any(range => c >= range.0 && c <= range.1) != invert
    GlobMany => false
  }
}

///|
/// Classes consume one Unicode scalar. Retry only the most recent star, so
/// hostile patterns do not cause recursive or exponential backtracking.
fn glob(text : String, pattern : String) -> Bool {
  let text = pattern_chars(text)
  let pattern = pattern_chars(pattern)
  let atoms : Array[GlobAtom] = []
  let mut i = 0
  while i < pattern.length() {
    let c = pattern[i]
    i += 1
    if c == '*' {
      atoms.push(GlobMany)
    } else if c == '?' {
      atoms.push(GlobOne)
    } else if c == '[' {
      let invert = i < pattern.length() && pattern[i] == '^'
      if invert {
        i += 1
      }
      let ranges : Array[(Char, Char)] = []
      if i < pattern.length() && pattern[i] == ']' {
        ranges.push((']', ']'))
        i += 1
      }
      let mut prior : Char? = None
      while i < pattern.length() && pattern[i] != ']' {
        let c = pattern[i]
        if c == '-' &&
          i + 1 < pattern.length() &&
          pattern[i + 1] != ']' &&
          prior is Some(low) {
          ranges.push((low, pattern[i + 1]))
          prior = None
          i += 2
        } else {
          ranges.push((c, c))
          prior = Some(c)
          i += 1
        }
      }
      guard i < pattern.length() else { return false }
      i += 1
      atoms.push(GlobClass(invert, ranges))
    } else {
      atoms.push(GlobLiteral(c))
    }
  }
  let mut p = 0
  let mut t = 0
  let mut star = -1
  let mut retry = 0
  while t < text.length() {
    if p < atoms.length() && atoms[p] is GlobMany {
      star = p
      retry = t
      p += 1
    } else if p < atoms.length() && glob_atom_matches(atoms[p], text[t]) {
      p += 1
      t += 1
    } else if star >= 0 {
      retry += 1
      t = retry
      p = star + 1
    } else {
      return false
    }
  }
  while p < atoms.length() && atoms[p] is GlobMany {
    p += 1
  }
  p == atoms.length()
}

// Source: image.mbt

///|
/// Serialize table metadata without compiled DEFAULT declaration sources.
fn table_definition(table : Table) -> Json {
  let json : Json = {
    "name": table.name,
    "columns": @json.to_json(
      table.columns.map(c => { ..c, default_source: None, }),
    ),
    "unique": @json.to_json(table.unique_keys),
    "checks": @json.to_json(table.checks),
    "foreign": @json.to_json(table.foreign_keys),
    "withoutRowid": table.without_rowid,
    "autoincrement": table.autoincrement,
  }
  if table.strict is Some(value) && json is Object(fields) {
    fields["strict"] = @json.to_json(value)
  }
  json
}

///|
fn validate_store_rows(
  store : Store,
  storage~ : Bool = false,
) -> Unit raise SqlError {
  guard [1, 2, 3].contains(store.encoding.unwrap_or(1)) &&
    store.cookie >= 0 &&
    store.changes >= 0 &&
    !store.deferred &&
    store.tables.length() <= 1000 &&
    store.objects.length() <= 1000 else {
    fail("invalid Moon SQL image metadata")
  }
  let names : Map[String, Bool] = Map([])
  for table in store.tables {
    validate_table_features(table)
    for col in table.columns {
      prepare_default(store, col)
    }
    validate_generated_table(store, table)
    if has_generated_columns(table) {
      invalidate_table_indexes(store, table)
      table.rows = row_pages(
        table.rows.map(row => generated_row(store, table, row, storage~)),
      )
    }
    if table.strict == Some(true) {
      validate_strict_columns(table.columns)
    }
    guard !names.contains(schema_name_key("table", table.name)) &&
      table.columns.length() > 0 &&
      table.columns.length() <= 2000 &&
      table.rows.length() <= 100000 else {
      fail("invalid Moon SQL image table")
    }
    names[schema_name_key("table", table.name)] = true
    let ids : Map[String, Bool] = Map([])
    let ipk = integer_primary(table)
    for row in table.rows {
      guard row.values.length() == table.columns.length() &&
        !ids.contains(row.id.to_string()) else {
        fail("invalid Moon SQL image row")
      }
      ids[row.id.to_string()] = true
      guard ipk < 0 || row.values[ipk] == Integer(row.id) else {
        fail("invalid Moon SQL image rowid")
      }
      for v in row.values {
        if v is Real(n) {
          guard !n.is_nan() else { fail("invalid Moon SQL image real") }
        }
      }
      check_row(store, table, row.values, [])
      guard conflict_row(store, table, row.values, Some(row.id), None) is None else {
        fail("invalid Moon SQL image UNIQUE constraint")
      }
    }
  }
  for obj in store.objects {
    validate_optional_features(obj)
    if obj.kind == "trigger" && !FEATURE_TRIGGERS {
      fail("feature disabled: triggers")
    }
    guard !names.contains(schema_name_key(obj.kind, obj.name)) else {
      fail("invalid Moon SQL image object")
    }
    names[schema_name_key(obj.kind, obj.name)] = true
    if obj.kind == "index" {
      validate_index_definition(store, get_table(store, obj.table), obj)
    }
    if obj.kind == "trigger" {
      validate_trigger_metadata(get_table(store, obj.table), obj)
    }
  }
  validate_foreign_keys(store)
}

///|
/// Reopen validates the logical schema and row invariants before publication.
fn validate_image(
  store : Store,
  storage~ : Bool = false,
) -> Unit raise SqlError {
  guard store.tables.length() <= 1000 && store.objects.length() <= 1000 else {
    fail("invalid Moon SQL image metadata")
  }
  for table in store.tables {
    let parsed = parse_statement(lex(table.sql))
    guard parsed is CreateTable(definition, _) else {
      fail("invalid Moon SQL image schema")
    }
    if table.columns.length() == definition.columns.length() {
      for i, col in table.columns {
        if col.default_source is Some(source) {
          guard definition.columns[i].default_source == Some(source) else {
            fail("invalid Moon SQL declaration metadata")
          }
        }
      }
    }
    guard table_definition(table) == table_definition(definition) else {
      fail("invalid Moon SQL image schema")
    }
    // Recover observable declaration spelling without rewriting a legacy image.
    store.declaration_sources[table.sql] = definition.columns.map(c => {
      c.default_source.unwrap_or("")
    })
  }
  for obj in store.objects {
    let parsed = parse_statement(lex(obj.sql))
    if obj.selection is None && parsed is CreateObject(definition, _) {
      obj.selection = definition.selection
    }
    guard parsed is CreateObject(definition, _) &&
      @json.to_json(obj) == @json.to_json(definition) else {
      fail("invalid Moon SQL image object schema")
    }
  }
  validate_store_rows(store, storage~)
}

///|
/// Fixed schema identity for parser-free images; mutable rows and counters are excluded.
fn schema_identity(store : Store) -> Json {
  {
    "encoding": store.encoding.unwrap_or(1),
    "cookie": store.cookie,
    "tables": store.tables.map(table => {
      ({ "sql": table.sql, "definition": table_definition(table) } : Json)
    }),
    "objects": @json.to_json(store.objects),
    "foreignKeys": store.foreign_keys,
  }
}

// Source: in_list_lookup.mbt

///|
/// Admission limits for retained cache payload, not a heap/peak limit.
priv struct InCacheBudget {
  mut entries : Int32
  mut bytes : Int32
}

///|
fn in_cache_budget(
  entries~ : Int32 = 4096,
  bytes~ : Int32 = 262144,
) -> InCacheBudget {
  { entries, bytes, }
}

///|
fn reserve_in_cache(
  budget : InCacheBudget,
  entries : Int32,
  bytes : Int32,
) -> Bool {
  if entries > budget.entries || bytes > budget.bytes {
    return false
  }
  budget.entries -= entries
  budget.bytes -= bytes
  true
}

///|
fn in_cache_value_bytes(value : Value) -> Int32 {
  match value {
    Text(s) => 96 + s.length() * 12 // JSON escaping, collation key and value payload
    Blob(b) => 96 + b.length() * 8
    _ => 96
  }
}

///|
fn admit_in_values(budget : InCacheBudget, values : Array[Value]) -> Bool {
  if values.length() > budget.entries {
    return false
  }
  let mut remaining = budget.bytes
  for value in values {
    let size = in_cache_value_bytes(value)
    if size > remaining {
      return false
    }
    remaining -= size
  }
  reserve_in_cache(budget, values.length(), budget.bytes - remaining)
}

///|
fn admit_in_rows(budget : InCacheBudget, rows : Array[Array[Value]]) -> Bool {
  if rows.length() > budget.entries {
    return false
  }
  let mut remaining = budget.bytes
  for row in rows {
    let overhead = 16 + row.length() * 8
    if overhead > remaining {
      return false
    }
    remaining -= overhead
    for value in row {
      let size = in_cache_value_bytes(value)
      if size > remaining {
        return false
      }
      remaining -= size
    }
  }
  reserve_in_cache(budget, rows.length(), budget.bytes - remaining)
}

///|
/// Immutable AST/schema facts. RHS values from parameters are never retained.
priv struct PreparedInList {
  arguments : Array[Expr]
  right : Array[BoundValue]
  affinity : String
  left_affinity : String
  coerce_left : Bool
  collation : String
  row : PreparedRowIn?
}

///|
priv struct PreparedRowIn {
  fields : Array[Expr]
  metadata : Array[RowValueMetadata]
  right : Array[Array[BoundValue]]
  affinities : Array[String]
  collations : Array[String]
}

///|
priv struct InListLookup {
  keys : Map[String, Bool]
  integers : Map[Int64, Bool]
  has_null : Bool
  rows : Array[Array[Value]]
  null_rows : Array[Array[Value]]
}

///|
/// Integer and exactly integral REAL values compare equally. Keep the int64
/// key itself instead of formatting JSON on every row. Do not coerce TEXT or
/// round REAL values outside the signed integer range.
fn in_list_integer_key(value : Value) -> Int64? {
  match value {
    Integer(n) => Some(n)
    Real(n) =>
      if n >= -9223372036854775808.0 &&
        n < 9223372036854775808.0 &&
        n.to_int64().to_double() == n {
        Some(n.to_int64())
      } else {
        None
      }
    _ => None
  }
}

///|
/// Fresh mutable state per SELECT execution; populated only on first use.
priv struct InListFrame {
  plan : PreparedInList
  mut lookup : InListLookup?
  mut disabled : Bool
  budget : InCacheBudget
}

///|
fn in_list_frames(
  plans : Array[PreparedInList],
  budget~ : InCacheBudget = in_cache_budget(),
) -> Array[InListFrame] {
  plans.map(plan => { plan, lookup: None, disabled: false, budget, })
}

///|
fn statement_in_lists(
  expressions : Array[Expr],
  context : Evaluation,
) -> Array[PreparedInList] raise SqlError {
  let plans : Array[PreparedInList] = []
  if OPT_IN_LIST_LOOKUP && CAP_FUNCTION_IN_LIST {
    for e in expressions {
      prepare_in_lists(e, context, plans)
    }
  }
  plans
}

///|
fn lookup_expression(e : Expr) -> Bool {
  match e {
    InSelect(_, _) => OPT_IN_SELECT_LOOKUP
    Call("in", args) =>
      (OPT_IN_LIST_LOOKUP && args.length() >= 17) || args.any(lookup_expression)
    Call(_, args) => args.any(lookup_expression)
    Unary(_, e) | Cast(e, _) | Collate(e, _) => lookup_expression(e)
    Binary(_, a, b) => lookup_expression(a) || lookup_expression(b)
    Between(e, a, b) => [e, a, b].any(lookup_expression)
    Case(base, arms, other) =>
      base.map(lookup_expression).unwrap_or(false) ||
      arms.any(p => lookup_expression(p.0) || lookup_expression(p.1)) ||
      lookup_expression(other)
    _ => false
  }
}

///|
fn prepare_in_lists(
  e : Expr,
  ctx : Evaluation,
  output : Array[PreparedInList],
) -> Unit raise SqlError {
  if output.length() >= 16 {
    return
  }
  match e {
    Call("in", args) => {
      if FEATURE_ROW_VALUES &&
        args.length() >= 17 &&
        args[0] is Call("$row", fields) &&
        !fields.any(has_subquery) &&
        args[1:]
        .to_array()
        .all(e => {
          e is Call("$row", right) &&
          right.length() == fields.length() &&
          right.all(e => bind_key_value(e) is Some(_))
        }) {
        let metadata = fields.map(e => row_field_metadata(e, ctx))
        let right = args[1:]
          .to_array()
          .map(e => {
            guard e is Call("$row", right) else { fail("invalid row IN plan") }
            right.map(e => bind_key_value(e).unwrap())
          })
        output.push({
          arguments: args,
          right: [],
          affinity: "",
          left_affinity: "",
          coerce_left: false,
          collation: "binary",
          row: Some({
            fields,
            metadata,
            right,
            affinities: metadata.map(m => in_comparison_affinity(m.affinity, "")),
            collations: metadata.map(m => {
              if m.explicit_collation || m.column {
                m.collation
              } else {
                "binary"
              }
            }),
          }),
        })
      }
      if args.length() >= 17 &&
        !(args[0] is Call("$row", _)) &&
        args[1:].to_array().all(e => bind_key_value(e) is Some(_)) {
        let affinity = expression_affinity(args[0], ctx)
        output.push({
          arguments: args,
          right: args[1:].to_array().map(e => bind_key_value(e).unwrap()),
          affinity: if affinity == "real" {
            "numeric"
          } else {
            affinity
          },
          left_affinity: affinity,
          coerce_left: FEATURE_OUTER_JOIN &&
          args[0] is Column("", name) &&
          find_context(ctx, "", name) is Some(b) &&
          b.join_column is Some(MergedJoinColumn(_, _, _)),
          collation: expression_collation(args[0], ctx),
          row: None,
        })
      }
      for arg in args {
        prepare_in_lists(arg, ctx, output)
      }
    }
    Call(_, args) =>
      for arg in args {
        prepare_in_lists(arg, ctx, output)
      }
    Unary(_, e) | Cast(e, _) | Collate(e, _) => prepare_in_lists(e, ctx, output)
    Binary(_, a, b) => {
      prepare_in_lists(a, ctx, output)
      prepare_in_lists(b, ctx, output)
    }
    Between(e, a, b) =>
      for item in [e, a, b] {
        prepare_in_lists(item, ctx, output)
      }
    Case(base, arms, otherwise) => {
      if base is Some(e) {
        prepare_in_lists(e, ctx, output)
      }
      for (a, b) in arms {
        prepare_in_lists(a, ctx, output)
        prepare_in_lists(b, ctx, output)
      }
      prepare_in_lists(otherwise, ctx, output)
    }
    _ => ()
  }
}

///|
fn in_list_lookup(
  args : Array[Expr],
  ctx : Evaluation,
) -> Value? raise SqlError {
  for frame in ctx.in_lists {
    if !physical_equal(frame.plan.arguments, args) {
      continue
    }
    let plan = frame.plan
    if FEATURE_ROW_VALUES && plan.row is Some(row) {
      return Some(row_in_list_lookup(frame, row, ctx))
    }
    let value = evaluate(args[0], ctx)
    let value = if plan.coerce_left {
      apply_affinity(value, plan.left_affinity)
    } else {
      value
    }
    return Some(scalar_in_list_lookup(frame, value, ctx.params, ctx.store))
  }
  None
}

///|
fn scalar_in_list_lookup(
  frame : InListFrame,
  value : Value,
  params : Array[Value],
  store : Store,
) -> Value raise SqlError {
  let plan = frame.plan
  if frame.disabled {
    return scalar_in_list_linear(plan, value, params, store)
  }
  let lookup = match frame.lookup {
    Some(lookup) => lookup
    None => {
      let values = plan.right.map(right => {
        apply_affinity(
          expression_value(read_key_value(right, params), store),
          plan.affinity,
        )
      })
      if !admit_in_values(frame.budget, values) {
        frame.disabled = true
        return scalar_in_values(value, values, plan.collation, store)
      }
      let keys : Map[String, Bool] = Map([])
      let integers : Map[Int64, Bool] = Map([])
      let mut has_null = false
      for value in values {
        if in_list_integer_key(value) is Some(n) {
          integers[n] = true
        } else {
          match primary_part_key(value, "", plan.collation) {
            Some(key) => keys[key.stringify()] = true
            None => has_null = true
          }
        }
      }
      let lookup = { keys, integers, has_null, rows: [], null_rows: [], }
      frame.lookup = Some(lookup)
      lookup
    }
  }
  if value is Null {
    return Null
  }
  let found = match in_list_integer_key(value) {
    Some(n) => lookup.integers.contains(n)
    None =>
      primary_part_key(value, "", plan.collation) is Some(key) &&
      lookup.keys.contains(key.stringify())
  }
  if found {
    return Integer(1L)
  }
  if lookup.has_null {
    Null
  } else {
    Integer(0L)
  }
}

///|
fn scalar_in_values(
  left : Value,
  values : Array[Value],
  collation : String,
  store : Store,
) -> Value raise SqlError {
  let mut unknown = false
  for right in values {
    if left is Null || right is Null {
      unknown = true
      continue
    }
    if compare_stored(store, left, right, collation) == 0 {
      return Integer(1L)
    }
  }
  if unknown {
    Null
  } else {
    Integer(0L)
  }
}

///|
fn scalar_in_list_linear(
  plan : PreparedInList,
  left : Value,
  params : Array[Value],
  store : Store,
) -> Value raise SqlError {
  let values = plan.right.map(v => {
    apply_affinity(
      expression_value(read_key_value(v, params), store),
      plan.affinity,
    )
  })
  scalar_in_values(left, values, plan.collation, store)
}

///|
/// A slot reader for the exact IN predicate. No row Environment is
/// needed; the same per-execution lookup and storage comparison rules apply.
fn in_list_aggregate_filter(
  select : Selection,
  context : Evaluation,
) -> ((StoredRow) -> Bool raise SqlError)? {
  guard OPT_IN_LIST_LOOKUP &&
    select.sources.length() == 1 &&
    select.predicate is Call("in", args) else {
    return None
  }
  let frame = context.in_lists
    .iter()
    .find_first(f => physical_equal(f.plan.arguments, args))
  guard frame is Some(frame) else { return None }
  let source = select.sources[0]
  let table = context.store.tables
    .iter()
    .find_first(t => matches_identifier(t.name, identifier(source.name)))
  guard table is Some(table) else { return None }
  let expressions = if FEATURE_ROW_VALUES {
    match frame.plan.row {
      Some(plan) => plan.fields
      None => [args[0]]
    }
  } else {
    [args[0]]
  }
  guard expressions.all(e => e is Column(_, _)) else { return None }
  let projections = expressions.map(expression => {
    expression,
    explicit_label: false,
    label: "",
  })
  guard simple_projection({ ..select, projections, }, table, source.qualifier)
    is Some(fields) else {
    return None
  }
  if FEATURE_ROW_VALUES && frame.plan.row is Some(plan) {
    return Some(fn(row) -> Bool raise SqlError {
      row_in_list_values(
        frame,
        plan,
        fields.mapi((i, field) => {
          apply_affinity(
            in_list_slot_value(field, row, context.store),
            plan.affinities[i],
          )
        }),
        context.params,
        context.store,
      ) ==
      Integer(1L)
    })
  }
  let field = fields[0]
  Some(fn(row) -> Bool raise SqlError {
    scalar_in_list_lookup(
      frame,
      in_list_slot_value(field, row, context.store),
      context.params,
      context.store,
    ) ==
    Integer(1L)
  })
}

///|
fn in_list_slot_value(
  field : RowProjection,
  row : StoredRow,
  store : Store,
) -> Value raise SqlError {
  expression_value(
    match field {
      Stored(i) => row.values[i]
      RowidValue => Integer(row.id)
      Constant(value) => value
    },
    store,
  )
}

///|
fn row_in_list_key(
  values : Array[Value],
  collations : Array[String],
) -> String? {
  let parts : Array[Json] = []
  for i, value in values {
    guard primary_part_key(value, "", collations[i]) is Some(part) else {
      return None
    }
    parts.push(part)
  }
  Some(Json::array(parts).stringify())
}

///|
fn row_in_list_equal(
  left : Array[Value],
  right : Array[Value],
  collations : Array[String],
  store : Store,
) -> Value raise SqlError {
  let mut unknown = false
  for i, value in left {
    if value is Null || right[i] is Null {
      unknown = true
      continue
    }
    if compare_stored(store, value, right[i], collations[i]) != 0 {
      return Integer(0L)
    }
  }
  if unknown {
    Null
  } else {
    Integer(1L)
  }
}

///|
fn row_in_list_lookup(
  frame : InListFrame,
  plan : PreparedRowIn,
  ctx : Evaluation,
) -> Value raise SqlError {
  let row = {
    fields: plan.fields,
    metadata: plan.metadata,
    values: Array::make(plan.fields.length(), None),
  }
  // Row-list IN evaluates every left field, then every RHS value, before
  // comparing. Keep this eager order even when a hash can decide the result.
  let left = plan.affinities.mapi((i, affinity) => {
    apply_affinity(row_value_at(row, i, ctx), affinity)
  })
  row_in_list_values(frame, plan, left, ctx.params, ctx.store)
}

///|
/// Left values have already been evaluated eagerly and normalized with the
/// prepared common affinities. The evaluator and slot visitor share this code.
fn row_in_list_values(
  frame : InListFrame,
  plan : PreparedRowIn,
  left : Array[Value],
  params : Array[Value],
  store : Store,
) -> Value raise SqlError {
  if frame.disabled {
    return row_in_values(
      left,
      row_in_list_right(plan, params, store),
      plan.collations,
      store,
    )
  }
  let lookup = match frame.lookup {
    Some(lookup) => lookup
    None => {
      let rows = row_in_list_right(plan, params, store)
      if !admit_in_rows(frame.budget, rows) {
        frame.disabled = true
        return row_in_values(left, rows, plan.collations, store)
      }
      let keys : Map[String, Bool] = Map([])
      let null_rows : Array[Array[Value]] = []
      for values in rows {
        match row_in_list_key(values, plan.collations) {
          Some(key) => keys[key] = true
          None => null_rows.push(values)
        }
      }
      let lookup = {
        keys,
        integers: Map([]),
        has_null: !null_rows.is_empty(),
        rows,
        null_rows,
      }
      frame.lookup = Some(lookup)
      lookup
    }
  }
  let candidates = match row_in_list_key(left, plan.collations) {
    Some(key) => {
      if lookup.keys.contains(key) {
        return Integer(1L)
      }
      lookup.null_rows
    }
    None => lookup.rows
  }
  // A tuple containing NULL cannot be true. A definite unequal component can
  // still make it false, so retain a residual scan for these partial tuples.
  for right in candidates {
    if row_in_list_equal(left, right, plan.collations, store) is Null {
      return Null
    }
  }
  Integer(0L)
}

///|
fn row_in_list_right(
  plan : PreparedRowIn,
  params : Array[Value],
  store : Store,
) -> Array[Array[Value]] raise SqlError {
  plan.right.map(values => {
    values.mapi((i, v) => {
      apply_affinity(
        expression_value(read_key_value(v, params), store),
        plan.affinities[i],
      )
    })
  })
}

///|
fn row_in_values(
  left : Array[Value],
  rows : Array[Array[Value]],
  collations : Array[String],
  store : Store,
) -> Value raise SqlError {
  let mut unknown = false
  for right in rows {
    match row_in_list_equal(left, right, collations, store) {
      Integer(1L) => return Integer(1L)
      Null => unknown = true
      _ => ()
    }
  }
  if unknown {
    Null
  } else {
    Integer(0L)
  }
}

// Source: in_select_lookup.mbt

///|
/// Only immutable syntax and schema metadata belong to a prepared query.
priv struct PreparedInSelect {
  expression : Expr
  left : Expr
  selection : Selection
  left_metadata : Array[RowValueMetadata]
  affinities : Array[String]
  collations : Array[String]
  row : Bool
}

///|
priv struct InSelectLookup {
  set : InListLookup
  empty : Bool
}

///|
priv struct InSelectFrame {
  plan : PreparedInSelect
  budget : InCacheBudget
  mut lookup : InSelectLookup?
  mut disabled : Bool
}

///|
fn in_select_frames(
  plans : Array[PreparedInSelect],
  budget~ : InCacheBudget = in_cache_budget(),
) -> Array[InSelectFrame] {
  plans.map(plan => { plan, budget, lookup: None, disabled: false, })
}

///|
/// Scope checking below proves no outer column is needed. Keep the first
/// supported cache deliberately free of nested queries and volatile functions.
fn in_select_local_expression(e : Expr) -> Bool {
  match e {
    Literal(_) | Parameter(_) | Column(_, _) | TruthLiteral(_) | Star(_) => true
    Unary(_, e) | Cast(e, _) | Collate(e, _) => in_select_local_expression(e)
    Binary(_, a, b) =>
      in_select_local_expression(a) && in_select_local_expression(b)
    Between(e, a, b) => [e, a, b].all(in_select_local_expression)
    Case(base, arms, other) =>
      base.map(in_select_local_expression).unwrap_or(true) &&
      arms.all(p => {
        in_select_local_expression(p.0) && in_select_local_expression(p.1)
      }) &&
      in_select_local_expression(other)
    Call(name, args) =>
      [
        "abs", "lower", "upper", "length", "typeof", "coalesce", "ifnull", "nullif",
        "iif", "if", "substr", "substring", "trim", "ltrim", "rtrim", "replace",
        "instr", "in", "hex", "round", "sign",
      ].contains(name) &&
      args.all(in_select_local_expression)
    _ => false
  }
}

///|
fn prepare_in_select(
  e : Expr,
  ctx : Evaluation,
  output : Array[PreparedInSelect],
) -> Unit raise SqlError {
  if output.length() >= 16 {
    return
  }
  match e {
    InSelect(left, select) => {
      if select.ctes.is_empty() &&
        select.compound is None &&
        select.sources.length() <= 1 &&
        select.sources.all(s => {
          ctx.store.tables.any(t => {
            matches_identifier(t.name, identifier(s.name))
          })
        }) &&
        ctx.ctes.is_empty() &&
        select.groups.is_empty() &&
        select.having is Literal(Integer(1L)) &&
        select.projections.all(p => in_select_local_expression(p.expression)) &&
        [select.predicate, select.limit, select.offset].all(
          in_select_local_expression,
        ) &&
        select.orders.all(o => in_select_local_expression(o.expression)) {
        let independent = { ..ctx.nested(), outer: [], row: [], ctes: Map([]), }
        let right = Some(selection_template(select, independent)) catch {
          _ => None
        }
        if right is Some(right) {
          let row = FEATURE_ROW_VALUES && row_value_expression(left)
          let fields = if row && left is Call("$row", fields) {
            fields
          } else {
            [left]
          }
          let lm = fields.map(e => row_field_metadata(e, ctx))
          let rm = if row { row_select_metadata(select, ctx) } else { [] }
          if fields.length() == right.length() {
            output.push({
              expression: e,
              left,
              selection: select,
              left_metadata: lm,
              row,
              affinities: lm.mapi((i, m) => {
                in_comparison_affinity(m.affinity, right[i].affinity)
              }),
              collations: if row {
                lm.mapi((i, m) => {
                  if m.explicit_collation {
                    m.collation
                  } else if rm[i].explicit_collation {
                    rm[i].collation
                  } else if m.column {
                    m.collation
                  } else {
                    rm[i].collation
                  }
                })
              } else {
                [
                  comparison_collation(
                    left,
                    select.projections[0].expression,
                    ctx,
                    right_default=Some(right[0].collation),
                  ),
                ]
              },
            })
          }
        }
      }
      prepare_in_select(left, ctx, output)
    }
    Unary(_, e) | Cast(e, _) | Collate(e, _) =>
      prepare_in_select(e, ctx, output)
    Binary(_, a, b) => {
      prepare_in_select(a, ctx, output)
      prepare_in_select(b, ctx, output)
    }
    Call(_, args) =>
      for arg in args {
        prepare_in_select(arg, ctx, output)
      }
    Between(e, a, b) =>
      for x in [e, a, b] {
        prepare_in_select(x, ctx, output)
      }
    Case(base, arms, other) => {
      if base is Some(e) {
        prepare_in_select(e, ctx, output)
      }
      for (a, b) in arms {
        prepare_in_select(a, ctx, output)
        prepare_in_select(b, ctx, output)
      }
      prepare_in_select(other, ctx, output)
    }
    _ => ()
  }
}

///|
fn in_select_lookup(
  expression : Expr,
  ctx : Evaluation,
) -> Value? raise SqlError {
  for frame in ctx.in_selects {
    if frame.disabled || !physical_equal(frame.plan.expression, expression) {
      continue
    }
    let plan = frame.plan
    let left = if FEATURE_ROW_VALUES && plan.row {
      let value = row_value(plan.left, ctx, true)
      plan.affinities.mapi((i, a) => {
        apply_affinity(row_value_at(value, i, ctx), a)
      })
    } else {
      let value = evaluate(plan.left, ctx)
      [
        apply_affinity(
          merged_comparison_value(
            plan.left,
            value,
            plan.left_metadata[0].affinity,
            ctx,
          ),
          plan.affinities[0],
        ),
      ]
    }
    return Some(in_select_values(frame, left, ctx))
  }
  None
}

///|
fn in_select_values(
  frame : InSelectFrame,
  left : Array[Value],
  ctx : Evaluation,
) -> Value raise SqlError {
  let plan = frame.plan
  let lookup = match frame.lookup {
    Some(lookup) => lookup
    None => {
      let relation = select_relation_in(plan.selection, ctx.nested(), false)
      let rows = relation.rows.map(row => {
        row.mapi((i, b) => apply_affinity(b.value, plan.affinities[i]))
      })
      if frame.disabled || !admit_in_rows(frame.budget, rows) {
        frame.disabled = true
        return if FEATURE_ROW_VALUES && plan.row {
          row_in_values(left, rows, plan.collations, ctx.store)
        } else {
          scalar_in_values(
            left[0],
            rows.map(r => r[0]),
            plan.collations[0],
            ctx.store,
          )
        }
      }
      let keys : Map[String, Bool] = Map([])
      let integers : Map[Int64, Bool] = Map([])
      let null_rows : Array[Array[Value]] = []
      let mut has_null = false
      for values in rows {
        if FEATURE_ROW_VALUES && plan.row {
          match row_in_list_key(values, plan.collations) {
            Some(key) => keys[key] = true
            None => null_rows.push(values)
          }
        } else {
          let value = values[0]
          if in_list_integer_key(value) is Some(n) {
            integers[n] = true
          } else {
            match primary_part_key(value, "", plan.collations[0]) {
              Some(key) => keys[key.stringify()] = true
              None => has_null = true
            }
          }
        }
      }
      let set = {
        keys,
        integers,
        has_null,
        rows: if FEATURE_ROW_VALUES && plan.row {
          rows
        } else {
          []
        },
        null_rows,
      }
      let lookup = { set, empty: rows.is_empty(), }
      frame.lookup = Some(lookup)
      lookup
    }
  }
  if lookup.empty {
    return Integer(0L)
  }
  let set = lookup.set
  if FEATURE_ROW_VALUES && plan.row {
    let candidates = match row_in_list_key(left, plan.collations) {
      Some(key) => {
        if set.keys.contains(key) {
          return Integer(1L)
        }
        set.null_rows
      }
      None => set.rows
    }
    return row_in_values(left, candidates, plan.collations, ctx.store)
  }
  if left[0] is Null {
    return Null
  }
  let found = match in_list_integer_key(left[0]) {
    Some(n) => set.integers.contains(n)
    None =>
      primary_part_key(left[0], "", plan.collations[0]) is Some(key) &&
      set.keys.contains(key.stringify())
  }
  return if found {
    Integer(1L)
  } else if set.has_null {
    Null
  } else {
    Integer(0L)
  }
}

///|
fn in_select_aggregate_filter(
  select : Selection,
  ctx : Evaluation,
) -> ((StoredRow) -> Bool raise SqlError)? {
  guard OPT_IN_SELECT_LOOKUP &&
    CAP_QUERY_IN_SELECT &&
    select.sources.length() == 1 &&
    select.predicate is InSelect(_, _) else {
    return None
  }
  let frame = ctx.in_selects
    .iter()
    .find_first(f => physical_equal(f.plan.expression, select.predicate))
  guard frame is Some(frame) else { return None }
  let plan = frame.plan
  let expressions = if FEATURE_ROW_VALUES &&
    plan.row &&
    plan.left is Call("$row", fields) {
    fields
  } else {
    [plan.left]
  }
  guard expressions.all(e => e is Column(_, _)) else { return None }
  let source = select.sources[0]
  let table = ctx.store.tables
    .iter()
    .find_first(t => matches_identifier(t.name, identifier(source.name)))
  guard table is Some(table) else { return None }
  let projections = expressions.map(expression => {
    expression,
    explicit_label: false,
    label: "",
  })
  guard simple_projection({ ..select, projections, }, table, source.qualifier)
    is Some(fields) else {
    return None
  }
  Some(fn(row) -> Bool raise SqlError {
    let left = fields.mapi((i, field) => {
      apply_affinity(
        in_list_slot_value(field, row, ctx.store),
        plan.affinities[i],
      )
    })
    in_select_values(frame, left, ctx) == Integer(1L)
  })
}

// Source: index_cache.mbt

///|
priv struct CachedIndex {
  table : String
  cookie : Int32
  fields : Array[IndexField]
  predicate : Expr?
  rows : IndexRows
}

///|
fn compare_index_rows(
  store : Store,
  fields : Array[IndexField],
  a : StoredRow,
  b : StoredRow,
) -> Int32 {
  for field in fields {
    let order = compare_stored(
      store,
      index_field_value(a, field),
      index_field_value(b, field),
      field.collation,
    )
    if order != 0 {
      return if field.descending { -order } else { order }
    }
  }
  a.id.compare(b.id)
}

///|
/// Locate a full index key, including rowid to distinguish equal column values.
fn index_row_bound(
  store : Store,
  rows : IndexRows,
  fields : Array[IndexField],
  row : StoredRow,
) -> Int32 {
  rows.bound(candidate => compare_index_rows(store, fields, candidate, row) < 0)
}

///|
/// Changed keys may still fit between the same neighbors, avoiding row shifts.
fn index_slot_accepts(
  store : Store,
  rows : IndexRows,
  fields : Array[IndexField],
  position : Int32,
  row : StoredRow,
) -> Bool {
  if position > 0 &&
    compare_index_rows(store, fields, rows[position - 1], row) >= 0 {
    return false
  }
  if position + 1 < rows.length() &&
    compare_index_rows(store, fields, row, rows[position + 1]) >= 0 {
    return false
  }
  true
}

///|
/// A row delta updates only indexes already built for this table. Immutable row
/// values can be shared, but these mutable arrays never cross store checkpoints.
fn update_table_indexes(
  store : Store,
  table : Table,
  previous : StoredRow?,
  next : StoredRow?,
) -> Unit {
  update_primary_index(store, table, previous, next)
  if store.indexes.length() == 0 {
    return
  }
  for (name, index) in store.indexes.to_array() {
    if index.table != table.name {
      continue
    }
    if index.cookie != store.cookie {
      ignore(store.indexes.remove(name))
      continue
    }
    let fields = index.fields
    let membership = Some(
      (
        previous
        .map(row => cached_index_member(store, table, index.predicate, row))
        .unwrap_or(false),
        next
        .map(row => cached_index_member(store, table, index.predicate, row))
        .unwrap_or(false),
      ),
    ) catch {
      _ => None
    }
    guard membership is Some((old_member, new_member)) else {
      ignore(store.indexes.remove(name))
      continue
    }
    let before = if old_member { previous } else { None }
    let after = if new_member { next } else { None }
    if before is Some(row) {
      let position = index_row_bound(store, index.rows, fields, row)
      if position == index.rows.length() ||
        compare_index_rows(store, fields, index.rows[position], row) != 0 {
        // An unprovable cache can always be reconstructed from the table.
        ignore(store.indexes.remove(name))
        continue
      }
      if after is Some(replacement) {
        if compare_index_rows(store, fields, row, replacement) == 0 ||
          index_slot_accepts(store, index.rows, fields, position, replacement) {
          // Publish every new row, even when its key or ordering is unchanged.
          index.rows[position] = replacement
          continue
        }
      }
      ignore(index.rows.remove(position))
    }
    if after is Some(row) {
      let position = index_row_bound(store, index.rows, fields, row)
      index.rows.insert(position, row)
    }
  }
}

///|
fn invalidate_table_indexes(store : Store, table : Table) -> Unit {
  ignore(store.primary_indexes.remove(table.name))
  if store.indexes.length() == 0 {
    return
  }
  for (name, index) in store.indexes.to_array() {
    if index.table == table.name {
      ignore(store.indexes.remove(name))
    }
  }
}

///|
/// Bulk replacement (DDL) invalidates indexes; ordinary DML supplies row deltas.
fn replace_table_rows(
  store : Store,
  table : Table,
  rows : Array[StoredRow],
) -> Unit {
  invalidate_table_indexes(store, table)
  dirty_snapshot(store)
  table.rows = row_pages(rows)
}

///|
fn append_table_row(store : Store, table : Table, row : StoredRow) -> Unit {
  update_table_indexes(store, table, None, Some(row))
  table.rows.push(row)
  dirty_edit(store, AppendRow(table.name, persistent_generated_row(table, row)))
}

///|
fn replace_table_row(
  store : Store,
  table : Table,
  previous : StoredRow,
  next : StoredRow,
) -> Unit {
  let slot = if FEATURE_PRIMARY_INDEX {
    primary_index(store, table).slots.get(previous.id)
  } else {
    None
  }
  let position = slot.unwrap_or_else(() => {
    for (i, row) in table.rows.slot_entries() {
      if row.id == previous.id {
        return i
      }
    }
    -1
  })
  if position < 0 {
    return
  }
  // BEFORE triggers may have changed this row: compare current storage, not
  // the caller's old row. Constraints/events/counters still run in the caller.
  if table.rows.get_slot(position) is Some(current) &&
    current.id == next.id &&
    same_stored_values(current.values, next.values) {
    return
  }
  update_table_indexes(store, table, Some(previous), Some(next))
  table.rows.set_slot(position, next)
  dirty_replace(store, table, previous, next)
}

///|
fn remove_table_row(store : Store, table : Table, row : StoredRow) -> Unit {
  let position = if FEATURE_PRIMARY_INDEX {
    primary_index(store, table).slots.get(row.id)
  } else {
    table.rows
    .slot_entries()
    .find_first(pair => pair.1.id == row.id)
    .map(pair => pair.0)
  }
  guard position is Some(position) else { return }
  update_table_indexes(store, table, Some(row), None)
  if table.rows.remove_slot(position) {
    // Stable slots survive ordinary deletes; repacking invalidates this root only.
    ignore(store.primary_indexes.remove(table.name))
  }
  dirty_edit(store, DeleteRow(table.name, row.id))
}

///|
fn schema_changed(store : Store) -> Unit {
  if FEATURE_GENERATED_COLUMNS {
    store.generated_plans.clear()
  }
  store.indexes.clear()
  store.primary_indexes.clear()
  dirty_snapshot(store)
  store.cookie += 1
}

///|
fn index_rows_for_fields(
  store : Store,
  table : Table,
  name : String,
  fields : Array[IndexField],
  predicate : Expr?,
) -> IndexRows raise SqlError {
  if store.indexes.get(name) is Some(index) &&
    index.cookie == store.cookie &&
    index.fields == fields {
    return index.rows
  }
  let rows = if predicate is None {
    table.rows.copy()
  } else {
    table.rows.filter(row => cached_index_member(store, table, predicate, row))
  }
  rows.sort_by((a, b) => compare_index_rows(store, fields, a, b))
  let rows = index_pages(rows)
  // Bound retained row references. Additional indexes can always be rebuilt.
  if store.indexes.length() >= 4 {
    store.indexes.clear()
  }
  store.indexes[name] = {
    table: table.name,
    cookie: store.cookie,
    fields,
    predicate,
    rows,
  }
  rows
}

///|
fn cached_index_member(
  store : Store,
  table : Table,
  predicate : Expr?,
  row : StoredRow,
) -> Bool raise SqlError {
  match predicate {
    None => true
    Some(e) =>
      truth(
        evaluate(
          e,
          evaluation(store, [], row_environment(table, row, table.name)),
        ),
      ) ==
      1
  }
}

///|
fn index_prefix_bound(
  store : Store,
  rows : IndexRows,
  fields : Array[IndexField],
  values : Array[Value],
  after_equal : Bool,
) -> Int32 {
  rows.bound(candidate => {
    let mut order = 0
    for i, value in values {
      let field = fields[i]
      order = compare_stored(
        store,
        index_field_value(candidate, field),
        value,
        field.collation,
      )
      if field.descending {
        order = -order
      }
      if order != 0 {
        break
      }
    }
    order < 0 || (after_equal && order == 0)
  })
}

// Source: index_definition.mbt

///|
/// Preserve byte-for-byte legacy images when no extended index metadata exists.
#derive(ToJson)
priv struct LegacySchemaObject {
  kind : String
  name : String
  table : String
  sql : String
  unique : Bool
  columns : Array[String]
  query : String
  selection : Selection?
}

///|
impl @json.ToJson for SchemaObject with fn to_json(self) {
  let legacy : LegacySchemaObject = {
    kind: self.kind,
    name: self.name,
    table: self.table,
    sql: self.sql,
    unique: self.unique,
    columns: self.columns,
    query: self.query,
    selection: self.selection,
  }
  let json = @json.to_json(legacy)
  if self.index_terms is Some(terms) && json is Object(fields) {
    fields["index_terms"] = @json.to_json(terms)
  }
  if self.index_predicate is Some(predicate) && json is Object(fields) {
    fields["index_predicate"] = @json.to_json(predicate)
  }
  if self.trigger is Some(trigger) && json is Object(fields) {
    fields["trigger"] = @json.to_json(trigger)
  }
  json
}

///|
fn index_fields(
  table : Table,
  object : SchemaObject,
) -> Array[IndexField] raise SqlError {
  index_keys(table, object).map(k => {
    guard k.column >= 0 else {
      fail("expression index has no column-only plan")
    }
    { column: k.column, collation: k.collation, descending: k.descending, }
  })
}

///|
priv struct IndexKey {
  column : Int32
  expression : Expr
  collation : String
  descending : Bool
}

///|
priv struct UniqueIndex {
  parts : Array[IndexKey]
  predicate : Expr?
}

///|
fn deterministic_index_expression(table : Table, e : Expr) -> Bool {
  match e {
    Literal(_) | TruthLiteral(_) => true
    Column("", name) =>
      table.columns.any(c => matches_identifier(c.name, identifier(name)))
    Unary(_, e) | Cast(e, _) => deterministic_index_expression(table, e)
    Collate(e, name) =>
      ["binary", "nocase", "rtrim"].contains(identifier(name)) &&
      deterministic_index_expression(table, e)
    Binary(_, a, b) =>
      deterministic_index_expression(table, a) &&
      deterministic_index_expression(table, b)
    Between(e, a, b) =>
      deterministic_index_expression(table, e) &&
      deterministic_index_expression(table, a) &&
      deterministic_index_expression(table, b)
    Case(base, arms, other) =>
      base.map(e => deterministic_index_expression(table, e)).unwrap_or(true) &&
      arms.all(p => {
        deterministic_index_expression(table, p.0) &&
        deterministic_index_expression(table, p.1)
      }) &&
      deterministic_index_expression(table, other)
    Call(name, args) =>
      [
        "abs", "typeof", "hex", "length", "lower", "upper", "ifnull", "coalesce",
        "json_extract", "substr", "substring", "instr", "replace", "trim", "ltrim",
        "rtrim", "concat", "concat_ws", "octet_length", "nullif", "iif", "if", "unicode",
        "char", "unhex", "sign", "round", "quote", "zeroblob", "in",
      ].contains(name) &&
      args.all(e => deterministic_index_expression(table, e))
    _ => false
  }
}

///|
fn index_keys(
  table : Table,
  object : SchemaObject,
) -> Array[IndexKey] raise SqlError {
  let terms = object.index_terms.unwrap_or_else(() => {
    object.columns.map(name => {
      expression: Column("", name),
      descending: false,
    })
  })
  guard !terms.is_empty() && terms.length() == object.columns.length() else {
    fail("invalid index terms")
  }
  terms.mapi((i, term) => {
    let (expression, collation) = if term.expression is Collate(e, name) {
      (e, Some(identifier(name)))
    } else {
      (term.expression, None)
    }
    guard deterministic_index_expression(table, term.expression) else {
      fail("non-deterministic or unsupported index expression")
    }
    let column = if expression is Column("", name) {
      guard identifier(name) == identifier(object.columns[i]) else {
        fail("invalid index column metadata")
      }
      column_index(table, name)
    } else {
      guard object.columns[i] == "" else {
        fail("invalid index expression metadata")
      }
      -2
    }
    let collation = collation.unwrap_or(
      if column >= 0 {
        table.columns[column].collation
      } else {
        "binary"
      },
    )
    guard ["binary", "nocase", "rtrim"].contains(collation) else {
      fail("unsupported index collation")
    }
    {
      column,
      expression: term.expression,
      collation,
      descending: term.descending,
    }
  })
}

///|
fn validate_index_definition(
  store : Store,
  table : Table,
  object : SchemaObject,
) -> Unit raise SqlError {
  let context = evaluation(
    store,
    [],
    row_environment(
      table,
      { id: 0L, values: Array::make(table.columns.length(), Null), },
      table.name,
    ),
  )
  for key in index_keys(table, object) {
    prepare_expression(key.expression, context, false, false)
  }
  if object.index_predicate is Some(e) {
    guard deterministic_index_expression(table, e) else {
      fail("non-deterministic or unsupported partial index predicate")
    }
    prepare_expression(e, context, false, false)
  }
}

///|
fn index_values(
  store : Store,
  table : Table,
  index : UniqueIndex,
  values : Array[Value],
) -> Array[Value]? raise SqlError {
  let needs_context = index.predicate is Some(_) ||
    index.parts.any(k => k.column < 0)
  let ctx = if needs_context {
    evaluation(
      store,
      [],
      row_environment(table, { id: 0L, values, }, table.name),
    )
  } else {
    evaluation(store, [], [])
  }
  if index.predicate is Some(e) && truth(evaluate(e, ctx)) != 1 {
    return None
  }
  Some(
    index.parts.map(k => {
      if k.column >= 0 {
        values[k.column]
      } else {
        evaluate(k.expression, ctx)
      }
    }),
  )
}

///|
fn object_index(
  object : SchemaObject,
  table : Table,
) -> UniqueIndex raise SqlError {
  { parts: index_keys(table, object), predicate: object.index_predicate, }
}

///|
fn find_index_conflict(
  store : Store,
  table : Table,
  index : UniqueIndex,
  values : Array[Value],
  excluded : Int64?,
) -> StoredRow? raise SqlError {
  if FEATURE_PRIMARY_INDEX &&
    index.predicate is None &&
    index.parts.length() == 1 {
    let ipk = integer_primary(table)
    if ipk >= 0 &&
      index.parts[0].column == ipk &&
      index.parts[0].collation == table.columns[ipk].collation &&
      values[ipk] is Integer(id) {
      return primary_row(primary_index(store, table), table, id).filter(row => {
        excluded != Some(row.id)
      })
    }
  }
  guard index_values(store, table, index, values) is Some(key) &&
    !key.any(v => v is Null) else {
    return None
  }
  if FEATURE_PRIMARY_INDEX &&
    index.predicate is None &&
    index.parts.map(p => p.column) == primary_key(table) &&
    index.parts.all(p => {
      p.column >= 0 && p.collation == table.columns[p.column].collation
    }) {
    if primary_value_key(table, values) is Some(key) {
      return primary_key_row(primary_index(store, table), table, key).filter(row => {
        excluded != Some(row.id)
      })
    }
  }
  for row in table.rows {
    if excluded == Some(row.id) {
      continue
    }
    if index_values(store, table, index, row.values) is Some(other) &&
      index.parts
      .mapi((i, part) => {
        compare_stored(store, key[i], other[i], part.collation) == 0
      })
      .all(v => v) {
      return Some(row)
    }
  }
  None
}

///|
fn index_field_value(row : StoredRow, field : IndexField) -> Value {
  if field.column < 0 {
    Integer(row.id)
  } else {
    row.values[field.column]
  }
}

// Source: index_metadata.mbt

///|
priv struct MetadataIndex {
  name : String
  unique : Bool
  origin : String
  partial : Bool
  fields : Array[IndexField]
}

///|
fn implicit_index_metadata(
  table : Table,
) -> Array[MetadataIndex] raise SqlError {
  let primary = primary_key(table)
  let keys = table.unique_keys.copy()
  let ipk = integer_primary(table) >= 0
  if ipk && !primary.is_empty() {
    ignore(keys.pop()) // The parser appends the PRIMARY KEY constraint last.
  }
  let distinct : Array[Array[Int32]] = []
  for key in keys {
    if !distinct.any(k => k == key) {
      distinct.push(key)
    }
  }
  // Legacy tables retain constraints but not their interleaved PK/UNIQUE order
  // or table-level PK directions. Refuse metadata that cannot be recovered.
  guard ipk ||
    primary.is_empty() ||
    (distinct.length() <= 1 && !identifier(table.sql).contains("desc")) else {
    fail(
      "unsupported implicit index metadata: rebuild with declaration metadata",
    )
  }
  distinct.mapi((i, key) => {
    name: "sqlite_autoindex_" + table.name + "_" + (i + 1).to_string(),
    unique: true,
    origin: if !ipk && key == primary {
      "pk"
    } else {
      "u"
    },
    partial: false,
    fields: key.map(column => {
      column,
      collation: table.columns[column].collation,
      descending: false,
    }),
  })
}

///|
fn explicit_index_metadata(
  table : Table,
  object : SchemaObject,
) -> MetadataIndex raise SqlError {
  {
    name: object.name,
    unique: object.unique,
    origin: "c",
    partial: object.index_predicate is Some(_),
    fields: index_keys(table, object).map(k => {
      column: k.column,
      collation: k.collation,
      descending: k.descending,
    }),
  }
}

///|
fn index_metadata_rows(
  table : Table,
  index : MetadataIndex,
  wide : Bool,
) -> Array[Environment] raise SqlError {
  let fields = index.fields.copy()
  let keys = fields.length()
  if wide {
    if table.without_rowid {
      guard !identifier(table.sql).contains("desc") else {
        fail("unsupported primary index metadata direction")
      }
      let columns = if index.origin == "pk" {
        table.columns.mapi((i, _) => i)
      } else {
        primary_key(table)
      }
      for column in columns {
        let collation = table.columns[column].collation
        if !fields.any(f => f.column == column && f.collation == collation) {
          fields.push({ column, collation, descending: false, })
        }
      }
    } else {
      fields.push({ column: -1, collation: "binary", descending: false, })
    }
  }
  fields.mapi((i, f) => {
    let row = [
      binding("seqno", Integer(i.to_int64())),
      binding("cid", Integer(f.column.to_int64())),
      binding(
        "name",
        if f.column >= 0 {
          Text(table.columns[f.column].name)
        } else {
          Null
        },
      ),
    ]
    if wide {
      row.push(binding("desc", boolean(f.descending)))
      row.push(
        binding(
          "coll",
          Text(
            match f.collation {
              "nocase" => "NOCASE"
              "rtrim" => "RTRIM"
              _ => "BINARY"
            },
          ),
        ),
      )
      row.push(binding("key", boolean(i < keys)))
    }
    row
  })
}

///|
fn index_metadata(
  store : Store,
  pragma : String,
  name : String,
) -> Array[Environment] raise SqlError {
  let lookup = identifier(name)
  if pragma == "index_list" {
    let found = store.tables.filter(t => identifier(t.name) == lookup)
    if found.is_empty() {
      return []
    }
    let table = found[0]
    let indexes : Array[MetadataIndex] = []
    for i = store.objects.length() - 1; i >= 0; i = i - 1 {
      let object = store.objects[i]
      if object.kind == "index" && identifier(object.table) == lookup {
        indexes.push(explicit_index_metadata(table, object))
      }
    }
    let implicit = implicit_index_metadata(table)
    for i = implicit.length() - 1; i >= 0; i = i - 1 {
      indexes.push(implicit[i])
    }
    return indexes.mapi((i, index) => {
      [
        binding("seq", Integer(i.to_int64())),
        binding("name", Text(index.name)),
        binding("unique", boolean(index.unique)),
        binding("origin", Text(index.origin)),
        binding("partial", boolean(index.partial)),
      ]
    })
  }
  for object in store.objects {
    if object.kind == "index" && identifier(object.name) == lookup {
      let table = get_table(store, object.table)
      return index_metadata_rows(
        table,
        explicit_index_metadata(table, object),
        pragma == "index_xinfo",
      )
    }
  }
  for table in store.tables {
    if (table.without_rowid && identifier(table.name) == lookup) ||
      lookup.has_prefix("sqlite_autoindex_" + identifier(table.name) + "_") {
      for index in implicit_index_metadata(table) {
        if identifier(index.name) == lookup ||
          (
            table.without_rowid &&
            identifier(table.name) == lookup &&
            index.origin == "pk"
          ) {
          return index_metadata_rows(table, index, pragma == "index_xinfo")
        }
      }
    }
  }
  []
}

// Source: index_pages.mbt

///|
/// Mutable derived cache, never serialized or shared across store checkpoints.
/// Small indexes keep one flat array; large ordered caches use bounded leaves.
priv struct IndexRows {
  blocks : Array[Array[StoredRow]]
  ends : Array[Int32]
  mut count : Int32
  allow_pages : Bool
}

///|
fn index_pages(rows : Array[StoredRow], pages~ : Bool = true) -> IndexRows {
  let result = {
    blocks: [],
    ends: [],
    count: rows.length(),
    allow_pages: pages,
  }
  if pages && rows.length() > 8192 {
    let mut start = 0
    while start < rows.length() {
      let end = (start + 128).min(rows.length())
      result.blocks.push(rows[start:end].to_owned())
      result.ends.push(end)
      start = end
    }
  } else if !rows.is_empty() {
    result.blocks.push(rows)
    result.ends.push(rows.length())
  }
  result
}

///|
fn IndexRows::length(self : IndexRows) -> Int32 {
  self.count
}

///|
fn IndexRows::bound(self : IndexRows, before : (StoredRow) -> Bool) -> Int32 {
  if self.count == 0 {
    return 0
  }
  let mut low = 0
  let mut high = self.blocks.length()
  while low < high {
    let mid = low + (high - low) / 2
    let block = self.blocks[mid]
    if before(block[block.length() - 1]) {
      low = mid + 1
    } else {
      high = mid
    }
  }
  if low == self.blocks.length() {
    return self.count
  }
  let page = low
  let block = self.blocks[page]
  low = 0
  high = block.length()
  while low < high {
    let mid = low + (high - low) / 2
    if before(block[mid]) {
      low = mid + 1
    } else {
      high = mid
    }
  }
  (if page == 0 { 0 } else { self.ends[page - 1] }) + low
}

///|
fn IndexRows::block_at(self : IndexRows, position : Int32) -> Int32 {
  if self.blocks.length() == 1 {
    return 0
  }
  let mut low = 0
  let mut high = self.ends.length()
  while low < high {
    let mid = low + (high - low) / 2
    if self.ends[mid] <= position {
      low = mid + 1
    } else {
      high = mid
    }
  }
  low.min(self.blocks.length() - 1)
}

///|
#alias("_[_]")
fn IndexRows::at(self : IndexRows, position : Int32) -> StoredRow {
  let block = self.block_at(position)
  self.blocks[block][position -
  (if block == 0 { 0 } else { self.ends[block - 1] })]
}

///|
#alias("_[_]=_")
fn IndexRows::set(self : IndexRows, position : Int32, row : StoredRow) -> Unit {
  let block = self.block_at(position)
  self.blocks[block][position -
  (if block == 0 { 0 } else { self.ends[block - 1] })] = row
}

///|
fn IndexRows::insert(
  self : IndexRows,
  position : Int32,
  row : StoredRow,
) -> Unit {
  if self.blocks.is_empty() {
    self.blocks.push([row])
    self.ends.push(1)
    self.count = 1
    return
  }
  let block = self.block_at(position)
  self.blocks[block].insert(
    position - (if block == 0 { 0 } else { self.ends[block - 1] }),
    row,
  )
  self.count += 1
  for i in block..<self.ends.length() {
    self.ends[i] += 1
  }
  if !self.allow_pages {
    return
  }
  if self.blocks.length() == 1 {
    if self.count > 8192 {
      let promoted = index_pages(self.blocks[0])
      self.blocks.clear()
      self.ends.clear()
      for i, page in promoted.blocks {
        self.blocks.push(page)
        self.ends.push(promoted.ends[i])
      }
    }
  } else if self.blocks[block].length() > 256 {
    let old = self.blocks[block]
    let end = self.ends[block]
    self.blocks[block] = old[:128].to_owned()
    self.blocks.insert(block + 1, old[128:].to_owned())
    self.ends[block] = end - (old.length() - 128)
    self.ends.insert(block + 1, end)
  }
}

///|
fn IndexRows::remove(self : IndexRows, position : Int32) -> StoredRow {
  let block = self.block_at(position)
  let page = self.blocks[block]
  let row = page.remove(
    position - (if block == 0 { 0 } else { self.ends[block - 1] }),
  )
  self.count -= 1
  for i in block..<self.ends.length() {
    self.ends[i] -= 1
  }
  if self.count == 0 {
    self.blocks.clear()
    self.ends.clear()
    self.blocks.shrink_to_fit()
    self.ends.shrink_to_fit()
  } else if page.is_empty() {
    ignore(self.blocks.remove(block))
    ignore(self.ends.remove(block))
    self.blocks.shrink_to_fit()
  } else if self.blocks.length() > 1 && page.length() < 64 {
    let left = if block + 1 < self.blocks.length() { block } else { block - 1 }
    if self.blocks[left].length() + self.blocks[left + 1].length() <= 256 {
      self.blocks[left] = self.blocks[left] + self.blocks[left + 1]
      self.ends[left] = self.ends[left + 1]
      ignore(self.blocks.remove(left + 1))
      ignore(self.ends.remove(left + 1))
      // Release removed leaf references on Wasm as well as JS.
      self.blocks.shrink_to_fit()
    }
  } else if page.length() * 4 < page.capacity() {
    page.shrink_to_fit()
  }
  row
}

// Source: index_plan.mbt

///|
priv struct IndexConstraint {
  column : Int32
  collation : String
  op : String
  value : Value
}

///|
priv struct IndexRange {
  rows : IndexRows
  start : Int32
  end : Int32
  reverse : Bool
  residual : Bool
}

///|
fn index_column(table : Table, expression : Expr, qualifier : String) -> Int32? {
  if expression is Collate(e, _) {
    return index_column(table, e, qualifier)
  }
  guard expression is Column(q, name) &&
    (q == "" || matches_identifier(q, identifier(qualifier))) else {
    return None
  }
  let key = identifier(name)
  for i, column in table.columns {
    if matches_identifier(column.name, key) {
      return Some(i)
    }
  }
  if !table.without_rowid && ["rowid", "_rowid_", "oid"].contains(key) {
    Some(-1)
  } else {
    None
  }
}

///|
fn same_index_column(table : Table, a : Int32, b : Int32) -> Bool {
  a == b ||
  (
    integer_primary(table) >= 0 &&
    (
      (a == -1 && b == integer_primary(table)) ||
      (b == -1 && a == integer_primary(table))
    )
  )
}

///|
fn index_collation(table : Table, expression : Expr, column : Int32) -> String {
  if expression is Collate(_, name) {
    identifier(name)
  } else if column < 0 {
    "binary"
  } else {
    table.columns[column].collation
  }
}

///|
/// ORDER BY resolves output aliases, preserving * expansion priority.
fn index_order_term(
  select : Selection,
  table : Table,
  qualifier : String,
  order : Ordering,
) -> IndexField? {
  let mut expression = order.expression
  let explicit = if expression is Collate(inner, name) {
    expression = inner
    Some(name)
  } else {
    None
  }
  if expression is Column("", name) {
    let key = identifier(name)
    for projection in select.projections {
      if projection.expression is Star(_) {
        let found = table.columns.filter(c => matches_identifier(c.name, key))
        if !found.is_empty() {
          expression = Column(qualifier, found[0].name)
          break
        }
      }
      if matches_identifier(projection.label, key) {
        expression = projection.expression
        break
      }
    }
  }
  guard index_column(table, expression, qualifier) is Some(column) else {
    return None
  }
  Some({
    column,
    collation: explicit
    .map(identifier)
    .unwrap_or(index_collation(table, expression, column)),
    descending: order.descending,
  })
}

///|
fn index_value(expression : Expr, params : Array[Value]) -> Value? {
  match expression {
    Literal(value) => Some(value)
    Parameter(i) =>
      if i >= 0 && i < params.length() {
        Some(params[i])
      } else {
        None
      }
    _ => None
  }
}

///|
/// Only simple AND comparisons are extracted. Other predicates use the evaluator.
fn index_constraints(
  expression : Expr,
  table : Table,
  qualifier : String,
  params : Array[Value],
  constraints : Array[IndexConstraint],
) -> Bool {
  if expression is Literal(Integer(1L)) {
    return true
  }
  guard expression is Binary(op, left, right) else { return false }
  if op == "and" {
    return index_constraints(left, table, qualifier, params, constraints) &&
      index_constraints(right, table, qualifier, params, constraints)
  }
  guard ["=", "==", ">", ">=", "<", "<="].contains(op) else { return false }
  if FEATURE_ROW_VALUES && left is Call("$row", a) && right is Call("$row", b) {
    return row_index_constraints(
      op, a, b, table, qualifier, params, constraints,
    )
  }
  let (column, collation, operator, bound) = if index_column(
      table, left, qualifier,
    )
    is Some(column) {
    (
      column,
      if right is Collate(_, name) {
        identifier(name)
      } else {
        index_collation(table, left, column)
      },
      op,
      index_value(right, params),
    )
  } else if index_column(table, right, qualifier) is Some(column) {
    (
      column,
      if left is Collate(_, name) {
        identifier(name)
      } else {
        index_collation(table, right, column)
      },
      match op {
        ">" => "<"
        ">=" => "<="
        "<" => ">"
        "<=" => ">="
        _ => op
      },
      index_value(left, params),
    )
  } else {
    return false
  }
  guard bound is Some(value) else { return false }
  let affinity = if column < 0 {
    "integer"
  } else {
    affinity_name(table.columns[column].declared)
  }
  let value = if ["integer", "numeric", "real"].contains(affinity) {
    apply_affinity(value, "numeric")
  } else if affinity == "text" {
    apply_affinity(value, "text")
  } else {
    value
  }
  constraints.push({ column, collation, op: operator, value, })
  true
}

///|
fn field_constraints(
  table : Table,
  field : IndexField,
  constraints : Array[IndexConstraint],
) -> Array[IndexConstraint] {
  constraints.filter(c => {
    same_index_column(table, field.column, c.column) &&
    field.collation == c.collation
  })
}

///|
fn field_fixed(
  table : Table,
  field : IndexField,
  constraints : Array[IndexConstraint],
) -> Bool {
  field_constraints(table, field, constraints).any(c => {
    c.op == "=" || c.op == "=="
  })
}

///|
fn index_order_matches(
  table : Table,
  fields : Array[IndexField],
  orders : Array[IndexField],
  constraints : Array[IndexConstraint],
  reverse : Bool,
) -> Bool {
  let keys = fields + [{ column: -1, collation: "binary", descending: false, }]
  let mut position = 0
  for order in orders {
    // An equality-constrained column is constant in the filtered result.
    if field_fixed(table, order, constraints) {
      continue
    }
    while position < keys.length() &&
          field_fixed(table, keys[position], constraints) {
      position += 1
    }
    guard position < keys.length() else { return false }
    let field = keys[position]
    guard same_index_column(table, field.column, order.column) &&
      field.collation == order.collation &&
      (field.descending != reverse) == order.descending else {
      return false
    }
    position += 1
  }
  true
}

///|
fn secondary_range(
  select : Selection,
  context : Evaluation,
  table : Table,
  qualifier : String,
) -> IndexRange? raise SqlError {
  guard OPT_SECONDARY_RANGE && !select.orders.is_empty() else { return None }
  let orders : Array[IndexField] = []
  for order in select.orders {
    guard index_order_term(select, table, qualifier, order) is Some(term) else {
      return None
    }
    orders.push(term)
  }
  let constraints : Array[IndexConstraint] = []
  guard index_constraints(
    select.predicate,
    table,
    qualifier,
    context.params,
    constraints,
  ) else {
    return None
  }
  for object in context.store.objects {
    if object.kind != "index" ||
      !matches_identifier(object.table, identifier(table.name)) ||
      object.columns.any(n => n == "") {
      continue
    }
    if object.index_predicate is Some(predicate) &&
      !index_predicate_implied(predicate, select.predicate) {
      continue
    }
    let fields = index_fields(table, object)
    let reverse = if index_order_matches(
        table, fields, orders, constraints, false,
      ) {
      false
    } else if index_order_matches(table, fields, orders, constraints, true) {
      true
    } else {
      continue
    }
    if constraints.any(c => c.value is Null) {
      return Some({
        rows: index_pages([]),
        start: 0,
        end: 0,
        reverse,
        residual: false,
      })
    }
    let rows = index_rows_for_fields(
      context.store,
      table,
      object.name,
      fields,
      object.index_predicate,
    )
    let prefix : Array[Value] = []
    let mut start = 0
    let mut end = rows.length()
    for field in fields {
      let bounds = field_constraints(table, field, constraints)
      if bounds.is_empty() {
        break
      }
      // NULL is sorted, but never satisfies an ordinary comparison.
      if field.descending {
        end = end.min(
          index_prefix_bound(
            context.store,
            rows,
            fields,
            prefix + [Null],
            false,
          ),
        )
      } else {
        start = start.max(
          index_prefix_bound(context.store, rows, fields, prefix + [Null], true),
        )
      }
      for c in bounds {
        let lower = c.op == ">" || c.op == ">=" || c.op == "=" || c.op == "=="
        let upper = c.op == "<" || c.op == "<=" || c.op == "=" || c.op == "=="
        if lower {
          let n = index_prefix_bound(
            context.store,
            rows,
            fields,
            prefix + [c.value],
            if field.descending {
              c.op != ">"
            } else {
              c.op == ">"
            },
          )
          if field.descending {
            end = end.min(n)
          } else {
            start = start.max(n)
          }
        }
        if upper {
          let n = index_prefix_bound(
            context.store,
            rows,
            fields,
            prefix + [c.value],
            if field.descending {
              c.op == "<"
            } else {
              c.op != "<"
            },
          )
          if field.descending {
            start = start.max(n)
          } else {
            end = end.min(n)
          }
        }
      }
      let equal = bounds.filter(c => c.op == "=" || c.op == "==")
      if equal.is_empty() {
        break
      }
      prefix.push(equal[0].value)
    }
    if FEATURE_ROW_VALUES {
      let bounds = row_seek_bounds(
        select.predicate,
        context.store,
        table,
        qualifier,
        context.params,
        fields,
        rows,
        prefix,
        start,
        end,
      )
      start = bounds.0
      end = bounds.1
    }
    let residual = (
        FEATURE_ROW_VALUES && row_constraint_expression(select.predicate)
      ) ||
      fields.length() != 1 ||
      constraints.any(c => {
        !same_index_column(table, c.column, fields[0].column) ||
        c.collation != fields[0].collation
      })
    return Some({ rows, start, end: end.max(start), reverse, residual, })
  }
  None
}

///|
/// Deliberately conservative implication: identical conjuncts only.
fn index_predicate_implied(required : Expr, predicate : Expr) -> Bool {
  if required is Binary("and", a, b) {
    return index_predicate_implied(a, predicate) &&
      index_predicate_implied(b, predicate)
  }
  if @json.to_json(required) == @json.to_json(predicate) {
    return true
  }
  if predicate is Binary("and", a, b) {
    return index_predicate_implied(required, a) ||
      index_predicate_implied(required, b)
  }
  false
}

// Source: interface.mbt

///|
/// The typed statement surface follows moonbit-community/sqlite3.mbt. Execution
/// is an injected prepared action so the browser AOT entry cannot pull in lex().
#derive(Eq)
pub(all) enum ErrorCode {
  Error
  Busy
  ReadOnly
  Corrupt
  Constraint
  Mismatch
  Misuse
  Range
  CantOpen
  Unknown(Int32)
}

///|
#derive(Eq)
pub(all) enum ExtendedCode {
  ConstraintCheck
  ConstraintForeignKey
  ConstraintNotNull
  ConstraintPrimaryKey
  ConstraintUnique
  ConstraintTrigger
  ConstraintDatatype
  Unknown(Int32)
}

///|
pub suberror SqliteError {
  SqliteError(code~ : ErrorCode, extended~ : ExtendedCode?, msg~ : String)
}

///|
fn sqlite_misuse(message : String) -> SqliteError {
  SqliteError(code=Misuse, extended=None, msg=message)
}

///|
fn interface_error(message : String) -> SqliteError {
  let extended = if message.contains("UNIQUE constraint") {
    Some(ExtendedCode::ConstraintUnique)
  } else if message.contains("NOT NULL constraint") {
    Some(ExtendedCode::ConstraintNotNull)
  } else if message.contains("CHECK constraint") {
    Some(ExtendedCode::ConstraintCheck)
  } else if message.contains("datatype constraint") {
    Some(ExtendedCode::ConstraintDatatype)
  } else if message.contains("FOREIGN KEY constraint") {
    Some(ExtendedCode::ConstraintForeignKey)
  } else {
    None
  }
  SqliteError(
    code=if extended is Some(_) { Constraint } else { Error },
    extended~,
    msg=message,
  )
}

///|
struct Connection {
  database : Database
  program : Program?
  mut closed : Bool
  mut statements : Int32
}

///|
fn Connection::healthy(self : Connection) -> Unit raise SqliteError {
  guard !self.closed else { raise sqlite_misuse("connection is closed") }
}

///|
/// File/IndexedDB ownership belongs to the host adapter. The portable MoonBit
/// constructor creates a memory connection; AOT adds a program-based constructor.
pub fn Connection::open(filename : String) -> Connection raise SqliteError {
  guard filename == ":memory:" else {
    raise SqliteError(
      code=CantOpen,
      extended=None,
      msg="portable connection requires :memory:",
    )
  }
  { database: database_open(), program: None, closed: false, statements: 0, }
}

///|
pub fn Connection::changes(self : Connection) -> Int64 raise SqliteError {
  self.healthy()
  connection_changes(self.database.store).to_int64()
}

///|
pub fn Connection::close(self : Connection) -> Unit raise SqliteError {
  if self.closed {
    return
  }
  guard self.statements == 0 else {
    raise SqliteError(
      code=Busy,
      extended=None,
      msg="connection has live statements",
    )
  }
  self.closed = true
}

///|
struct Statement {
  connection : Connection
  action : (Array[Value]) -> Array[Environment] raise SqlError
  parameters : Array[Value]
  names : Array[String]
  read_only : Bool
  tracks_changes : Bool
  mut rows : Array[Environment]
  mut cursor : Int32
  mut phase : Int32
  mut last_error : SqliteError?
}

///|
fn statement_new(
  connection : Connection,
  parameters : Int32,
  names : Array[String],
  read_only : Bool,
  action : (Array[Value]) -> Array[Environment] raise SqlError,
  tracks_changes~ : Bool = false,
) -> Statement {
  connection.statements += 1
  {
    connection,
    action,
    parameters: Array::make(parameters, Null),
    names,
    read_only,
    tracks_changes,
    rows: [],
    cursor: -1,
    phase: 0,
    last_error: None,
  }
}

///|
fn Statement::healthy(self : Statement) -> Unit raise SqliteError {
  self.connection.healthy()
  guard self.phase != 4 else { raise sqlite_misuse("statement is finalized") }
}

///|
fn Statement::value(self : Statement, index : Int32) -> Value raise SqliteError {
  self.healthy()
  guard self.phase == 1 else {
    raise sqlite_misuse("statement has no current row")
  }
  guard index >= 0 && index < self.names.length() else {
    raise sqlite_misuse("column index out of range")
  }
  let mut visible = 0
  for binding in self.rows[self.cursor] {
    if !binding.hidden {
      if visible == index {
        return binding.value
      }
      visible += 1
    }
  }
  raise sqlite_misuse("result column metadata mismatch")
}

///|
pub fn Statement::column_count(self : Statement) -> Int32 raise SqliteError {
  self.healthy()
  self.names.length()
}

///|
pub fn Statement::column_name(
  self : Statement,
  index~ : Int32,
) -> String raise SqliteError {
  self.healthy()
  guard index >= 0 && index < self.names.length() else {
    raise sqlite_misuse("column index out of range")
  }
  self.names[index]
}

///|
/// Bindings are one-based, result columns zero-based, as in SQLite.
trait Bind {
  fn bind(Statement, Int32, Self) -> Unit raise SqliteError
}

///|
trait Column {
  fn column(Statement, Int32) -> Self raise SqliteError
}

///|
pub fn[T : Bind] Statement::bind(
  self : Statement,
  index~ : Int32,
  value : T,
) -> Unit raise SqliteError {
  self.healthy()
  guard self.phase == 0 else {
    raise sqlite_misuse("reset before rebinding an executed statement")
  }
  guard index >= 1 && index <= self.parameters.length() else {
    raise SqliteError(
      code=Range,
      extended=None,
      msg="binding index out of range",
    )
  }
  T::bind(self, index, value)
}

///|
pub fn[T : Column] Statement::column(
  self : Statement,
  index~ : Int32,
) -> T raise SqliteError {
  self.healthy()
  T::column(self, index)
}

///|
pub fn Statement::reset(
  self : Statement,
  clear_bindings~ : Bool = false,
) -> Unit raise SqliteError {
  self.healthy()
  let previous = self.last_error
  self.phase = 0
  self.rows = []
  self.cursor = -1
  self.last_error = None
  if clear_bindings {
    for i in 0..<self.parameters.length() {
      self.parameters[i] = Null
    }
  }
  if previous is Some(error) {
    raise error
  }
}

///|
pub fn Statement::step(self : Statement) -> Bool raise SqliteError {
  self.healthy()
  if self.phase == 2 || self.phase == 3 {
    self.phase = 0
    self.rows = []
    self.cursor = -1
    self.last_error = None
  }
  if self.phase == 0 {
    let backup = if self.read_only {
      None
    } else {
      Some(copy_store(self.connection.database.store))
    }
    try {
      let cookie = self.connection.database.store.cookie
      self.rows = (self.action)(self.parameters)
      if !self.read_only {
        self.connection.database.serial += 1
        if self.connection.database.store.cookie != cookie {
          self.connection.database.schema_epoch += 1L
        }
      }
    } catch {
      cause => {
        if backup is Some(store) {
          if self.tracks_changes {
            store.last_rowid = self.connection.database.store.last_rowid
          }
          self.connection.database.store = store
        }
        if self.tracks_changes {
          self.connection.database.store.triggers.failed_statement = true
        }
        let error = match cause {
          TriggerAbort(message) =>
            SqliteError(
              code=Constraint,
              extended=Some(ConstraintTrigger),
              msg=message,
            )
          _ => interface_error(public_error(cause))
        }
        self.last_error = Some(error)
        self.phase = 3
        raise error
      }
    }
  }
  self.cursor += 1
  if self.cursor >= self.rows.length() {
    self.phase = 2
    false
  } else {
    self.phase = 1
    true
  }
}

///|
pub fn Statement::finalize(self : Statement) -> Unit raise SqliteError {
  if self.phase == 4 {
    return
  }
  self.healthy()
  self.phase = 4
  self.rows = []
  self.connection.statements -= 1
  if self.last_error is Some(error) {
    self.last_error = None
    raise error
  }
}

///|
fn Statement::set_binding(
  statement : Statement,
  index : Int32,
  value : Value,
) -> Unit raise SqliteError {
  statement.healthy()
  guard statement.phase == 0 else {
    raise sqlite_misuse("reset before rebinding an executed statement")
  }
  guard index >= 1 && index <= statement.parameters.length() else {
    raise SqliteError(
      code=Range,
      extended=None,
      msg="binding index out of range",
    )
  }
  statement.parameters[index - 1] = match value {
    Blob(bytes) => Blob(Bytes::from_array(bytes.to_array()))
    Real(n) => if n.is_nan() { Null } else { Real(n) }
    _ => value
  }
}

///|
pub impl Bind for Value with fn bind(statement, index, value) {
  statement.set_binding(index, value)
}

///|
pub impl Bind for Int32 with fn bind(statement, index, value) {
  statement.set_binding(index, Integer(value.to_int64()))
}

///|
pub impl Bind for Int64 with fn bind(statement, index, value) {
  statement.set_binding(index, Integer(value))
}

///|
pub impl Bind for Double with fn bind(statement, index, value) {
  statement.set_binding(index, Real(value))
}

///|
pub impl Bind for String with fn bind(statement, index, value) {
  statement.set_binding(index, Text(value))
}

///|
pub impl Bind for Bytes with fn bind(statement, index, value) {
  statement.set_binding(index, Blob(value))
}

///|
pub impl Bind for StringView with fn bind(statement, index, value) {
  statement.set_binding(index, Text(value.to_owned()))
}

///|
pub impl Bind for BytesView with fn bind(statement, index, value) {
  statement.set_binding(index, Blob(value.to_owned()))
}

///|
pub impl Column for Value with fn column(statement, index) {
  match statement.value(index) {
    Blob(bytes) => Blob(Bytes::from_array(bytes.to_array()))
    value => value
  }
}

///|
pub impl Column for Int64 with fn column(statement, index) {
  integer_value(statement.value(index))
}

///|
pub impl Column for Double with fn column(statement, index) {
  as_double(statement.value(index))
}

///|
pub impl Column for String with fn column(statement, index) {
  let value = statement.value(index)
  if value is Blob(_) &&
    statement.connection.database.store.encoding.unwrap_or(1) != 1 {
    raise interface_error("unsupported SQL: BLOB conversion in UTF-16 database")
  }
  checked_text_value(value) catch {
    e => raise interface_error(public_error(e))
  }
}

///|
pub impl Column for Bytes with fn column(statement, index) {
  match statement.value(index) {
    Blob(bytes) => Bytes::from_array(bytes.to_array())
    value => @utf8.encode(text_value(value))
  }
}

///|
/// Hosts inject one UTC instant before stepping statements that use the clock.
pub fn Connection::set_clock(
  self : Connection,
  milliseconds : Int64,
) -> Unit raise SqliteError {
  self.healthy()
  self.database.store.triggers.clock = Some(milliseconds)
}

// Source: interface_compiler.mbt

///|
/// SQL text entry point for development/build tools. The AOT runtime constructs
/// the same Statement through statement_new without retaining this function.
pub fn Connection::prepare(
  self : Connection,
  sql : String,
) -> Statement raise SqliteError {
  self.healthy()
  guard self.program is None else {
    raise sqlite_misuse("compiled connections require prepare_compiled")
  }
  try {
    let parser = lex(sql)
    let statement = parse_statement(parser)
    let params = Array::make(parser.parameter, Value::Null)
    let names = match statement {
      Select(select) =>
        selection_template(select, evaluation(self.database.store, params, [])).map(b => {
            b.name
          },
        )
      Insert(insertion) =>
        project_template(
          insertion.returning,
          evaluation(
            self.database.store,
            params,
            row_environment(
              get_table(self.database.store, insertion.table),
              {
                id: 0L,
                values: Array::make(
                  get_table(self.database.store, insertion.table).columns.length(),
                  Null,
                ),
              },
              insertion.table,
            ),
          ),
        ).map(b => b.name)
      Update(name, _, _, returning) | Delete(name, _, returning) => {
        let table = get_table(self.database.store, name)
        project_template(
          returning,
          evaluation(
            self.database.store,
            params,
            row_environment(
              table,
              { id: 0L, values: Array::make(table.columns.length(), Null), },
              name,
            ),
          ),
        ).map(b => b.name)
      }
      Pragma(name, table, None) => {
        let result = execute_pragma(
          self.database.store,
          name,
          table,
          None,
          params,
        )
        if result.is_empty() {
          []
        } else {
          result[0].filter(b => !b.hidden).map(b => b.name)
        }
      }
      _ => []
    }
    let read_only = match statement {
      Select(_) | Pragma(_, _, None) => true
      _ => false
    }
    statement_new(
      self,
      parser.parameter,
      names,
      read_only,
      parameters => {
        execute_statement(self.database.store, statement, parameters)
      },
      tracks_changes=statement is Insert(_) ||
        statement is Update(_, _, _, _) ||
        statement is Delete(_, _, _),
    )
  } catch {
    error => raise interface_error(public_error(error))
  }
}

// Source: join.mbt

///|
fn unqualified_binding(b : Binding) -> Binding? {
  if !FEATURE_OUTER_JOIN {
    return Some(b)
  }
  match b.join_column {
    Some(SuppressedJoinColumn) => None
    Some(MergedJoinColumn(value, affinity, collation)) =>
      Some({ ..b, value, affinity, collation, })
    None => Some(b)
  }
}

///|
fn merged_comparison_value(
  e : Expr,
  value : Value,
  affinity : String,
  ctx : Evaluation,
) -> Value raise SqlError {
  if !FEATURE_OUTER_JOIN {
    return value
  }
  if e is Column("", name) &&
    find_context(ctx, "", name) is Some(b) &&
    b.join_column is Some(MergedJoinColumn(_, _, _)) {
    apply_affinity(value, affinity)
  } else {
    value
  }
}

///|
fn using_pairs(
  source : Source,
  left : Environment,
  right : Environment,
) -> Array[(Int32, Int32)] raise SqlError {
  if source.using_columns is None && source.natural != Some(true) {
    return []
  }
  guard FEATURE_OUTER_JOIN else {
    fail("feature disabled: rightFullJoin (USING/NATURAL)")
  }
  let names = source.using_columns.unwrap_or_else(() => {
    left
    .filter(b => {
      !b.hidden &&
      !(b.join_column is Some(SuppressedJoinColumn)) &&
      right.any(r => !r.hidden && identifier(r.name) == identifier(b.name))
    })
    .map(b => b.name)
  })
  let pairs : Array[(Int32, Int32)] = []
  for name in names {
    ignore(find_binding(left, "", name))
    let li = left
      .mapi((i, b) => (i, b))
      .filter(p => {
        !p.1.hidden &&
        !(p.1.join_column is Some(SuppressedJoinColumn)) &&
        identifier(p.1.name) == identifier(name)
      })
    let ri = right
      .mapi((i, b) => (i, b))
      .filter(p => !p.1.hidden && identifier(p.1.name) == identifier(name))
    guard li.length() == 1 &&
      ri.length() == 1 &&
      !pairs.any(p => p.0 == li[0].0) else {
      fail("cannot join using column: " + name)
    }
    pairs.push((li[0].0, ri[0].0))
  }
  pairs
}

///|
fn using_matches(
  left : Environment,
  right : Environment,
  pairs : Array[(Int32, Int32)],
  ctx : Evaluation,
) -> Bool raise SqlError {
  if !FEATURE_OUTER_JOIN {
    return true
  }
  for (li, ri) in pairs {
    let a = unqualified_binding(left[li]).unwrap()
    let b = right[ri]
    let row = [
      { ..a, name: "__l", qualifier: "", join_column: None, },
      { ..b, name: "__r", qualifier: "", join_column: None, },
    ]
    if truth(
        compare_expression(
          "=",
          Column("", "__l"),
          a.value,
          Column("", "__r"),
          b.value,
          { ..ctx, row, },
        ),
      ) !=
      1 {
      return false
    }
  }
  true
}

///|
fn using_row(
  source : Source,
  left : Environment,
  right : Environment,
  pairs : Array[(Int32, Int32)],
) -> Environment {
  let result = left + right
  if !FEATURE_OUTER_JOIN {
    return result
  }
  for (li, ri) in pairs {
    let a = unqualified_binding(left[li]).unwrap()
    let b = right[ri]
    let value = if source.right == Some(true) && !source.left {
      b.value
    } else if source.right == Some(true) && a.value is Null {
      b.value
    } else {
      a.value
    }
    let metadata = if source.right == Some(true) && !source.left {
      b
    } else {
      a
    }
    result[li] = {
      ..left[li],
      join_column: Some(
        MergedJoinColumn(value, metadata.affinity, metadata.collation),
      ),
    }
    result[left.length() + ri] = {
      ..b,
      join_column: Some(SuppressedJoinColumn),
    }
  }
  result
}

// Source: json_aggregate.mbt

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

///|
fn ordered_json_aggregate(
  name : String,
  expressions : Array[Expr],
  entries : Array[OrderedAggregateEntry],
  ctx : Evaluation,
) -> Value raise SqlError {
  let array : Array[SqlJson] = []
  let object : Array[(String, SqlJson)] = []
  for entry in entries {
    let here = { ..ctx, row: entry.row, group: None, }
    if name == "json_group_array" {
      array.push(json_argument(entry.values[0], expressions[0], here))
    } else {
      let label = entry.values[0]
      guard !(label is Null) else {
        fail("unsupported JSON aggregate NULL label")
      }
      guard !(label is Blob(_)) || ctx.store.encoding.unwrap_or(1) == 1 else {
        fail("unsupported JSON aggregate BLOB label encoding")
      }
      object.push(
        (
          checked_text_value(label),
          json_argument(entry.values[1], expressions[1], here),
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

// Source: json_decode_generated.mbt
// Generated by scripts/generate-binary-codecs.ts.
// Contract SHA256: f3e811d415bf6e48620b30d666547b023504647406200f3b8e0f9abbe367dd96
// Capability SHA256: 29619c2e072435a6815a66a53f186049bab9599699b36935570352fe81d0b0be

///|
impl @json.FromJson for Expr with fn from_json(json, path) {
  match json {
    Array([String("Literal"), v0]) => {
      let x0 : Value = @json.from_json(v0, path=path.add_index(1))
      Literal(x0)
    }
    Array([String("TruthLiteral"), v0]) => {
      let x0 : Bool = @json.from_json(v0, path=path.add_index(1))
      TruthLiteral(x0)
    }
    Array([String("CurrentTime"), v0]) => {
      guard FEATURE_DATETIME else {
        raise path.error("feature disabled: dateTime")
      }
      let x0 : String = @json.from_json(v0, path=path.add_index(1))
      CurrentTime(x0)
    }
    Array([String("Parameter"), v0]) => {
      let x0 : Int32 = @json.from_json(v0, path=path.add_index(1))
      Parameter(x0)
    }
    Array([String("Column"), v0, v1]) => {
      let x0 : String = @json.from_json(v0, path=path.add_index(1))
      let x1 : String = @json.from_json(v1, path=path.add_index(2))
      Column(x0, x1)
    }
    Array([String("Star"), v0]) => {
      let x0 : String = @json.from_json(v0, path=path.add_index(1))
      Star(x0)
    }
    Array([String("Unary"), v0, v1]) => {
      let x0 : String = @json.from_json(v0, path=path.add_index(1))
      let x1 : Expr = @json.from_json(v1, path=path.add_index(2))
      Unary(x0, x1)
    }
    Array([String("Binary"), v0, v1, v2]) => {
      let x0 : String = @json.from_json(v0, path=path.add_index(1))
      let x1 : Expr = @json.from_json(v1, path=path.add_index(2))
      let x2 : Expr = @json.from_json(v2, path=path.add_index(3))
      Binary(x0, x1, x2)
    }
    Array([String("Call"), v0, v1]) => {
      guard CAP_EXPRESSION_CALL else {
        raise path.error("catalog capability disabled: expression call")
      }

      let x0 : String = @json.from_json(v0, path=path.add_index(1))
      let x1 : Array[Expr] = @json.from_json(v1, path=path.add_index(2))
      Call(x0, x1)
    }
    Array([String("Collate"), v0, v1]) => {
      let x0 : Expr = @json.from_json(v0, path=path.add_index(1))
      let x1 : String = @json.from_json(v1, path=path.add_index(2))
      Collate(x0, x1)
    }
    Array([String("Cast"), v0, v1]) => {
      guard CAP_EXPRESSION_CAST else {
        raise path.error("catalog capability disabled: expression cast")
      }

      let x0 : Expr = @json.from_json(v0, path=path.add_index(1))
      let x1 : String = @json.from_json(v1, path=path.add_index(2))
      Cast(x0, x1)
    }
    Array([String("RowNumber"), v0]) => {
      guard FEATURE_WINDOWS else {
        raise path.error("feature disabled: windowFunctions")
      }
      let x0 : Array[Ordering] = @json.from_json(v0, path=path.add_index(1))
      RowNumber(x0)
    }
    Array([String("Window"), v0, v1, v2, v3, v4]) => {
      guard FEATURE_WINDOWS else {
        raise path.error("feature disabled: windowFunctions")
      }
      let x0 : String = @json.from_json(v0, path=path.add_index(1))
      let x1 : Array[Expr] = @json.from_json(v1, path=path.add_index(2))
      let x2 : Array[Expr] = @json.from_json(v2, path=path.add_index(3))
      let x3 : Array[Ordering] = @json.from_json(v3, path=path.add_index(4))
      let x4 : WindowFrame = @json.from_json(v4, path=path.add_index(5))
      Window(x0, x1, x2, x3, x4)
    }
    Array([String("Between"), v0, v1, v2]) => {
      guard CAP_EXPRESSION_BETWEEN else {
        raise path.error("catalog capability disabled: expression between")
      }

      let x0 : Expr = @json.from_json(v0, path=path.add_index(1))
      let x1 : Expr = @json.from_json(v1, path=path.add_index(2))
      let x2 : Expr = @json.from_json(v2, path=path.add_index(3))
      Between(x0, x1, x2)
    }
    Array([String("Case"), v0, v1, v2]) => {
      guard CAP_EXPRESSION_CASE else {
        raise path.error("catalog capability disabled: expression case")
      }

      let x0 : Expr? = @json.from_json(v0, path=path.add_index(1))
      let x1 : Array[(Expr, Expr)] = @json.from_json(v1, path=path.add_index(2))
      let x2 : Expr = @json.from_json(v2, path=path.add_index(3))
      Case(x0, x1, x2)
    }
    Array([String("InSelect"), v0, v1]) => {
      guard CAP_EXPRESSION_SUBQUERY else {
        raise path.error("catalog capability disabled: expression subquery")
      }
      guard CAP_QUERY_IN_SELECT else {
        raise path.error("catalog capability disabled: query inSelect")
      }
      let x0 : Expr = @json.from_json(v0, path=path.add_index(1))
      let x1 : Selection = @json.from_json(v1, path=path.add_index(2))
      InSelect(x0, x1)
    }
    Array([String("ScalarSelect"), v0]) => {
      guard CAP_EXPRESSION_SUBQUERY else {
        raise path.error("catalog capability disabled: expression subquery")
      }

      let x0 : Selection = @json.from_json(v0, path=path.add_index(1))
      ScalarSelect(x0)
    }
    Array([String("Exists"), v0]) => {
      guard CAP_EXPRESSION_SUBQUERY else {
        raise path.error("catalog capability disabled: expression subquery")
      }

      let x0 : Selection = @json.from_json(v0, path=path.add_index(1))
      Exists(x0)
    }
    _ => raise path.error("invalid Expr tag or arity")
  }
}

///|
impl @json.FromJson for DataStatement with fn from_json(json, path) {
  match json {
    Array([String("PreparedTransaction"), v0, v1]) => {
      guard CAP_STATEMENT_TRANSACTION else {
        raise path.error("catalog capability disabled: statement transaction")
      }
      let x0 : String = @json.from_json(v0, path=path.add_index(1))
      let x1 : String = @json.from_json(v1, path=path.add_index(2))
      PreparedTransaction(x0, x1)
    }
    Array([String("PreparedSelect"), v0]) => {
      guard CAP_STATEMENT_SELECT else {
        raise path.error("catalog capability disabled: statement select")
      }
      let x0 : Selection = @json.from_json(v0, path=path.add_index(1))
      PreparedSelect(x0)
    }
    Array([String("PreparedPragma"), v0, v1]) => {
      guard CAP_STATEMENT_PRAGMA else {
        raise path.error("catalog capability disabled: statement pragma")
      }
      let x0 : String = @json.from_json(v0, path=path.add_index(1))
      let x1 : String = @json.from_json(v1, path=path.add_index(2))
      PreparedPragma(x0, x1)
    }
    Array([String("PreparedInsert"), v0]) => {
      guard CAP_STATEMENT_INSERT else {
        raise path.error("catalog capability disabled: statement insert")
      }
      let x0 : Insertion = @json.from_json(v0, path=path.add_index(1))
      PreparedInsert(x0)
    }
    Array([String("PreparedUpdate"), v0, v1, v2, v3]) => {
      guard CAP_STATEMENT_UPDATE else {
        raise path.error("catalog capability disabled: statement update")
      }
      let x0 : String = @json.from_json(v0, path=path.add_index(1))
      let x1 : Array[(String, Expr)] = @json.from_json(
        v1,
        path=path.add_index(2),
      )
      let x2 : Expr = @json.from_json(v2, path=path.add_index(3))
      let x3 : Array[Projection] = @json.from_json(v3, path=path.add_index(4))
      PreparedUpdate(x0, x1, x2, x3)
    }
    Array([String("PreparedDelete"), v0, v1, v2]) => {
      guard CAP_STATEMENT_DELETE else {
        raise path.error("catalog capability disabled: statement delete")
      }
      let x0 : String = @json.from_json(v0, path=path.add_index(1))
      let x1 : Expr = @json.from_json(v1, path=path.add_index(2))
      let x2 : Array[Projection] = @json.from_json(v2, path=path.add_index(3))
      PreparedDelete(x0, x1, x2)
    }
    _ => raise path.error("invalid DataStatement tag or arity")
  }
}

///|
fn[T : @json.FromJson] json_required_field(
  fields : Map[String, Json],
  key : String,
  path : @json.DecodeContext,
) -> T raise @json.JsonDecodeError {
  let path = path.add_key(key)
  match fields.get(key) {
    Some(value) => @json.from_json(value, path~)
    None => raise path.error("missing required field")
  }
}

///|
fn[T : @json.FromJson] json_optional_field(
  fields : Map[String, Json],
  key : String,
  path : @json.DecodeContext,
) -> T? raise @json.JsonDecodeError {
  match fields.get(key) {
    Some(value) => Some(@json.from_json(value, path=path.add_key(key)))
    None => None
  }
}

///|
impl @json.FromJson for ForeignKey with fn from_json(json, path) {
  if FEATURE_FOREIGN_KEYS {
    json_decode_foreign_key(json, path)
  } else {
    raise path.error("feature disabled: foreignKeys")
  }
}

///|
fn json_decode_foreign_key(
  json : Json,
  path : @json.DecodeContext,
) -> ForeignKey raise @json.JsonDecodeError {
  guard json is Object(json_fields) else {
    raise path.error("expected ForeignKey object")
  }
  let column : Int32 = json_required_field(json_fields, "column", path)
  let parent : String = json_required_field(json_fields, "parent", path)
  let target : String = json_required_field(json_fields, "target", path)
  let cascade : Bool = json_required_field(json_fields, "cascade", path)
  let columns : Array[Int32]? = json_optional_field(
    json_fields, "columns", path,
  )
  let targets : Array[String]? = json_optional_field(
    json_fields, "targets", path,
  )
  let delete_action : String? = json_optional_field(
    json_fields, "delete_action", path,
  )
  let update_action : String? = json_optional_field(
    json_fields, "update_action", path,
  )
  let initially_deferred : Bool? = json_optional_field(
    json_fields, "initially_deferred", path,
  )
  {
    column,
    parent,
    target,
    cascade,
    columns,
    targets,
    delete_action,
    update_action,
    initially_deferred,
  }
}

///|
impl @json.FromJson for TriggerDefinition with fn from_json(json, path) {
  if FEATURE_TRIGGERS {
    json_decode_trigger_definition(json, path)
  } else {
    raise path.error("feature disabled: triggers")
  }
}

///|
fn json_decode_trigger_definition(
  json : Json,
  path : @json.DecodeContext,
) -> TriggerDefinition raise @json.JsonDecodeError {
  guard json is Object(json_fields) else {
    raise path.error("expected TriggerDefinition object")
  }
  let timing : String = json_required_field(json_fields, "timing", path)
  let event : String = json_required_field(json_fields, "event", path)
  let columns : Array[String] = json_required_field(
    json_fields, "columns", path,
  )
  let condition : Expr = json_required_field(json_fields, "condition", path)
  let body : Array[DataStatement] = json_required_field(
    json_fields, "body", path,
  )
  { timing, event, columns, condition, body, }
}

///|
impl @json.FromJson for Source with fn from_json(json, path) {
  if CAP_QUERY_SOURCE {
    json_decode_source(json, path)
  } else {
    raise path.error("catalog capability disabled: query source")
  }
}

///|
fn json_decode_source(
  json : Json,
  path : @json.DecodeContext,
) -> Source raise @json.JsonDecodeError {
  guard json is Object(json_fields) else {
    raise path.error("expected Source object")
  }
  let name : String = json_required_field(json_fields, "name", path)
  let qualifier : String = json_required_field(json_fields, "qualifier", path)
  let left : Bool = json_required_field(json_fields, "left", path)
  let right : Bool? = json_optional_field(json_fields, "right", path)
  let using_columns : Array[String]? = json_optional_field(
    json_fields, "using_columns", path,
  )
  let natural : Bool? = json_optional_field(json_fields, "natural", path)
  let on : Expr = json_required_field(json_fields, "on", path)
  { name, qualifier, left, right, using_columns, natural, on, }
}

///|
impl @json.FromJson for Ordering with fn from_json(json, path) {
  guard json is Object(json_fields) else {
    raise path.error("expected Ordering object")
  }
  let expression : Expr = json_required_field(json_fields, "expression", path)
  let descending : Bool = json_required_field(json_fields, "descending", path)
  { expression, descending, }
}

///|
impl @json.FromJson for Projection with fn from_json(json, path) {
  guard json is Object(json_fields) else {
    raise path.error("expected Projection object")
  }
  let expression : Expr = json_required_field(json_fields, "expression", path)
  let explicit_label : Bool = json_required_field(
    json_fields, "explicit_label", path,
  )
  let label : String = json_required_field(json_fields, "label", path)
  { expression, explicit_label, label, }
}

///|
impl @json.FromJson for Selection with fn from_json(json, path) {
  guard json is Object(json_fields) else {
    raise path.error("expected Selection object")
  }
  let ctes : Array[(String, Selection)] = json_required_field(
    json_fields, "ctes", path,
  )
  let projections : Array[Projection] = json_required_field(
    json_fields, "projections", path,
  )
  let sources : Array[Source] = json_required_field(
    json_fields, "sources", path,
  )
  let predicate : Expr = json_required_field(json_fields, "predicate", path)
  let groups : Array[Expr] = json_required_field(json_fields, "groups", path)
  let having : Expr = json_required_field(json_fields, "having", path)
  let orders : Array[Ordering] = json_required_field(
    json_fields, "orders", path,
  )
  let limit : Expr = json_required_field(json_fields, "limit", path)
  let offset : Expr = json_required_field(json_fields, "offset", path)
  let distinct : Bool = json_required_field(json_fields, "distinct", path)
  let compound : Array[(String, Selection)]? = json_optional_field(
    json_fields, "compound", path,
  )
  let recursive : Bool? = json_optional_field(json_fields, "recursive", path)
  let cte_names : Array[(String, Array[String])]? = json_optional_field(
    json_fields, "cte_names", path,
  )
  {
    ctes,
    projections,
    sources,
    predicate,
    groups,
    having,
    orders,
    limit,
    offset,
    distinct,
    compound,
    recursive,
    cte_names,
  }
}

///|
impl @json.FromJson for ColumnDef with fn from_json(json, path) {
  guard json is Object(json_fields) else {
    raise path.error("expected ColumnDef object")
  }
  let name : String = json_required_field(json_fields, "name", path)
  let declared : String = json_required_field(json_fields, "declared", path)
  let not_null : Bool = json_required_field(json_fields, "not_null", path)
  let primary : Int32 = json_required_field(json_fields, "primary", path)
  let primary_desc : Bool? = json_optional_field(
    json_fields, "primary_desc", path,
  )
  let default_value : Expr = json_required_field(
    json_fields, "default_value", path,
  )
  let default_source : String? = json_optional_field(
    json_fields, "default_source", path,
  )
  let collation : String = json_required_field(json_fields, "collation", path)
  {
    name,
    declared,
    not_null,
    primary,
    primary_desc,
    default_value,
    default_source,
    collation,
  }
}

///|
impl @json.FromJson for Table with fn from_json(json, path) {
  guard json is Object(json_fields) else {
    raise path.error("expected Table object")
  }
  let name : String = json_required_field(json_fields, "name", path)
  let sql : String = json_required_field(json_fields, "sql", path)
  let columns : Array[ColumnDef] = json_required_field(
    json_fields, "columns", path,
  )
  let unique_keys : Array[Array[Int32]] = json_required_field(
    json_fields, "unique_keys", path,
  )
  let checks : Array[Expr] = json_required_field(json_fields, "checks", path)
  let foreign_keys : Array[ForeignKey] = json_required_field(
    json_fields, "foreign_keys", path,
  )
  let without_rowid : Bool = json_required_field(
    json_fields, "without_rowid", path,
  )
  let strict : Bool? = json_optional_field(json_fields, "strict", path)
  let autoincrement : Bool = json_required_field(
    json_fields, "autoincrement", path,
  )
  let sequence : Int64 = json_required_field(json_fields, "sequence", path)
  let sequence_present : Bool? = json_optional_field(
    json_fields, "sequence_present", path,
  )
  let rows : RowPages = json_required_field(json_fields, "rows", path)
  {
    name,
    sql,
    columns,
    unique_keys,
    checks,
    foreign_keys,
    without_rowid,
    strict,
    autoincrement,
    sequence,
    sequence_present,
    rows,
  }
}

///|
impl @json.FromJson for SchemaObject with fn from_json(json, path) {
  guard json is Object(json_fields) else {
    raise path.error("expected SchemaObject object")
  }
  let kind : String = json_required_field(json_fields, "kind", path)
  let name : String = json_required_field(json_fields, "name", path)
  let table : String = json_required_field(json_fields, "table", path)
  let sql : String = json_required_field(json_fields, "sql", path)
  let unique : Bool = json_required_field(json_fields, "unique", path)
  let columns : Array[String] = json_required_field(
    json_fields, "columns", path,
  )
  let query : String = json_required_field(json_fields, "query", path)
  let selection : Selection? = json_optional_field(
    json_fields, "selection", path,
  )
  let index_terms : Array[Ordering]? = json_optional_field(
    json_fields, "index_terms", path,
  )
  let index_predicate : Expr? = json_optional_field(
    json_fields, "index_predicate", path,
  )
  let trigger : TriggerDefinition? = json_optional_field(
    json_fields, "trigger", path,
  )
  {
    kind,
    name,
    table,
    sql,
    unique,
    columns,
    query,
    selection,
    index_terms,
    index_predicate,
    trigger,
  }
}

///|
impl @json.FromJson for Insertion with fn from_json(json, path) {
  guard json is Object(json_fields) else {
    raise path.error("expected Insertion object")
  }
  let table : String = json_required_field(json_fields, "table", path)
  let columns : Array[String] = json_required_field(
    json_fields, "columns", path,
  )
  let values : Array[Array[Expr]] = json_required_field(
    json_fields, "values", path,
  )
  let conflict : String = json_required_field(json_fields, "conflict", path)
  let target : Array[String] = json_required_field(json_fields, "target", path)
  let updates : Array[(String, Expr)] = json_required_field(
    json_fields, "updates", path,
  )
  let predicate : Expr = json_required_field(json_fields, "predicate", path)
  let returning : Array[Projection] = json_required_field(
    json_fields, "returning", path,
  )
  let conflict_override : String? = json_optional_field(
    json_fields, "conflict_override", path,
  )
  let target_predicate : Expr? = json_optional_field(
    json_fields, "target_predicate", path,
  )
  let selection : Selection? = json_optional_field(
    json_fields, "selection", path,
  )
  {
    table,
    columns,
    values,
    conflict,
    target,
    updates,
    predicate,
    returning,
    conflict_override,
    target_predicate,
    selection,
  }
}

///|
impl @json.FromJson for CompiledQuery with fn from_json(json, path) {
  guard json is Object(json_fields) else {
    raise path.error("expected CompiledQuery object")
  }
  let name : String = json_required_field(json_fields, "name", path)
  let parameters : Int32 = json_required_field(json_fields, "parameters", path)
  let names : Array[String] = json_required_field(json_fields, "names", path)
  let statement : DataStatement = json_required_field(
    json_fields, "statement", path,
  )
  { name, parameters, names, statement, }
}

///|
impl @json.FromJson for StorageTree with fn from_json(json, path) {
  guard json is Object(json_fields) else {
    raise path.error("expected StorageTree object")
  }
  let name : String = json_required_field(json_fields, "name", path)
  let table : String = json_required_field(json_fields, "table", path)
  let root : Int32 = json_required_field(json_fields, "root", path)
  let kind : String = json_required_field(json_fields, "kind", path)
  let fields : Array[StorageField] = json_required_field(
    json_fields, "fields", path,
  )
  let predicate : Expr? = json_optional_field(json_fields, "predicate", path)
  { name, table, root, kind, fields, predicate, }
}

///|
impl @json.FromJson for StorageField with fn from_json(json, path) {
  guard json is Object(json_fields) else {
    raise path.error("expected StorageField object")
  }
  let column : Int32 = json_required_field(json_fields, "column", path)
  let collation : String = json_required_field(json_fields, "collation", path)
  let descending : Bool = json_required_field(json_fields, "descending", path)
  let expression : Expr? = json_optional_field(json_fields, "expression", path)
  { column, collation, descending, expression, }
}

// Source: json_functions.mbt

///|
/// SQL JSON preserves member order and duplicate labels. Lookup and edits use
/// the first matching member, as SQLite JSON1 does; storage JSON stays separate.
#derive(Eq)
priv enum SqlJson {
  Null
  True
  False
  Number(Double, String?)
  String(String, String?)
  Array(Array[SqlJson])
  Object(Array[(SqlJsonKey, SqlJson)])
}

///|
#derive(Eq)
priv struct SqlJsonKey {
  text : String
  source : String?
}

///|
fn SqlJson::null() -> SqlJson {
  Null
}

///|
fn SqlJson::string(s : String) -> SqlJson {
  String(s, None)
}

///|
fn SqlJson::array(a : Array[SqlJson]) -> SqlJson {
  Array(a)
}

///|
fn SqlJson::object(a : Array[(String, SqlJson)]) -> SqlJson {
  Object(a.map(p => ({ text: p.0, source: None, }, p.1)))
}

///|
fn json_string_source(text : String, source : String?) -> String {
  match source {
    Some(raw) => raw
    None => @json.to_json(text).stringify()
  }
}

///|
fn SqlJson::stringify(self : SqlJson) -> String {
  match self {
    Null => "null"
    True => "true"
    False => "false"
    Number(n, repr) => repr.unwrap_or(n.to_string())
    String(s, source) => json_string_source(s, source)
    Array(a) => "[" + a.map(v => v.stringify()).join(",") + "]"
    Object(a) =>
      "{" +
      a
      .map(p => json_string_source(p.0.text, p.0.source) + ":" + p.1.stringify())
      .join(",") +
      "}"
  }
}

///|
fn json_key(a : Array[(SqlJsonKey, SqlJson)], key : String) -> Int32 {
  for i, pair in a {
    if pair.0.text == key {
      return i
    }
  }
  -1
}

///|
fn json_get(a : Array[(SqlJsonKey, SqlJson)], key : String) -> SqlJson? {
  let i = json_key(a, key)
  if i < 0 {
    None
  } else {
    Some(a[i].1)
  }
}

///|
fn json_put(
  a : Array[(SqlJsonKey, SqlJson)],
  key : SqlJsonKey,
  v : SqlJson,
) -> Unit {
  let i = json_key(a, key.text)
  if i < 0 {
    a.push((key, v))
  } else {
    a[i] = (a[i].0, v)
  }
}

///|
priv struct SqlJsonParser {
  bytes : Bytes
  mut position : Int32
}

///|
fn SqlJsonParser::space(p : SqlJsonParser) -> Unit {
  while p.position < p.bytes.length() &&
        [b' ', b'\t', b'\r', b'\n'].contains(p.bytes[p.position]) {
    p.position += 1
  }
}

///|
fn SqlJsonParser::take(p : SqlJsonParser, c : Byte) -> Bool {
  p.space()
  if p.position < p.bytes.length() && p.bytes[p.position] == c {
    p.position += 1
    true
  } else {
    false
  }
}

///|
fn SqlJsonParser::value(
  p : SqlJsonParser,
  depth : Int32,
) -> SqlJson raise SqlError {
  guard depth <= 1000 else { fail("JSON depth resource limit") }
  p.space()
  if p.take(b'{') {
    let fields = []
    if !p.take(b'}') {
      while true {
        p.space()
        guard p.position < p.bytes.length() && p.bytes[p.position] == b'"' else {
          fail("malformed JSON")
        }
        guard p.value(depth + 1) is String(key, source) else {
          fail("malformed JSON")
        }
        guard p.take(b':') else { fail("malformed JSON") }
        fields.push(({ text: key, source, }, p.value(depth + 1)))
        if p.take(b'}') {
          break
        }
        guard p.take(b',') else { fail("malformed JSON") }
      }
    }
    return Object(fields)
  }
  if p.take(b'[') {
    let items = []
    if !p.take(b']') {
      while true {
        items.push(p.value(depth + 1))
        if p.take(b']') {
          break
        }
        guard p.take(b',') else { fail("malformed JSON") }
      }
    }
    return Array(items)
  }
  let start = p.position
  guard start < p.bytes.length() else { fail("malformed JSON") }
  if p.bytes[start] == b'"' {
    p.position += 1
    while p.position < p.bytes.length() {
      let c = p.bytes[p.position]
      p.position += 1
      if c == b'"' {
        break
      }
      if c == b'\\' {
        p.position += 1
      }
    }
  } else {
    while p.position < p.bytes.length() &&
          ![b' ', b'\t', b'\r', b'\n', b',', b']', b'}'].contains(
            p.bytes[p.position],
          ) {
      p.position += 1
    }
  }
  guard p.position <= p.bytes.length() && p.position > start else {
    fail("malformed JSON")
  }
  let atom = @json.parse(
    @utf8.decode_lossy(p.bytes[start:p.position]),
    preserve_number_repr=true,
  ) catch {
    _ => fail("malformed JSON")
  }
  match atom {
    Null => SqlJson::Null
    True => SqlJson::True
    False => SqlJson::False
    Number(n, repr~) => SqlJson::Number(n, repr)
    String(s) =>
      SqlJson::String(s, Some(@utf8.decode_lossy(p.bytes[start:p.position])))
    _ => fail("malformed JSON")
  }
}

///|
fn parse_sql_json(text : String) -> SqlJson raise SqlError {
  let bytes = @utf8.encode(text)
  guard bytes.length() <= 1048576 else { fail("JSON resource limit") }
  let p = { bytes, position: 0, }
  let result = p.value(0)
  p.space()
  guard p.position == bytes.length() else { fail("malformed JSON") }
  result
}

///|
priv enum JsonSegment {
  Key(String)
  Index(Int32)
  FromEnd(Int32)
}

///|
fn json_path(path : String) -> Array[JsonSegment] raise SqlError {
  let b = @utf8.encode(path)
  guard b.length() > 0 && b[0] == b'$' else { fail("bad JSON path") }
  let result : Array[JsonSegment] = []
  let mut i = 1
  while i < b.length() {
    if b[i] == b'.' {
      i += 1
      let start = i
      if i < b.length() && b[i] == b'"' {
        i += 1
        while i < b.length() && b[i] != b'"' {
          if b[i] == b'\\' {
            i += 1
          }
          i += 1
        }
        guard i < b.length() else { fail("bad JSON path") }
        i += 1
        let key = @json.parse(@utf8.decode_lossy(b[start:i])) catch {
          _ => fail("bad JSON path")
        }
        guard key is String(key) else { fail("bad JSON path") }
        result.push(Key(key))
      } else {
        while i < b.length() && b[i] != b'.' && b[i] != b'[' {
          i += 1
        }
        guard i > start else { fail("bad JSON path") }
        result.push(Key(@utf8.decode_lossy(b[start:i])))
      }
    } else if b[i] == b'[' {
      i += 1
      let start = i
      while i < b.length() && b[i] != b']' {
        i += 1
      }
      guard i < b.length() && i > start else { fail("bad JSON path") }
      let part = @utf8.decode_lossy(b[start:i])
      if part == "#" {
        result.push(FromEnd(0))
      } else if part.has_prefix("#-") {
        let n = @string.parse_int(part[2:].to_owned()) catch {
          _ => fail("bad JSON path")
        }
        guard n >= 0 else { fail("bad JSON path") }
        result.push(FromEnd(n))
      } else {
        let n = @string.parse_int(part) catch { _ => fail("bad JSON path") }
        guard n >= 0 else { fail("bad JSON path") }
        result.push(Index(n))
      }
      i += 1
    } else {
      fail("bad JSON path")
    }
    guard result.length() <= 64 else { fail("JSON path resource limit") }
  }
  result
}

///|
fn json_lookup(json : SqlJson, path : Array[JsonSegment]) -> SqlJson? {
  let mut current = json
  for part in path {
    match (current, part) {
      (Object(fields), Key(key)) => {
        guard json_get(fields, key) is Some(v) else { return None }
        current = v
      }
      (Array(items), Index(n)) => {
        guard n < items.length() else { return None }
        current = items[n]
      }
      (Array(items), FromEnd(n)) => {
        let n = items.length() - n
        guard n >= 0 && n < items.length() else { return None }
        current = items[n]
      }
      _ => return None
    }
  }
  Some(current)
}

///|
fn json_sql_value(json : SqlJson) -> Value {
  match json {
    Null => Null
    True => Integer(1L)
    False => Integer(0L)
    Number(n, repr) =>
      if repr is Some(s) {
        parse_number(s) catch {
          _ => Real(n)
        }
      } else {
        Real(n)
      }
    String(s, _) => Text(s)
    other => Text(other.stringify())
  }
}

///|
fn json_input(value : Value) -> SqlJson raise SqlError {
  parse_sql_json(checked_text_value(value))
}

///|
fn json_argument(
  value : Value,
  expr : Expr,
  ctx : Evaluation,
) -> SqlJson raise SqlError {
  if CAP_QUERY_JSON_SUBTYPE && value is Text(_) && json_subtype(expr, ctx) {
    return json_input(value)
  }
  match value {
    Null => SqlJson::null()
    Integer(n) => SqlJson::Number(n.to_double(), Some(n.to_string()))
    Real(n) =>
      if n.is_inf() {
        SqlJson::Number(n, Some(if n < 0 { "-9.0e+999" } else { "9.0e+999" }))
      } else if n.is_nan() {
        SqlJson::null()
      } else {
        SqlJson::Number(n, Some(sqlite_real_text(n)))
      }
    Text(s) => SqlJson::string(s)
    Blob(_) => fail("JSON cannot hold BLOB values")
  }
}

///|
/// Return a fresh tree. Paths never mutate a parsed value shared with another call.
fn json_edit(
  json : SqlJson,
  path : Array[JsonSegment],
  position : Int32,
  value : SqlJson,
  mode : String,
) -> SqlJson {
  if position == path.length() {
    return value
  }
  let last = position + 1 == path.length()
  match (json, path[position]) {
    (Object(fields), Key(key)) => {
      let copy = fields.copy()
      let index = json_key(copy, key)
      let exists = index >= 0
      if last {
        if mode == "remove" {
          ignore(copy.remove(index))
        } else if (mode != "insert" || !exists) && (mode != "replace" || exists) {
          json_put(copy, { text: key, source: None, }, value)
        }
      } else if exists || mode == "set" || mode == "insert" {
        let empty = match path[position + 1] {
          Key(_) => SqlJson::object([])
          _ => SqlJson::array([])
        }
        let child = if exists { copy[index].1 } else { empty }
        let next = json_edit(child, path, position + 1, value, mode)
        if exists || next != empty {
          json_put(copy, { text: key, source: None, }, next)
        }
      }
      SqlJson::Object(copy)
    }
    (Array(items), part) => {
      let n = match part {
        Index(n) => n
        FromEnd(n) => items.length() - n
        _ => -1
      }
      if n < 0 || n > items.length() {
        return json
      }
      let copy = items.copy()
      let exists = n < copy.length()
      if last {
        if mode == "remove" {
          if exists {
            ignore(copy.remove(n))
          }
        } else if (mode != "insert" || !exists) && (mode != "replace" || exists) {
          if exists {
            copy[n] = value
          } else {
            copy.push(value)
          }
        }
      } else if exists || mode == "set" || mode == "insert" {
        let empty = match path[position + 1] {
          Key(_) => SqlJson::object([])
          _ => SqlJson::array([])
        }
        let next = json_edit(
          if exists {
            copy[n]
          } else {
            empty
          },
          path,
          position + 1,
          value,
          mode,
        )
        if exists {
          copy[n] = next
        } else if next != empty {
          copy.push(next)
        }
      }
      SqlJson::array(copy)
    }
    _ => json
  }
}

///|
fn json_merge(target : SqlJson, patch : SqlJson) -> SqlJson {
  guard patch is Object(patch) else { return patch }
  let copy = match target {
    Object(fields) => fields.copy()
    _ => []
  }
  for (key, value) in patch {
    let index = json_key(copy, key.text)
    if value is Null {
      if index >= 0 {
        ignore(copy.remove(index))
      }
    } else {
      json_put(
        copy,
        key,
        json_merge(
          if index >= 0 {
            copy[index].1
          } else {
            SqlJson::null()
          },
          value,
        ),
      )
    }
  }
  SqlJson::Object(copy)
}

///|
fn json_arity(name : String, count : Int32) -> Bool {
  match name {
    "->" | "->>" => count == 2
    "json_valid" | "json" | "json_quote" => count == 1
    "json_type" | "json_array_length" => count == 1 || count == 2
    "json_extract" => count >= 2
    "json_set" | "json_insert" | "json_replace" => count >= 1 && count % 2 == 1
    "json_remove" => count >= 1
    "json_array" => true
    "json_object" => count % 2 == 0
    "json_patch" => count == 2
    _ => false
  }
}

///|
fn json_call(
  name : String,
  args : Array[Expr],
  values : Array[Value],
  ctx : Evaluation,
) -> Value raise SqlError {
  if CAP_FUNCTION_JSON_ARROW && (name == "->" || name == "->>") {
    if values[0] is Null {
      return Null
    }
    let json = json_input(values[0])
    if values[1] is Null {
      return Null
    }
    let path : Array[JsonSegment] = match values[1] {
      Integer(n) => {
        // A document cannot have an Int32-overflowing array index. Do not wrap.
        if n > 2147483647L || n < -2147483647L {
          return Null
        }
        [if n < 0L { FromEnd((-n).to_int()) } else { Index(n.to_int()) }]
      }
      value => {
        let text = checked_text_value(value)
        guard text != "" else { fail("bad JSON path") }
        guard !text.contains("\u{0}") else {
          fail("unsupported JSON path with NUL")
        }
        if text.has_prefix("$") {
          json_path(text)
        } else {
          json_path("$.\"" + text + "\"")
        }
      }
    }
    match json_lookup(json, path) {
      Some(value) =>
        if name == "->" {
          Text(value.stringify())
        } else {
          json_sql_value(value)
        }
      None => Null
    }
  } else {
    json_call_function(name, args, values, ctx)
  }
}

///|
fn json_call_function(
  name : String,
  args : Array[Expr],
  values : Array[Value],
  ctx : Evaluation,
) -> Value raise SqlError {
  if CAP_FUNCTION_JSON_NORMALIZE && name == "json_valid" {
    if values[0] is Null {
      return Null
    }
    return boolean(
      try {
        ignore(parse_sql_json(checked_text_value(values[0])))
        true
      } catch {
        _ => false
      },
    )
  }
  if CAP_FUNCTION_JSON_CONSTRUCT && name == "json_quote" {
    return Text(json_argument(values[0], args[0], ctx).stringify())
  }
  if CAP_FUNCTION_JSON_CONSTRUCT && name == "json_array" {
    return Text(
      SqlJson::array(values.mapi((i, v) => json_argument(v, args[i], ctx))).stringify(),
    )
  }
  if CAP_FUNCTION_JSON_CONSTRUCT && name == "json_object" {
    let fields : Array[(String, SqlJson)] = []
    for i = 0; i < values.length(); i = i + 2 {
      guard values[i] is Text(key) else {
        fail("json_object() labels must be TEXT")
      }
      fields.push((key, json_argument(values[i + 1], args[i + 1], ctx)))
    }
    return Text(SqlJson::object(fields).stringify())
  }
  if CAP_FUNCTION_JSON_NORMALIZE && name == "json" {
    return if values[0] is Null {
      Null
    } else {
      Text(json_input(values[0]).stringify())
    }
  }
  if CAP_FUNCTION_JSON_PATCH && name == "json_patch" {
    if values[0] is Null {
      return Null
    }
    let target = json_input(values[0])
    if values[1] is Null {
      return Null
    }
    return Text(json_merge(target, json_input(values[1])).stringify())
  }
  if CAP_FUNCTION_JSON_READ &&
    (
      name == "json_extract" ||
      name == "json_type" ||
      name == "json_array_length"
    ) {
    if values[0] is Null {
      return Null
    }
    let json = json_input(values[0])
    let paths : Array[Value] = if values.length() == 1 {
      [Text("$")]
    } else {
      values[1:].to_owned()
    }
    let results : Array[SqlJson?] = []
    for path in paths {
      if path is Null {
        if name == "json_extract" && paths.length() > 1 {
          results.push(None)
          continue
        }
        return Null
      }
      results.push(json_lookup(json, json_path(checked_text_value(path))))
    }
    if name == "json_extract" {
      if results.length() > 1 {
        return Text(
          SqlJson::array(results.map(v => v.unwrap_or(SqlJson::null()))).stringify(),
        )
      }
      return results[0].map(json_sql_value).unwrap_or(Null)
    }
    guard results[0] is Some(v) else { return Null }
    if name == "json_array_length" {
      return Integer(
        match v {
          Array(items) => items.length().to_int64()
          _ => 0L
        },
      )
    }
    return Text(
      match v {
        Null => "null"
        True => "true"
        False => "false"
        String(_, _) => "text"
        Array(_) => "array"
        Object(_) => "object"
        Number(_, repr) =>
          if repr is Some(s) &&
            !s.contains(".") &&
            !s.contains("e") &&
            !s.contains("E") {
            "integer"
          } else {
            "real"
          }
      },
    )
  }
  if CAP_FUNCTION_JSON_EDIT &&
    ["json_set", "json_insert", "json_replace", "json_remove"].contains(name) {
    return json_edit_call(name, args, values, ctx)
  }
  fail("catalog capability disabled: JSON function " + name)
}

///|
fn json_edit_call(
  name : String,
  args : Array[Expr],
  values : Array[Value],
  ctx : Evaluation,
) -> Value raise SqlError {
  if values[0] is Null {
    return Null
  }
  let mut json = json_input(values[0])
  let mode = match name {
    "json_insert" => "insert"
    "json_replace" => "replace"
    "json_remove" => "remove"
    _ => "set"
  }
  let mut i = 1
  while i < values.length() {
    if values[i] is Null {
      if mode == "remove" {
        return Null
      }
      i += 2
      continue
    }
    let path = json_path(checked_text_value(values[i]))
    if path.is_empty() && mode == "remove" {
      return Null
    }
    let value = if mode == "remove" {
      SqlJson::null()
    } else {
      json_argument(values[i + 1], args[i + 1], ctx)
    }
    if !path.is_empty() || mode != "insert" {
      json = json_edit(json, path, 0, value, mode)
    }
    i += if mode == "remove" { 1 } else { 2 }
  }
  Text(json.stringify())
}

///|
fn json_subtype(expr : Expr, ctx : Evaluation) -> Bool raise SqlError {
  match expr {
    Column(q, n) => {
      if !FEATURE_JSON_TABLE {
        return false
      }
      let origin = resolve_context(ctx, q, n).json_value
      guard origin != 2 else {
        fail("unsupported JSON table subtype through relation boundary")
      }
      origin == 1
    }
    Call("json_extract", args) => {
      guard CAP_FUNCTION_JSON_READ else { return false }
      if args.length() > 2 {
        return true
      }
      let source = evaluate(args[0], ctx)
      let path = evaluate(args[1], ctx)
      if source is Null || path is Null {
        return false
      }
      match
        json_lookup(json_input(source), json_path(checked_text_value(path))) {
        Some(Array(_)) | Some(Object(_)) => true
        _ => false
      }
    }
    Call("coalesce", args) | Call("ifnull", args) => {
      for arg in args {
        if !(evaluate(arg, ctx) is Null) {
          return json_subtype(arg, ctx)
        }
      }
      false
    }
    Call("nullif", args) => json_subtype(args[0], ctx)
    Call("iif", args) | Call("if", args) => {
      let mut index = 0
      while index + 1 < args.length() {
        if truth(evaluate(args[index], ctx)) == 1 {
          return json_subtype(args[index + 1], ctx)
        }
        index += 2
      }
      if index < args.length() {
        json_subtype(args[index], ctx)
      } else {
        false
      }
    }
    Call(name, _) =>
      [
        "json", "json_quote", "json_array", "json_object", "json_set", "json_insert",
        "json_replace", "json_remove", "json_patch", "->", "json_group_array", "json_group_object",
      ].contains(name)
    Case(base, arms, other) => {
      let selected = evaluate(
        Case(
          base,
          arms.mapi((i, p) => (p.0, Literal(Integer(i.to_int64())))),
          Literal(Integer(-1L)),
        ),
        ctx,
      )
      if selected is Integer(i) && i >= 0L {
        json_subtype(arms[i.to_int()].1, ctx)
      } else {
        json_subtype(other, ctx)
      }
    }
    Collate(e, _) | Unary("+", e) | Cast(e, "text") => json_subtype(e, ctx)
    _ => false
  }
}

// Source: json_table.mbt

///|
/// Per-SELECT limits. No parsed trees, rows or bindings survive an execution.
priv struct JsonTableBudget {
  mut bytes : Int32
  mut nodes : Int32
  mut paths : Int32
}

///|
priv struct JsonTableNode {
  json : SqlJson
  payload : Int32
  children : Array[JsonTableNode]
}

///|
fn json_table_source(source : Source) -> Bool {
  source.name.has_prefix("\u{0}json:")
}

///|
fn json_table_root(path : String) -> Array[JsonSegment] raise SqlError {
  guard !path.contains("\u{0}") && !path.contains("\\") else {
    fail("unsupported JSON table root path")
  }
  let parts = json_path(path)
  guard parts.length() <= 1 else {
    fail("unsupported multi-segment JSON table root")
  }
  if !parts.is_empty() && !(parts[0] is Key(_)) {
    let bytes = @utf8.encode(path)
    let start = if path.has_prefix("$[#-") { 4 } else { 2 }
    if path != "$[#]" {
      guard bytes[start:bytes.length() - 1]
        .iter()
        .all(c => c >= b'0' && c <= b'9') else {
        fail("bad JSON path")
      }
    }
  }

  parts
}

///|
/// TVF subtype can survive native query flattening. Across a materialization
/// boundary the current evaluator rejects implicit propagation; json(x) is explicit.
fn json_table_origin(e : Expr, ctx : Evaluation) -> Bool raise SqlError {
  match e {
    Column(q, n) => resolve_context(ctx, q, n).json_value > 0
    TruthLiteral(v) =>
      find_context(ctx, "", if v { "true" } else { "false" })
      .map(b => b.json_value > 0)
      .unwrap_or(false)
    Window(_, args, _, _, _) => args.any(e => json_table_origin(e, ctx))
    Unary(_, e) | Cast(e, _) | Collate(e, _) => json_table_origin(e, ctx)
    // RAISE's action is an internal identifier, not a column expression.
    Call("raise", args) => args.length() > 1 && json_table_origin(args[1], ctx)
    Call(_, args) => args.any(e => json_table_origin(e, ctx))
    Binary(_, a, b) => json_table_origin(a, ctx) || json_table_origin(b, ctx)
    Between(e, a, b) =>
      json_table_origin(e, ctx) ||
      json_table_origin(a, ctx) ||
      json_table_origin(b, ctx)
    Case(base, arms, other) =>
      base.map(e => json_table_origin(e, ctx)).unwrap_or(false) ||
      arms.any(p => json_table_origin(p.0, ctx) || json_table_origin(p.1, ctx)) ||
      json_table_origin(other, ctx)
    ScalarSelect(select) | Exists(select) =>
      selection_template(select, ctx.nested()).any(b => b.json_value > 0)
    InSelect(e, select) =>
      json_table_origin(e, ctx) ||
      selection_template(select, ctx.nested()).any(b => b.json_value > 0)
    _ => false
  }
}

///|
fn json_table_ambiguous(e : Expr, ctx : Evaluation) -> Bool raise SqlError {
  match e {
    Column(q, n) => resolve_context(ctx, q, n).json_value == 2
    TruthLiteral(v) =>
      find_context(ctx, "", if v { "true" } else { "false" })
      .map(b => b.json_value == 2)
      .unwrap_or(false)
    Window(_, args, _, _, _) => args.any(e => json_table_origin(e, ctx))
    Unary(_, e) | Cast(e, _) | Collate(e, _) => json_table_ambiguous(e, ctx)
    Call("min", _) | Call("max", _) => json_table_origin(e, ctx)
    Call("coalesce", args)
    | Call("ifnull", args)
    | Call("nullif", args)
    | Call("if", args)
    | Call("iif", args) => args.any(e => json_table_ambiguous(e, ctx))
    Case(_, arms, other) =>
      arms.any(p => json_table_ambiguous(p.1, ctx)) ||
      json_table_ambiguous(other, ctx)
    ScalarSelect(select) =>
      selection_template(select, ctx.nested()).any(b => b.json_value > 0)
    _ => false
  }
}

///|
fn json_table_parts(
  source : Source,
) -> (String, Expr, Expr, Expr) raise SqlError {
  guard FEATURE_JSON_TABLE else { fail("feature disabled: jsonTableFunctions") }
  guard source.on
    is Call("$json-table", [Literal(Text(name)), input, root, condition]) &&
    ["json_each", "json_tree"].contains(name) &&
    source.name == "\u{0}json:" + name else {
    fail("invalid JSON table metadata")
  }
  (name, input, root, condition)
}

///|
fn json_table_template(source : Source) -> Environment {
  [
    "key", "value", "type", "atom", "id", "parent", "fullkey", "path", "json", "root",
    "rowid", "_rowid_", "oid",
  ].mapi((i, name) => {
    ..binding(name, Null),
    qualifier: source.qualifier,
    hidden: i >= 8,
    json_value: if i == 1 {
      1
    } else {
      0
    },
    affinity: if ["rowid", "_rowid_", "oid"].contains(name) {
      "integer"
    } else if ["type", "fullkey", "path", "root"].contains(name) {
      "text"
    } else {
      ""
    },
  })
}

///|
fn prepare_json_table(
  source : Source,
  context : Evaluation,
) -> Unit raise SqlError {
  let (name, input, root, _) = json_table_parts(source)
  guard !context.store.tables.any(t => matches_identifier(t.name, name)) &&
    !context.store.objects.any(o => {
      o.kind == "view" && matches_identifier(o.name, name)
    }) &&
    !context.ctes.contains(name) else {
    fail("JSON table function is shadowed: " + name)
  }
  prepare_expression(
    input,
    { ..context, forbid_json_inputs: false, },
    false,
    false,
  )
  if root is Literal(Text(path)) {
    ignore(json_table_root(path))
  }
  prepare_expression(
    root,
    { ..context, forbid_json_inputs: false, },
    false,
    false,
  )
}

///|
fn json_table_joins(sources : Array[Source]) -> Unit raise SqlError {
  if sources.any(json_table_source) && sources.any(s => s.right == Some(true)) {
    fail("unsupported RIGHT/FULL JOIN with JSON tables")
  }
}

///|
fn json_table_header(payload : Int32) -> Int32 {
  if payload <= 11 {
    1
  } else if payload <= 255 {
    2
  } else if payload <= 65535 {
    3
  } else {
    5
  }
}

///|
fn JsonTableNode::size(node : JsonTableNode) -> Int32 {
  json_table_header(node.payload) + node.payload
}

///|
fn json_table_string_size(text : String, source : String?) -> Int32 {
  let length = @utf8.encode(json_string_source(text, source)).length() - 2
  json_table_header(length) + length
}

///|
fn json_table_node(
  json : SqlJson,
  budget : JsonTableBudget,
  depth : Int32,
) -> JsonTableNode raise SqlError {
  budget.nodes += 1
  guard budget.nodes <= 200000 && depth <= 128 else {
    fail("JSON table node/depth resource limit")
  }
  let children : Array[JsonTableNode] = []
  let payload = match json {
    Array(items) => {
      for item in items {
        children.push(json_table_node(item, budget, depth + 1))
      }
      children.fold(init=0, (n, c) => n + c.size())
    }
    Object(fields) => {
      let mut size = 0
      for (key, value) in fields {
        let child = json_table_node(value, budget, depth + 1)
        children.push(child)
        size += json_table_string_size(key.text, key.source) + child.size()
      }
      size
    }
    String(text, source) =>
      @utf8.encode(json_string_source(text, source)).length() - 2
    Number(_, _) => @utf8.encode(json.stringify()).length()
    _ => 0
  }
  { json, payload, children, }
}

///|
fn json_table_type(json : SqlJson) -> String {
  match json {
    Null => "null"
    True => "true"
    False => "false"
    String(_, _) => "text"
    Array(_) => "array"
    Object(_) => "object"
    Number(_, _) => {
      let raw = json.stringify()
      if raw.contains(".") || raw.contains("e") || raw.contains("E") {
        "real"
      } else {
        "integer"
      }
    }
  }
}

///|
fn json_table_label(key : SqlJsonKey) -> String {
  let raw = json_string_source(key.text, key.source)
  let bytes = @utf8.encode(raw)
  let text = bytes[1:bytes.length() - 1]
  let alpha = fn(c : Byte) {
    (c >= b'a' && c <= b'z') || (c >= b'A' && c <= b'Z')
  }
  if !text.is_empty() &&
    alpha(text[0]) &&
    text.iter().all(c => alpha(c) || (c >= b'0' && c <= b'9')) {
    "." + key.text
  } else {
    "." + raw
  }
}

///|
fn json_table_emit(
  node : JsonTableNode,
  id : Int32,
  key : Value,
  parent : Value,
  fullkey : String,
  path : String,
  input : String,
  root : String,
  layout : Environment,
  rows : Array[Environment],
  budget : JsonTableBudget,
) -> Unit raise SqlError {
  guard rows.length() < 100000 else { fail("JSON table row resource limit") }
  budget.paths += @utf8.encode(fullkey).length() + @utf8.encode(path).length()
  guard budget.paths <= 16777216 else { fail("JSON table path resource limit") }
  let container = node.json is Array(_) || node.json is Object(_)
  let value = json_sql_value(node.json)
  let rowid : Value = Integer(rows.length().to_int64())
  let values = [
    key,
    value,
    Text(json_table_type(node.json)),
    if container {
      Value::Null
    } else {
      value
    },
    Integer(id.to_int64()),
    parent,
    Text(fullkey),
    Text(path),
    Text(input),
    Text(root),
    rowid,
    rowid,
    rowid,
  ]
  rows.push(
    layout.mapi((i, b) => {
      ..b,
      value: values[i],
      json_value: if i == 1 && container {
        1
      } else {
        0
      },
    }),
  )
}

///|
fn json_table_walk(
  node : JsonTableNode,
  id : Int32,
  value_offset : Int32,
  key : Value,
  parent : Value,
  fullkey : String,
  path : String,
  input : String,
  root : String,
  layout : Environment,
  recursive : Bool,
  emit : Bool,
  rows : Array[Environment],
  budget : JsonTableBudget,
) -> Unit raise SqlError {
  if emit {
    json_table_emit(
      node, id, key, parent, fullkey, path, input, root, layout, rows, budget,
    )
  }
  if emit && !recursive {
    return
  }
  let mut offset = value_offset + json_table_header(node.payload)
  for i, child in node.children {
    let (key, append, label_size) = match node.json {
      Object(fields) => {
        let label = fields[i].0
        (
          Value::Text(label.text),
          json_table_label(label),
          json_table_string_size(label.text, label.source),
        )
      }
      _ => (Value::Integer(i.to_int64()), "[" + i.to_string() + "]", 0)
    }
    json_table_walk(
      child,
      offset,
      offset + label_size,
      key,
      if recursive {
        Integer(id.to_int64())
      } else {
        Null
      },
      fullkey + append,
      fullkey,
      input,
      root,
      layout,
      recursive,
      true,
      rows,
      budget,
    )
    offset += label_size + child.size()
  }
}

///|
fn json_table_rows(
  source : Source,
  context : Evaluation,
  budget : JsonTableBudget,
) -> Array[Environment] raise SqlError {
  let (name, input_expr, root_expr, _) = json_table_parts(source)
  let input = evaluate(input_expr, context)
  let root = evaluate(root_expr, context)
  if input is Null {
    return []
  }
  guard !(input is Blob(_)) else {
    fail("unsupported JSON table BLOB/JSONB input")
  }
  let input = checked_text_value(input)
  budget.bytes += @utf8.encode(input).length()
  guard budget.bytes <= 16777216 else {
    fail("JSON table input resource limit")
  }
  let node = json_table_node(parse_sql_json(input), budget, 0)
  if root is Null {
    return []
  }
  let root = checked_text_value(root)
  let parts = json_table_root(root)
  let mut selected = node
  let mut id = 0
  let mut value_offset = 0
  let mut key : Value = Null
  if !parts.is_empty() {
    let mut offset = json_table_header(node.payload)
    let index = match (node.json, parts[0]) {
      (Object(fields), Key(k)) => fields.search_by(p => p.0.text == k)
      (Array(items), Index(n)) =>
        if n < items.length() {
          Some(n)
        } else {
          None
        }
      (Array(items), FromEnd(n)) =>
        if n > 0 && n <= items.length() {
          Some(items.length() - n)
        } else {
          None
        }
      _ => None
    }
    guard index is Some(index) else { return [] }
    for i, child in node.children {
      let label_size = match node.json {
        Object(fields) =>
          json_table_string_size(fields[i].0.text, fields[i].0.source)
        _ => 0
      }
      if i == index {
        selected = child
        id = offset
        value_offset = offset + label_size
        key = match parts[0] {
          Key(k) => Text(k)
          Index(n) => Integer(n.to_int64())
          FromEnd(_) => Integer(0L)
        }
        break
      }
      offset += label_size + child.size()
    }
  }
  let rows : Array[Environment] = []
  let recursive = name == "json_tree"
  let container = selected.json is Array(_) || selected.json is Object(_)
  json_table_walk(
    selected,
    id,
    value_offset,
    if recursive {
      key
    } else {
      Null
    },
    Null,
    root,
    if recursive && !parts.is_empty() {
      "$"
    } else {
      root
    },
    input,
    root,
    json_table_template(source),
    recursive,
    recursive || !container,
    rows,
    budget,
  )
  rows
}

///|
fn json_table_join(
  source : Source,
  input : Array[Environment],
  layout : Environment,
  context : Evaluation,
  budget : JsonTableBudget,
  predicate : Expr,
) -> Relation raise SqlError {
  prepare_json_table(source, { ..context, row: layout, })
  let (_, _, _, condition) = json_table_parts(source)
  let empty = json_table_template(source)
  prepare_expression(
    condition,
    { ..context, row: layout + empty, forbid_json_inputs: true, },
    false,
    false,
  )
  let pairs = using_pairs(source, layout, empty)
  let output : Array[Environment] = []
  for left in input {
    if !json_table_guard(predicate, source, { ..context, row: left, }) {
      continue
    }
    let mut matched = false
    for right in json_table_rows(source, { ..context, row: left, }, budget) {
      let joined = left + right
      if truth(evaluate(condition, { ..context, row: joined, })) == 1 &&
        using_matches(left, right, pairs, context) {
        output.push(using_row(source, left, right, pairs))
        matched = true
      }
      guard output.length() <= 100000 else { fail("SQL result resource limit") }
    }
    if source.left && !matched {
      output.push(using_row(source, left, empty, pairs))
    }
    guard output.length() <= 100000 else { fail("SQL result resource limit") }
  }
  { rows: output, template: using_row(source, layout, empty, pairs), }
}

///|
/// Only a qualified preceding-column guard is pushed. It cannot bind a column
/// from this/later TVF or accidentally resolve an unqualified correlated name.
fn json_table_guard(
  predicate : Expr,
  source : Source,
  ctx : Evaluation,
) -> Bool raise SqlError {
  match predicate {
    Binary("and", a, b) =>
      json_table_guard(a, source, ctx) && json_table_guard(b, source, ctx)
    Call("json_valid", [Column(q, n)]) =>
      if q != "" &&
        !matches_identifier(q, identifier(source.qualifier)) &&
        find_binding(ctx.row, q, n) is Some(_) {
        truth(evaluate(predicate, ctx)) == 1
      } else {
        true
      }
    _ => true
  }
}

// Source: json_table_aggregate.mbt

///|
/// A narrow streaming alternative to relation materialization. Metadata and JSON
/// trees belong to this execution only, never a prepared query.
priv struct JsonTableAggregation {
  names : Array[String]
  columns : Array[RowProjection]
  states : Array[SumState]
  input : String
  root : String
  mut rows : Int32
}

///|
fn json_table_aggregate(
  select : Selection,
  context : Evaluation,
  output : Environment,
) -> Relation? raise SqlError {
  guard OPT_JSON_TABLE_AGGREGATE &&
    context.store.encoding.unwrap_or(1) == 1 &&
    select.sources.length() == 1 &&
    select.ctes.is_empty() &&
    context.ctes.is_empty() &&
    !select.distinct &&
    select.groups.is_empty() &&
    select.having is Literal(Integer(1L)) &&
    select.predicate is Literal(Integer(1L)) &&
    select.orders.is_empty() else {
    return None
  }
  let source = select.sources[0]
  guard json_table_source(source) else { return None }
  let (_, _, _, condition) = json_table_parts(source)
  guard condition is Literal(Integer(1L)) &&
    !source.left &&
    source.right != Some(true) &&
    source.natural != Some(true) &&
    source.using_columns.unwrap_or([]).is_empty() else {
    return None
  }
  let names : Array[String] = []
  let columns : Array[RowProjection] = []
  let layout = json_table_template(source)
  for p in select.projections {
    guard p.expression is Call(name, [arg]) &&
      ["count", "sum", "total", "avg"].contains(name) else {
      return None
    }
    let field = match arg {
      Star(_) => {
        guard name == "count" else { return None }
        Constant(Integer(1L))
      }
      Literal(v) => Constant(v)
      Column(q, n) => {
        guard find_binding(layout, q, n) is Some(found) else { return None }
        let index = layout.search_by(b => b.name == found.name).unwrap()
        // IDs and paths need the JSONB layout; retain the general visitor.
        guard [0, 1, 2, 3, 8, 9, 10, 11, 12].contains(index) else {
          return None
        }
        Stored(index)
      }
      _ => return None
    }
    names.push(name)
    columns.push(field)
  }
  guard !names.is_empty() &&
    rowid_value(select.limit, context.params) is Some(limit) &&
    rowid_value(select.offset, context.params) is Some(offset) else {
    return None
  }
  if limit == 0L {
    return Some({ rows: [], template: output, })
  }
  prepare_json_table(source, context)
  let (name, input_expr, root_expr, _) = json_table_parts(source)
  let input = evaluate(input_expr, context)
  let root = evaluate(root_expr, context)
  let states = names.map(_ => sum_state())
  if !(input is Null) {
    guard !(input is Blob(_)) else {
      fail("unsupported JSON table BLOB/JSONB input")
    }
    let input = checked_text_value(input)
    let budget : JsonTableBudget = {
      bytes: @utf8.encode(input).length(),
      nodes: 0,
      paths: 0,
    }
    guard budget.bytes <= 16777216 else {
      fail("JSON table input resource limit")
    }
    let json = parse_sql_json(input)
    json_table_check_nodes(json, budget, 0)
    if !(root is Null) {
      let root = checked_text_value(root)
      let parts = json_table_root(root)
      let selected = if parts.is_empty() {
        Some(json)
      } else {
        match (json, parts[0]) {
          (Object(fields), Key(k)) => json_get(fields, k)
          (Array(items), Index(i)) =>
            if i < items.length() {
              Some(items[i])
            } else {
              None
            }
          (Array(items), FromEnd(n)) =>
            if n > 0 && n <= items.length() {
              Some(items[items.length() - n])
            } else {
              None
            }
          _ => None
        }
      }
      if selected is Some(selected) {
        let recursive = name == "json_tree"
        let container = selected is Array(_) || selected is Object(_)
        let key : Value = if recursive && !parts.is_empty() {
          match parts[0] {
            Key(k) => Text(k)
            Index(n) => Integer(n.to_int64())
            FromEnd(_) => Integer(0L)
          }
        } else {
          Null
        }
        let root_bytes = @utf8.encode(root).length()
        json_table_accumulate(
          selected,
          key,
          root_bytes,
          if recursive && !parts.is_empty() {
            1
          } else {
            root_bytes
          },
          recursive,
          recursive || !container,
          { names, columns, states, input, root, rows: 0, },
          budget,
        )
      }
    }
  }
  let values : Array[Value] = names.mapi((i, name) => {
    if name == "count" {
      Integer(states[i].count)
    } else {
      states[i].finish(name)
    }
  })
  Some({
    template: output,
    rows: if offset > 0L {
      []
    } else {
      [output.mapi((i, b) => { ..b, value: values[i], })]
    },
  })
}

///|
/// Preserve the general visitor's input-wide node/depth guard, even for missing
/// roots. No parallel JSONB node tree is needed by this aggregate path.
fn json_table_check_nodes(
  json : SqlJson,
  budget : JsonTableBudget,
  depth : Int32,
) -> Unit raise SqlError {
  budget.nodes += 1
  guard budget.nodes <= 200000 && depth <= 128 else {
    fail("JSON table node/depth resource limit")
  }
  match json {
    Array(items) =>
      for v in items {
        json_table_check_nodes(v, budget, depth + 1)
      }
    Object(fields) =>
      for (_, v) in fields {
        json_table_check_nodes(v, budget, depth + 1)
      }
    _ => ()
  }
}

///|
fn json_table_accumulate(
  json : SqlJson,
  key : Value,
  fullkey_bytes : Int32,
  path_bytes : Int32,
  recursive : Bool,
  emit : Bool,
  plan : JsonTableAggregation,
  budget : JsonTableBudget,
) -> Unit raise SqlError {
  if emit {
    guard plan.rows < 100000 else { fail("JSON table row resource limit") }
    budget.paths += fullkey_bytes + path_bytes
    guard budget.paths <= 16777216 else {
      fail("JSON table path resource limit")
    }
    let container = json is Array(_) || json is Object(_)
    let needs_value = plan.columns.any(c => {
      c is Stored(1) || (c is Stored(3) && !container)
    })
    let scalar = if needs_value { json_sql_value(json) } else { Value::Null }
    for i, column in plan.columns {
      let value : Value = match column {
        Constant(v) => v
        Stored(0) => key
        Stored(1) => scalar
        Stored(2) => Text(json_table_type(json))
        Stored(3) => if container { Null } else { scalar }
        Stored(8) => Text(plan.input)
        Stored(9) => Text(plan.root)
        _ => Integer(plan.rows.to_int64())
      }
      if plan.names[i] == "count" {
        if !(value is Null) {
          plan.states[i].count += 1L
        }
      } else {
        plan.states[i].add(value)
      }
    }
    plan.rows += 1
  }
  if emit && !recursive {
    return
  }
  match json {
    Array(items) =>
      for i, value in items {
        json_table_accumulate(
          value,
          Integer(i.to_int64()),
          fullkey_bytes + i.to_string().length() + 2,
          fullkey_bytes,
          recursive,
          true,
          plan,
          budget,
        )
      }
    Object(fields) =>
      for (key, value) in fields {
        let append = @utf8.encode(json_table_label(key)).length()
        json_table_accumulate(
          value,
          Text(key.text),
          fullkey_bytes + append,
          fullkey_bytes,
          recursive,
          true,
          plan,
          budget,
        )
      }
    _ => ()
  }
}

// Source: math_rounding.mbt

///|
/// SQLite preserves INTEGER inputs; REAL and decimal/exponent TEXT stay REAL.
/// Numeric conversion reads TEXT up to its first NUL and never converts BLOB.
fn math_rounding_value(name : String, value : Value) -> Value {
  let value : Value = match value {
    Text(s) =>
      match s.find("\u{0}") {
        Some(i) => Text(s[:i].to_owned())
        None => value
      }
    _ => value
  }
  match numeric(value, true) {
    Integer(_) as value => value
    Real(n) =>
      Real(
        if name == "floor" || (name == "trunc" && !(n < 0.0)) {
          n.floor()
        } else {
          -(-n).floor()
        },
      )
    _ => Null
  }
}

// Source: migration.mbt

///|
priv struct Rename {
  store : Store
  table : String
  new_table : String
  column : String
  new_column : String
  mut referenced : Bool
}

///|
fn rename_table_name(r : Rename, name : String) -> String {
  if identifier(name) == identifier(r.table) {
    r.new_table
  } else {
    name
  }
}

///|
fn rename_column_name(r : Rename, table : String, name : String) -> String {
  if r.column != "" &&
    identifier(table) == identifier(r.table) &&
    identifier(name) == identifier(r.column) {
    r.referenced = true
    r.new_column
  } else {
    name
  }
}

///|
fn rename_expr(r : Rename, e : Expr, scope : Array[(String, String)]) -> Expr {
  match e {
    Column(q, n) => {
      let mut owner = ""
      if q != "" {
        for (qualifier, table) in scope {
          if identifier(qualifier) == identifier(q) {
            owner = table
            break
          }
        }
      } else {
        for (qualifier, table) in scope {
          if qualifier == "old" || qualifier == "new" {
            continue
          }
          if r.store.tables.any(t => {
              identifier(t.name) == identifier(table) &&
              t.columns.any(c => identifier(c.name) == identifier(n))
            }) {
            owner = table
            break
          }
        }
      }
      Column(
        if identifier(owner) == identifier(r.table) &&
          identifier(q) == identifier(r.table) {
          r.new_table
        } else {
          q
        },
        rename_column_name(r, owner, n),
      )
    }
    Star(q) =>
      Star(
        if identifier(q) == identifier(r.table) &&
          scope.any(s => {
            identifier(s.0) == identifier(q) &&
            identifier(s.1) == identifier(r.table)
          }) {
          r.new_table
        } else {
          q
        },
      )
    Unary(op, e) => Unary(op, rename_expr(r, e, scope))
    Binary(op, a, b) =>
      Binary(op, rename_expr(r, a, scope), rename_expr(r, b, scope))
    Cast(e, t) => Cast(rename_expr(r, e, scope), t)
    Collate(e, c) => Collate(rename_expr(r, e, scope), c)
    Call(name, args) => Call(name, args.map(e => rename_expr(r, e, scope)))
    Between(a, b, c) =>
      Between(
        rename_expr(r, a, scope),
        rename_expr(r, b, scope),
        rename_expr(r, c, scope),
      )
    Case(base, arms, other) =>
      Case(
        base.map(e => rename_expr(r, e, scope)),
        arms.map(p => (rename_expr(r, p.0, scope), rename_expr(r, p.1, scope))),
        rename_expr(r, other, scope),
      )
    ScalarSelect(s) => ScalarSelect(rename_select(r, s, scope))
    Exists(s) => Exists(rename_select(r, s, scope))
    InSelect(e, s) =>
      InSelect(rename_expr(r, e, scope), rename_select(r, s, scope))
    RowNumber(orders) =>
      RowNumber(
        orders.map(o => {
          ..o,
          expression: rename_expr(r, o.expression, scope),
        }),
      )
    Window(name, args, parts, orders, frame) =>
      Window(
        name,
        args.map(e => rename_expr(r, e, scope)),
        parts.map(e => rename_expr(r, e, scope)),
        orders.map(o => {
          ..o,
          expression: rename_expr(r, o.expression, scope),
        }),
        frame,
      )
    _ => e
  }
}

///|
fn rename_select(
  r : Rename,
  s : Selection,
  outer : Array[(String, String)],
) -> Selection {
  let scope = s.sources.map(source => (source.qualifier, source.name)) + outer
  {
    ..s,
    sources: s.sources.map(source => {
      ..source,
      name: rename_table_name(r, source.name),
      qualifier: if identifier(source.name) == identifier(r.table) &&
        identifier(source.qualifier) == identifier(r.table) {
        r.new_table
      } else {
        source.qualifier
      },
      on: rename_expr(r, source.on, scope),
    }),
    ctes: s.ctes.map(p => (p.0, rename_select(r, p.1, outer))),
    projections: s.projections.map(p => {
      let expression = rename_expr(r, p.expression, scope)
      {
        ..p,
        expression,
        label: if !p.explicit_label && expression is Column(_, n) {
          n
        } else {
          p.label
        },
      }
    }),
    predicate: rename_expr(r, s.predicate, scope),
    groups: s.groups.map(e => rename_expr(r, e, scope)),
    having: rename_expr(r, s.having, scope),
    orders: s.orders.map(o => {
      ..o,
      expression: rename_expr(r, o.expression, scope),
    }),
    compound: s.compound.map(arms => {
      arms.map(p => (p.0, rename_select(r, p.1, outer)))
    }),
  }
}

///|
fn rename_data(
  r : Rename,
  statement : DataStatement,
  outer : Array[(String, String)],
) -> DataStatement {
  match statement {
    PreparedSelect(s) => PreparedSelect(rename_select(r, s, outer))
    PreparedInsert(i) => {
      let scope = [(i.table, i.table), ("excluded", i.table)] + outer
      PreparedInsert({
        ..i,
        table: rename_table_name(r, i.table),
        columns: i.columns.map(n => rename_column_name(r, i.table, n)),
        values: i.values.map(row => row.map(e => rename_expr(r, e, outer))),
        selection: i.selection.map(s => rename_select(r, s, outer)),
        target: i.target.map(n => rename_column_name(r, i.table, n)),
        target_predicate: i.target_predicate.map(e => rename_expr(r, e, scope)),
        updates: i.updates.map(p => {
          (rename_column_name(r, i.table, p.0), rename_expr(r, p.1, scope))
        }),
        predicate: rename_expr(r, i.predicate, scope),
        returning: i.returning.map(p => {
          ..p,
          expression: rename_expr(r, p.expression, scope),
        }),
      })
    }
    PreparedUpdate(name, setters, predicate, returning) => {
      let scope = [(name, name)] + outer
      PreparedUpdate(
        rename_table_name(r, name),
        setters.map(p => {
          (rename_column_name(r, name, p.0), rename_expr(r, p.1, scope))
        }),
        rename_expr(r, predicate, scope),
        returning.map(p => {
          ..p,
          expression: rename_expr(r, p.expression, scope),
        }),
      )
    }
    PreparedDelete(name, predicate, returning) => {
      let scope = [(name, name)] + outer
      PreparedDelete(
        rename_table_name(r, name),
        rename_expr(r, predicate, scope),
        returning.map(p => {
          ..p,
          expression: rename_expr(r, p.expression, scope),
        }),
      )
    }
    _ => statement
  }
}

///|
fn rename_object(r : Rename, o : SchemaObject) -> SchemaObject {
  let scope = [(o.table, o.table), ("old", o.table), ("new", o.table)]
  let trigger = o.trigger.map(t => {
    ..t,
    columns: t.columns.map(n => rename_column_name(r, o.table, n)),
    condition: rename_expr(r, t.condition, scope),
    body: t.body.map(s => {
      rename_data(r, s, [("old", o.table), ("new", o.table)])
    }),
  })
  let next = {
    ..o,
    table: if o.kind == "view" {
      o.table
    } else {
      rename_table_name(r, o.table)
    },
    columns: o.columns.map(n => rename_column_name(r, o.table, n)),
    index_terms: o.index_terms.map(orders => {
      orders.map(order => {
        ..order,
        expression: rename_expr(r, order.expression, scope),
      })
    }),
    index_predicate: o.index_predicate.map(e => rename_expr(r, e, scope)),
    selection: o.selection.map(s => rename_select(r, s, [])),
    trigger,
  }
  next
}

///|
fn migrate_schema(
  store : Store,
  name : String,
  new_table : String,
  column : String,
  new_column : String,
  drop : Bool,
  quoted~ : Bool = false,
) -> Unit raise SqlError {
  guard !store.tables.any(has_generated_columns) else {
    fail("unsupported ALTER with generated columns")
  }
  let original = copy_store(store)
  let table = get_table(original, name)
  let index = if column == "" { -1 } else { column_index(table, column) }
  if column == "" {
    guard !store.tables.any(t => identifier(t.name) == identifier(new_table)) &&
      !store.objects.any(o => identifier(o.name) == identifier(new_table)) else {
      fail("table already exists")
    }
  } else if !drop {
    guard !table.columns.any(c => identifier(c.name) == identifier(new_column)) else {
      fail("duplicate column name")
    }
  }
  if drop {
    guard table.columns.length() > 1 &&
      table.columns[index].primary == 0 &&
      !table.unique_keys.any(key => key.contains(index)) else {
      fail("cannot drop PRIMARY KEY or UNIQUE column")
    }
  }
  let rename : Rename = {
    store: original,
    table: name,
    new_table,
    column,
    new_column,
    referenced: false,
  }
  let objects = original.objects.map(o => {
    let next = rename_object(rename, o)
    let sql = migration_sql(o.sql, rename, o.table, o.kind, drop, quoted)
    ignore(next)
    guard parse_statement(lex(sql)) is CreateObject(parsed, _) else {
      fail("invalid migrated schema object")
    }
    parsed
  })
  if drop {
    guard !rename.referenced else { fail("cannot drop referenced column") }
  }
  let tables : Array[Table] = []
  for t in original.tables {
    let scope = [(t.name, t.name)]
    let checks = t.checks.map(e => rename_expr(rename, e, scope))
    let foreign_keys = t.foreign_keys.map(fk => {
      let targets = fk.targets.map(names => {
        names.map(n => rename_column_name(rename, fk.parent, n))
      })
      let target = rename_column_name(rename, fk.parent, fk.target)
      if drop &&
        identifier(t.name) == identifier(name) &&
        foreign_columns(fk).contains(index) {
        rename.referenced = true
      }
      let columns = if drop && identifier(t.name) == identifier(name) {
        fk.columns.map(cols => cols.map(i => if i > index { i - 1 } else { i }))
      } else {
        fk.columns
      }
      {
        ..fk,
        parent: rename_table_name(rename, fk.parent),
        target,
        targets,
        columns,
        column: if drop &&
          identifier(t.name) == identifier(name) &&
          fk.column > index {
          fk.column - 1
        } else {
          fk.column
        },
      }
    })
    if drop {
      guard !rename.referenced else { fail("cannot drop referenced column") }
    }
    let own = identifier(t.name) == identifier(name)
    let columns = t.columns
      .mapi((i, c) => (i, c))
      .filter(p => !drop || !own || p.0 != index)
      .map(p => {
        ..p.1,
        name: if own && p.0 == index {
          new_column
        } else {
          p.1.name
        },
      })
    let next = {
      ..t,
      name: if own {
        new_table
      } else {
        t.name
      },
      columns,
      checks,
      foreign_keys,
      unique_keys: if drop && own {
        t.unique_keys.map(key => key.map(i => if i > index { i - 1 } else { i }))
      } else {
        t.unique_keys
      },
      rows: if drop && own {
        row_pages(
          t.rows.map(row => {
            ..row,
            values: row.values
            .mapi((i, v) => (i, v))
            .filter(p => p.0 != index)
            .map(p => p.1),
          }),
        )
      } else {
        t.rows
      },
    }
    tables.push({
      ..next,
      sql: migration_sql(t.sql, rename, t.name, "table", drop, quoted),
    })
  }
  store.tables.clear()
  for t in tables {
    store.tables.push(t)
  }
  store.objects.clear()
  for o in objects {
    store.objects.push(o)
  }
  schema_changed(store)
  validate_image(store)
  for o in store.objects {
    if o.kind == "view" && o.selection is Some(s) {
      ignore(selection_template(s, evaluation(store, [], [])))
    }
    if o.kind == "trigger" {
      prepare_trigger(store, get_table(store, o.table), o)
    }
  }
}

// Source: migration_sql.mbt

///|
/// Rewrite identifier spans, retaining unrelated DDL tokens for schema signatures.
fn migration_sql(
  sql : String,
  r : Rename,
  owner : String,
  kind : String,
  drop : Bool,
  quoted : Bool,
) -> String raise SqlError {
  let p = lex(sql)
  let tokens = p.tokens
  let replacements : Map[Int32, (Int32, String)] = Map([])
  if drop && kind == "table" && identifier(owner) == identifier(r.table) {
    let mut depth = 0
    let mut start = -1
    let mut previous_comma = -1
    for i, token in tokens {
      if token.word == "(" {
        depth += 1
        if depth == 1 {
          start = i + 1
        }
      } else if token.word == ")" {
        depth -= 1
      }
      if start >= 0 &&
        ((token.word == "," && depth == 1) || (token.word == ")" && depth == 0)) {
        if start < i && identifier(tokens[start].word) == identifier(r.column) {
          let a = if token.word == "," {
            tokens[start].start
          } else {
            tokens[previous_comma].start
          }
          let b = if token.word == "," { token.end } else { token.start }
          return @utf8.decode_lossy(p.source[0:a]) +
            @utf8.decode_lossy(p.source[b:])
        }
        previous_comma = i
        start = i + 1
      }
    }
    fail("missing column definition")
  }
  let reference_owner : Map[Int32, String] = Map([])
  for i, token in tokens {
    if identifier(token.word) == "references" &&
      i + 2 < tokens.length() &&
      tokens[i + 2].word == "(" {
      let mut j = i + 3
      while j < tokens.length() && tokens[j].word != ")" {
        if tokens[j].kind == 0 || tokens[j].kind == 2 {
          reference_owner[tokens[j].start] = tokens[i + 1].word
        }
        j += 1
      }
    }
  }
  let aliases : Map[String, String] = Map([])
  // CHECK/index expressions may qualify columns by their owning table without
  // a FROM clause. Keep stored SQL and the renamed expression tree consistent.
  if kind == "table" || kind == "index" {
    aliases[identifier(owner)] = owner
  }
  for i, token in tokens {
    if ["from", "join", "into", "update"].contains(identifier(token.word)) &&
      i + 1 < tokens.length() {
      let table = tokens[i + 1].word
      if ["of", "on"].contains(identifier(table)) {
        continue
      }
      aliases[identifier(table)] = table
      if i + 3 < tokens.length() && identifier(tokens[i + 2].word) == "as" {
        aliases[identifier(tokens[i + 3].word)] = table
      }
    }
  }
  aliases["old"] = owner
  aliases["new"] = owner
  let explicit_aliases : Array[String] = []
  for i, token in tokens {
    if identifier(token.word) == "as" && i + 1 < tokens.length() {
      explicit_aliases.push(identifier(tokens[i + 1].word))
    }
  }
  let mut segment_start = 0
  for i, token in tokens {
    if token.word == ";" || identifier(token.word) == "begin" {
      segment_start = i + 1
    }
    if token.kind != 0 && token.kind != 2 {
      continue
    }
    let previous = if i > 0 { identifier(tokens[i - 1].word) } else { "" }
    let next = if i + 1 < tokens.length() { tokens[i + 1].word } else { "" }
    let name = identifier(token.word)
    if r.column == "" {
      if name != identifier(r.table) {
        continue
      }
      let qualified = next == "." && !explicit_aliases.contains(name)
      let table_position = [
        "table", "references", "from", "join", "into", "update", "on",
      ].contains(previous)
      if qualified || table_position {
        replacements[token.start] = (token.end, sql_name(r.new_table))
      }
      continue
    }
    if name != identifier(r.column) {
      continue
    }
    let mut target = ""
    if previous == "." && i >= 2 {
      target = aliases.get(identifier(tokens[i - 2].word)).unwrap_or("")
    } else {
      target = if kind == "index" || kind == "table" { owner } else { "" }
      // Table/index expressions belong to their declared owner. In particular,
      // REFERENCES ... ON UPDATE CASCADE is not an UPDATE statement scope.
      let mut j = if kind == "table" || kind == "index" {
        tokens.length()
      } else {
        segment_start
      }
      while j < tokens.length() &&
            tokens[j].word != ";" &&
            identifier(tokens[j].word) != "end" {
        let word = identifier(tokens[j].word)
        if ["from", "join", "into", "update"].contains(word) &&
          j + 1 < tokens.length() &&
          !["of", "on"].contains(identifier(tokens[j + 1].word)) {
          target = tokens[j + 1].word
          break
        }
        j += 1
      }
      if kind == "trigger" &&
        i < tokens.length() &&
        !tokens[0:i].iter().any(t => identifier(t.word) == "begin") {
        target = owner
      }
      if kind == "table" {
        // REFERENCES column lists belong to the parent, not the owning table.
        let mut k = i - 1
        while k >= 0 && tokens[k].word != "," && tokens[k].word != "(" {
          k -= 1
        }
        if k >= 2 &&
          tokens[k].word == "(" &&
          identifier(tokens[k - 2].word) == "references" {
          target = tokens[k - 1].word
        }
      }
    }
    if reference_owner.get(token.start) is Some(parent) {
      target = parent
    }
    if identifier(target) == identifier(r.table) &&
      previous != "collate" &&
      next != "(" {
      replacements[token.start] = (
        token.end,
        if quoted || token.kind == 2 {
          sql_name(r.new_column)
        } else {
          r.new_column
        },
      )
    }
  }
  let out = @buffer.Buffer()
  let mut cursor = 0
  for token in tokens {
    if replacements.get(token.start) is Some((end, text)) {
      out.write_bytes(p.source[cursor:token.start].to_owned())
      out.write_bytes(@utf8.encode(text))
      cursor = end
    }
  }
  out.write_bytes(p.source[cursor:].to_owned())
  @utf8.decode_lossy(out.to_bytes())
}

// Source: model.mbt

///|
/// SQLite storage classes. Int64 values never pass through a JavaScript Number.
#derive(Eq)
pub(all) enum Value {
  Null
  Integer(Int64)
  Real(Double)
  Text(String)
  Blob(Bytes)
}

///|
/// Triggers have their own SQLite schema namespace. Prefix both domains so
/// quoted object names cannot collide with the internal namespace marker.
fn schema_name_key(kind : String, name : String) -> String {
  (if kind == "trigger" { "trigger:" } else { "object:" }) + identifier(name)
}

///|
#derive(ToJson)
priv enum Expr {
  Literal(Value)
  TruthLiteral(Bool)
  CurrentTime(String)
  Parameter(Int32)
  Column(String, String)
  Star(String)
  Unary(String, Expr)
  Binary(String, Expr, Expr)
  Call(String, Array[Expr])
  Collate(Expr, String)
  Cast(Expr, String)
  RowNumber(Array[Ordering])
  Window(String, Array[Expr], Array[Expr], Array[Ordering], WindowFrame)
  Between(Expr, Expr, Expr)
  Case(Expr?, Array[(Expr, Expr)], Expr)
  InSelect(Expr, Selection)
  ScalarSelect(Selection)
  Exists(Selection)
}

///|
#derive(ToJson)
priv struct Ordering {
  expression : Expr
  descending : Bool
}

///|
#derive(ToJson)
priv struct Projection {
  expression : Expr
  explicit_label : Bool
  label : String
}

///|
priv struct Source {
  name : String
  qualifier : String
  left : Bool
  right : Bool?
  using_columns : Array[String]?
  natural : Bool?
  on : Expr
}

///|
priv struct Selection {
  ctes : Array[(String, Selection)]
  projections : Array[Projection]
  sources : Array[Source]
  predicate : Expr
  groups : Array[Expr]
  having : Expr
  orders : Array[Ordering]
  limit : Expr
  offset : Expr
  distinct : Bool
  compound : Array[(String, Selection)]?
  recursive : Bool?
  cte_names : Array[(String, Array[String])]?
}

///|
priv struct ForeignKey {
  column : Int32
  parent : String
  target : String
  cascade : Bool
  columns : Array[Int32]?
  targets : Array[String]?
  delete_action : String?
  update_action : String?
  initially_deferred : Bool?
}

///|
priv struct ColumnDef {
  name : String
  declared : String
  not_null : Bool
  mut primary : Int32
  primary_desc : Bool?
  default_value : Expr
  mut default_source : String?
  collation : String
}

///|
#derive(ToJson, FromJson)
priv struct StoredRow {
  id : Int64
  // Published row values are immutable. DML and DDL replace the row to retain
  // rollback / clone isolation without copying every unrelated value array.
  values : Array[Value]
}

///|
priv struct Table {
  name : String
  mut sql : String
  columns : Array[ColumnDef]
  unique_keys : Array[Array[Int32]]
  checks : Array[Expr]
  foreign_keys : Array[ForeignKey]
  without_rowid : Bool
  strict : Bool?
  autoincrement : Bool
  mut sequence : Int64
  mut sequence_present : Bool?
  mut rows : RowPages
}

///|
priv struct SchemaObject {
  kind : String
  name : String
  table : String
  sql : String
  unique : Bool
  columns : Array[String]
  query : String
  mut selection : Selection?
  index_terms : Array[Ordering]?
  index_predicate : Expr?
  trigger : TriggerDefinition?
}

///|
priv struct Store {
  mut encoding : Int32?
  tables : Array[Table]
  objects : Array[SchemaObject]
  mut cookie : Int32
  mut changes : Int32
  mut last_rowid : Int64
  mut foreign_keys : Bool
  mut deferred : Bool
  // Derived, bounded execution state; excluded from images and compiled artifacts.
  primary_indexes : Map[String, PrimaryIndex]
  indexes : Map[String, CachedIndex]
  declaration_sources : Map[String, Array[String]]
  generated_plans : Map[String, GeneratedPlan]
  mut dirty : DirtyState
  transactions : TransactionRuntime
  triggers : TriggerRuntime
}

///|
/// Opaque connection; only the SQL engine owns and mutates its state.
struct Database {
  mut store : Store
  mut serial : Int32
  // Connection-local schema generation; never serialized or restored from cookie.
  mut schema_epoch : Int64
}

///|
priv struct Insertion {
  table : String
  columns : Array[String]
  values : Array[Array[Expr]]
  conflict : String
  target : Array[String]
  updates : Array[(String, Expr)]
  predicate : Expr
  returning : Array[Projection]
  conflict_override : String?
  target_predicate : Expr?
  selection : Selection?
}

///|
#derive(ToJson)
priv enum DataStatement {
  PreparedTransaction(String, String)
  PreparedSelect(Selection)
  PreparedPragma(String, String)
  PreparedInsert(Insertion)
  PreparedUpdate(String, Array[(String, Expr)], Expr, Array[Projection])
  PreparedDelete(String, Expr, Array[Projection])
}

///|
priv enum ParsedStatement {
  Transaction(String, String)
  CreateTable(Table, Bool)
  CreateTableAs(String, Selection, Bool)
  CreateObject(SchemaObject, Bool)
  Drop(String, String, Bool)
  Insert(Insertion)
  Update(String, Array[(String, Expr)], Expr, Array[Projection])
  Delete(String, Expr, Array[Projection])
  Select(Selection)
  Pragma(String, String, Expr?)
  AddColumn(String, ColumnDef, String)
  RenameColumn(String, String, String, Bool)
  RenameTable(String, String)
  DropColumn(String, String)
}

///|
priv suberror SqlError {
  SqlError(String)
  TriggerIgnore
  TriggerAbort(String)
}

///|
fn[X] fail(message : String) -> X raise SqlError {
  raise SqlError(message)
}

///|
fn yes() -> Expr {
  Literal(Integer(1L))
}

///|
fn identifier(value : String) -> String {
  let mut uppercase = false
  for c in value.iter() {
    if c >= 'A' && c <= 'Z' {
      uppercase = true
      break
    }
  }
  if !uppercase {
    return value
  }
  let b = @utf8.encode(value)
  @utf8.decode_lossy(
    Bytes::from_array(
      b
      .to_array()
      .map(c => {
        let n = c.to_int()
        if n >= 65 && n <= 90 {
          (n + 32).to_byte()
        } else {
          c
        }
      }),
    ),
  )
}

///|
fn matches_identifier(value : String, normalized : String) -> Bool {
  value == normalized || identifier(value) == normalized
}

///|
fn get_table(store : Store, name : String) -> Table raise SqlError {
  let key = identifier(name)
  for table in store.tables {
    if matches_identifier(table.name, key) {
      return table
    }
  }
  fail("no such table: " + name)
}

///|
fn column_index(table : Table, name : String) -> Int32 raise SqlError {
  let key = identifier(name)
  for i, column in table.columns {
    if matches_identifier(column.name, key) {
      return i
    }
  }
  fail("no such column: " + name)
}

///|
fn value_json(value : Value) -> Json {
  match value {
    Null => { "t": "null" }
    Integer(n) => { "t": "integer", "v": n.to_string() }
    Real(n) =>
      {
        "t": "real",
        "v": if !n.is_finite() {
          Json::string(if n < 0.0 { "-Infinity" } else { "Infinity" })
        } else if n.reinterpret_as_uint64() == 0x8000000000000000UL {
          Json::number(n, repr="-0.0")
        } else {
          Json::number(n)
        },
      }
    Text(s) => { "t": "text", "v": s }
    Blob(b) => { "t": "blob", "v": b.to_array().map(c => c.to_int()) }
  }
}

///|
fn json_value(value : Json) -> Value raise {
  match value {
    { "t": "null", .. } => Null
    { "t": "integer", "v": String(s), .. } => Integer(@string.parse_int64(s))
    { "t": "real", "v": Number(n, ..), .. } => sql_real(n)
    { "t": "text", "v": String(s), .. } => Text(s)
    { "t": "blob", "v": Array(a), .. } => {
      let bytes = @buffer.Buffer()
      for n in a {
        guard n is Number(n, ..) &&
          n >= 0 &&
          n <= 255 &&
          n.to_int().to_double() == n else {
          fail("invalid blob binding")
        }
        bytes.write_byte(n.to_int().to_byte())
      }
      Blob(bytes.to_bytes())
    }
    _ => fail("invalid SQL binding")
  }
}

///|
pub fn database_open() -> Database {
  {
    serial: 0,
    schema_epoch: 0L,
    store: {
      encoding: None,
      tables: [],
      objects: [],
      cookie: 0,
      changes: 0,
      last_rowid: 0L,
      foreign_keys: true,
      deferred: false,
      indexes: Map([]),
      primary_indexes: Map([]),
      declaration_sources: Map([]),
      generated_plans: Map([]),
      dirty: dirty_state(),
      transactions: transaction_runtime(),
      triggers: trigger_runtime(),
    },
  }
}

///|
/// A versioned logical image, not a SQLite database file.
pub fn database_dump(db : Database) -> String {
  let state = @json.to_json(db.store)
  ({ "format": "moon-sql@1", "state": state } : Json).stringify()
}

///|
/// Decode before replacing the connection; malformed images leave it unchanged.
pub fn database_restore(db : Database, image : String) -> String {
  try {
    guard @json.parse(image) is { "format": "moon-sql@1", "state": state, .. } else {
      fail("unsupported Moon SQL image")
    }
    let restored : Store = @json.from_json(state)
    validate_image(restored, storage=true)
    db.store = restored
    db.schema_epoch += 1L
    "{}"
  } catch {
    e =>
      (
        {
          "error": match e {
            SqlError(message) => message
            _ => e.to_string()
          },
        } : Json).stringify()
  }
}

///|
pub fn database_version(db : Database) -> Int32 {
  db.store.cookie
}

///|
/// Transaction checkpoints copy mutable containers, sharing immutable row values.
fn copy_store(store : Store) -> Store {
  {
    ..store,
    tables: store.tables.map(t => {
      ..t,
      rows: t.rows.fork(),
      columns: t.columns.map(c => { ..c, }),
    }),
    objects: store.objects.copy(),
    indexes: Map([]),
    primary_indexes: Map(
      store.primary_indexes.to_array().map(pair => (pair.0, { ..pair.1, })),
    ),
    declaration_sources: Map(store.declaration_sources.to_array()),
    generated_plans: if FEATURE_GENERATED_COLUMNS {
      Map(store.generated_plans.to_array())
    } else {
      Map([])
    },
    dirty: { ..store.dirty, edits: store.dirty.edits.copy(), },
    transactions: {
      frames: store.transactions.frames.copy(),
      explicit: store.transactions.explicit,
    },
    triggers: {
      ..trigger_runtime(),
      clock: store.triggers.clock,
      recursive: store.triggers.recursive,
      failed_statement: store.triggers.failed_statement,
    },
  }
}

///|
pub fn database_clone(db : Database) -> Database {
  {
    store: copy_store(db.store),
    serial: db.serial,
    schema_epoch: db.schema_epoch,
  }
}

///|
pub fn database_serial(db : Database) -> Int32 {
  db.serial
}

///|
fn insertion_column(table : Table, name : String) -> Int32 raise SqlError {
  let key = identifier(name)
  for i, col in table.columns {
    if identifier(col.name) == key {
      guard !FEATURE_GENERATED_COLUMNS || !generated_column(col) else {
        fail("cannot write generated column: " + name)
      }
      return i
    }
  }
  if !table.without_rowid && ["rowid", "_rowid_", "oid"].contains(key) {
    return -1
  }
  fail("no such column: " + name)
}

///|
#derive(ToJson, FromJson)
priv enum FiniteValue {
  Null
  Integer(Int64)
  Real(Double)
  Text(String)
  Blob(Bytes)
}

///|
impl @json.ToJson for Value with fn to_json(self) {
  let legacy : FiniteValue = match self {
    Null => Null
    Integer(n) => Integer(n)
    Real(n) => {
      if n.reinterpret_as_uint64() == 0x8000000000000000UL {
        // Nested JSON parse/stringify (AOT journal envelopes, JS hosts) may
        // normalize numeric -0. Use the same tagged extension as infinity.
        return [Json::string("Real"), Json::string("-0")]
      }
      if !n.is_finite() {
        return [
          Json::string("Real"),
          Json::string(if n < 0.0 { "-Infinity" } else { "Infinity" }),
        ]
      }
      Real(n)
    }
    Text(s) => Text(s)
    Blob(b) => Blob(b)
  }
  @json.to_json(legacy)
}

///|
impl @json.FromJson for Value with fn from_json(json, path) {
  if json is Array([String("Real"), String("-0")]) {
    return Real(0x8000000000000000UL.reinterpret_as_double())
  }
  if json is Array([String("Real"), String("Infinity")]) {
    return Real(0x7ff0000000000000UL.reinterpret_as_double())
  }
  if json is Array([String("Real"), String("-Infinity")]) {
    return Real(0xfff0000000000000UL.reinterpret_as_double())
  }
  let legacy : FiniteValue = @json.from_json(json, path~)
  match legacy {
    Null => Null
    Integer(n) => Integer(n)
    Real(n) => {
      guard !n.is_nan() else {
        raise @json.JsonDecodeError((path, "invalid stored REAL"))
      }
      Real(n)
    }
    Text(s) => Text(s)
    Blob(b) => Blob(b)
  }
}

///|
/// Transfer only connection-local counters when a host restores a data clone.
/// No schema, rows, transaction frames, persistence serial or caches are copied.
pub fn database_copy_connection_state(
  target : Database,
  source : Database,
) -> Unit {
  target.store.last_rowid = source.store.last_rowid
  target.store.changes = source.store.changes
  target.store.triggers.failed_statement = source.store.triggers.failed_statement
}

// Source: optimizer_config.mbt

///|
// Optional execution shortcuts; semantic evaluators remain as fallbacks.
const OPT_POINT_PROJECTION : Bool = true

///|
const OPT_SIMPLE_SCAN : Bool = true

///|
const OPT_SECONDARY_RANGE : Bool = false

///|
const OPT_AGGREGATE_SCAN : Bool = true

///|
const OPT_JSON_TABLE_AGGREGATE : Bool = false

///|
const OPT_UPDATE_FROM_LOOKUP : Bool = false

///|
const OPT_ROW_METADATA : Bool = false

///|
const OPT_IN_LIST_LOOKUP : Bool = true

///|
const OPT_IN_SELECT_LOOKUP : Bool = true

// Source: ordering.mbt

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

// Source: output_policy.mbt

///|
/// Never substitute a replacement character for bytes SQLite would retain.
/// The portable TEXT contract contains Unicode strings, not arbitrary byte text.
fn checked_text_value(value : Value) -> String raise SqlError {
  match value {
    Blob(bytes) =>
      @utf8.decode(bytes) catch {
        _ => fail("unsupported SQL: non-UTF-8 BLOB to TEXT conversion")
      }
    _ => text_value(value)
  }
}

///|
fn validate_collation(name : String) -> Unit raise SqlError {
  guard ["binary", "nocase", "rtrim"].contains(name) else {
    fail("unsupported SQL collation: " + name)
  }
}

///|
fn extremum_aggregate(e : Expr) -> Bool {
  if !CAP_FUNCTION_AGGREGATES {
    return false
  }
  match e {
    Call("min", [_]) | Call("max", [_]) => true
    Call(_, args) => args.any(extremum_aggregate)
    Unary(_, e) | Collate(e, _) | Cast(e, _) => extremum_aggregate(e)
    Binary(_, a, b) => extremum_aggregate(a) || extremum_aggregate(b)
    Between(e, a, b) =>
      extremum_aggregate(e) || extremum_aggregate(a) || extremum_aggregate(b)
    Case(base, arms, other) =>
      base.map(extremum_aggregate).unwrap_or(false) ||
      arms.any(p => extremum_aggregate(p.0) || extremum_aggregate(p.1)) ||
      extremum_aggregate(other)
    Window(_, args, parts, orders, _) =>
      args.any(extremum_aggregate) ||
      parts.any(extremum_aggregate) ||
      orders.any(o => extremum_aggregate(o.expression))
    RowNumber(orders) => orders.any(o => extremum_aggregate(o.expression))
    _ => false
  }
}

///|
/// Aggregate arguments have their own per-row scope. Outside them, only group
/// expressions or a verified MIN/MAX representative are accepted.
fn validate_group_output(
  e : Expr,
  groups : Array[Expr],
  extremes : Bool,
  representative : Bool,
  context : Evaluation,
) -> Unit raise SqlError {
  if !extremes && groups.any(g => @json.to_json(g) == @json.to_json(e)) {
    return
  }
  match e {
    Column(_, _) | Star(_) =>
      if !representative {
        fail("unsupported SQL: bare column in aggregate output")
      }
    TruthLiteral(value) =>
      if !representative &&
        find_context(context, "", if value { "true" } else { "false" })
        is Some(_) {
        fail("unsupported SQL: bare column in aggregate output")
      }
    Call(name, args) =>
      if !aggregate_name(name, args.length()) {
        for arg in args {
          validate_group_output(arg, groups, extremes, representative, context)
        }
      }
    Unary(_, e) | Collate(e, _) | Cast(e, _) =>
      validate_group_output(e, groups, extremes, representative, context)
    Binary(_, a, b) => {
      validate_group_output(a, groups, extremes, representative, context)
      validate_group_output(b, groups, extremes, representative, context)
    }
    Between(e, a, b) => {
      validate_group_output(e, groups, extremes, representative, context)
      validate_group_output(a, groups, extremes, representative, context)
      validate_group_output(b, groups, extremes, representative, context)
    }
    Case(base, arms, other) => {
      if base is Some(e) {
        validate_group_output(e, groups, extremes, representative, context)
      }
      for (a, b) in arms {
        validate_group_output(a, groups, extremes, representative, context)
        validate_group_output(b, groups, extremes, representative, context)
      }
      validate_group_output(other, groups, extremes, representative, context)
    }
    Window(_, args, partitions, orders, _) => {
      for arg in args {
        validate_group_output(arg, groups, extremes, representative, context)
      }
      for p in partitions {
        validate_group_output(p, groups, extremes, representative, context)
      }
      for order in orders {
        validate_group_output(
          order.expression,
          groups,
          extremes,
          representative,
          context,
        )
      }
    }
    RowNumber(orders) =>
      for o in orders {
        validate_group_output(
          o.expression,
          groups,
          extremes,
          representative,
          context,
        )
      }
    ScalarSelect(_) | InSelect(_, _) | Exists(_) =>
      fail("unsupported SQL: subquery in aggregate output")
    _ => ()
  }
}

///|
fn validate_aggregate_output(
  select : Selection,
  context : Evaluation,
) -> Unit raise SqlError {
  if CAP_QUERY_GROUP_BY ||
    CAP_FUNCTION_AGGREGATES ||
    CAP_FUNCTION_GROUP_CONCAT ||
    CAP_FUNCTION_JSON_AGGREGATE {
    validate_grouped_selection(select, context)
  } else {
    guard select.groups.is_empty() else {
      fail("catalog capability disabled: query groupBy")
    }
    guard select.having is Literal(Integer(1L)) else {
      fail("unsupported SQL: aggregate context outside aggregate SELECT")
    }
  }
}

///|
fn validate_grouped_selection(
  select : Selection,
  context : Evaluation,
) -> Unit raise SqlError {
  let grouped = !select.groups.is_empty() ||
    select.projections.any(p => aggregate(p.expression))
  if !grouped {
    guard select.having is Literal(Integer(1L)) &&
      !select.orders.any(o => aggregate(o.expression)) else {
      fail("unsupported SQL: aggregate context outside aggregate SELECT")
    }
    return
  }
  let extremes = select.projections.any(p => extremum_aggregate(p.expression)) ||
    extremum_aggregate(select.having) ||
    select.orders.any(o => extremum_aggregate(o.expression))
  let representative = CAP_QUERY_AGGREGATE_REPRESENTATIVE &&
    aggregate_representative_plan(select) is Some(_)
  for p in select.projections {
    validate_group_output(
      p.expression,
      select.groups,
      extremes,
      representative,
      context,
    )
  }
  validate_group_output(
    select.having,
    select.groups,
    extremes,
    representative,
    context,
  )
  for o in select.orders {
    if o.expression is Column("", name) {
      let aliases = select.projections.filter(p => {
        identifier(p.label) == identifier(name)
      })
      if aliases.length() == 1 {
        validate_group_output(
          aliases[0].expression,
          select.groups,
          extremes,
          representative,
          context,
        )
        continue
      }
    }
    validate_group_output(
      o.expression,
      select.groups,
      extremes,
      representative,
      context,
    )
  }
}

///|
/// Raw BLOB reads remain possible through physical projection. Expression
/// coercions in UTF-16 databases need byte-encoding provenance we do not retain.
fn expression_value(value : Value, store : Store) -> Value raise SqlError {
  if store.encoding.unwrap_or(1) != 1 && value is Blob(_) {
    fail("unsupported SQL: BLOB expression coercion in UTF-16 database")
  }
  value
}

// Source: parser.mbt

///|
/// Tokens retain byte offsets so SQLite's unaliased result labels are preserved.
priv struct Token {
  word : String
  kind : Int32
  start : Int32
  end : Int32
}

///|
priv struct Parser {
  source : Bytes
  tokens : Array[Token]
  mut position : Int32
  mut parameter : Int32
  mut derived : Int32
  parameter_names : Map[String, Int32]
  mut depth : Int32
}

///|
fn sql_digit(c : Byte, hex : Bool) -> Int32 {
  if c >= b'0' && c <= b'9' {
    c.to_int() - 48
  } else if hex && c >= b'a' && c <= b'f' {
    c.to_int() - 87
  } else if hex && c >= b'A' && c <= b'F' {
    c.to_int() - 55
  } else {
    -1
  }
}

///|
/// Separators belong to SQL source only, never numeric TEXT conversion.
fn sql_digits(bytes : Bytes, start : Int32, hex : Bool) -> Int32 raise SqlError {
  let mut i = start
  while i < bytes.length() {
    if sql_digit(bytes[i], hex) >= 0 {
      i += 1
    } else if bytes[i] == b'_' {
      guard i > start &&
        i + 1 < bytes.length() &&
        sql_digit(bytes[i - 1], hex) >= 0 &&
        sql_digit(bytes[i + 1], hex) >= 0 else {
        fail("invalid SQL numeric separator")
      }
      i += 1
    } else {
      break
    }
  }
  i
}

///|
fn sql_number(text : String) -> Value raise SqlError {
  let bytes = @utf8.encode(text)
  if bytes.length() >= 2 &&
    bytes[0] == b'0' &&
    (bytes[1] == b'x' || bytes[1] == b'X') {
    let mut number = 0UL
    for i in 2..<bytes.length() {
      guard number <= 0x0FFFFFFFFFFFFFFFUL else { fail("hex literal too big") }
      number = (number << 4) | sql_digit(bytes[i], true).to_uint64()
    }
    Integer(number.reinterpret_as_int64())
  } else {
    parse_number(text)
  }
}

///|
fn sql_integer_min(e : Expr) -> Bool {
  match e {
    Literal(Integer(-9223372036854775808L)) => true
    Unary("+", e) => sql_integer_min(e)
    _ => false
  }
}

///|
fn lex(sql : String) -> Parser raise SqlError {
  let bytes = @utf8.encode(sql)
  guard !bytes.to_array().contains(b'\x00') else {
    fail("SQL source contains NUL")
  }
  guard bytes.length() <= 1048576 else { fail("SQL resource limit") }
  let tokens : Array[Token] = []
  let mut i = 0
  while i < bytes.length() {
    let start = i
    let c = bytes[i].to_int()
    if c <= 32 {
      i += 1
      continue
    }
    if c == 45 && i + 1 < bytes.length() && bytes[i + 1] == b'-' {
      while i < bytes.length() && bytes[i] != b'\n' {
        i += 1
      }
      continue
    }
    if c == 47 && i + 1 < bytes.length() && bytes[i + 1] == b'*' {
      i += 2
      while i + 1 < bytes.length() &&
            !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
        i += 1
      }
      guard i + 1 < bytes.length() else { fail("unterminated SQL comment") }
      i += 2
      continue
    }
    if c == 39 || c == 34 || c == 96 || c == 91 {
      let end = if c == 91 { 93 } else { c }
      i += 1
      let b = @buffer.Buffer()
      let mut closed = false
      while i < bytes.length() {
        let ch = bytes[i]
        i += 1
        if ch.to_int() == end {
          if end != 93 && i < bytes.length() && bytes[i].to_int() == end {
            b.write_byte(ch)
            i += 1
          } else {
            closed = true
            break
          }
        } else {
          b.write_byte(ch)
        }
      }
      guard closed else { fail("unterminated SQL quote") }
      tokens.push({
        word: @utf8.decode_lossy(b.to_bytes()),
        kind: if c == 39 {
          1
        } else {
          2
        },
        start,
        end: i,
      })
    } else if c == 58 || c == 64 || c == 36 {
      i += 1
      let mut count = 0
      while i < bytes.length() {
        let ch = bytes[i].to_int()
        if (ch >= 65 && ch <= 90) ||
          (ch >= 97 && ch <= 122) ||
          (ch >= 48 && ch <= 57) ||
          ch == 95 ||
          ch == 36 ||
          ch >= 128 {
          count += 1
          i += 1
        } else if ch == 58 && i + 1 < bytes.length() && bytes[i + 1] == b':' {
          i += 2
        } else if ch == 40 && count > 0 {
          i += 1
          while i < bytes.length() && bytes[i] != b')' && bytes[i].to_int() > 32 {
            i += 1
          }
          guard i < bytes.length() && bytes[i] == b')' else {
            fail("invalid SQL parameter")
          }
          i += 1
          break
        } else {
          break
        }
      }
      guard count > 0 else { fail("invalid SQL parameter") }
      tokens.push({
        word: @utf8.decode_lossy(bytes[start:i]),
        kind: 5,
        start,
        end: i,
      })
    } else if (c >= 48 && c <= 57) ||
      (
        c == 46 &&
        i + 1 < bytes.length() &&
        bytes[i + 1] >= b'0' &&
        bytes[i + 1] <= b'9'
      ) {
      // ?NNN uses decimal digits without separators or other literal syntax.
      let parameter = !tokens.is_empty() &&
        tokens[tokens.length() - 1].word == "?" &&
        tokens[tokens.length() - 1].end == start
      if parameter {
        while i < bytes.length() && bytes[i] >= b'0' && bytes[i] <= b'9' {
          i += 1
        }
      } else if c == 48 &&
        i + 1 < bytes.length() &&
        (bytes[i + 1] == b'x' || bytes[i + 1] == b'X') {
        i = sql_digits(bytes, i + 2, true)
        guard i > start + 2 else { fail("invalid SQL hex literal") }
      } else {
        i = sql_digits(bytes, i, false)
        if i < bytes.length() && bytes[i] == b'.' {
          i += 1
          i = sql_digits(bytes, i, false)
        }
        if i < bytes.length() && (bytes[i] == b'e' || bytes[i] == b'E') {
          i += 1
          if i < bytes.length() && (bytes[i] == b'+' || bytes[i] == b'-') {
            i += 1
          }
          let first = i
          i = sql_digits(bytes, i, false)
          guard i > first else { fail("invalid SQL numeric exponent") }
        }
      }
      if !parameter && i < bytes.length() {
        let n = bytes[i].to_int()
        guard !((n >= 65 && n <= 90) ||
          (n >= 97 && n <= 122) ||
          n == 95 ||
          n >= 128) else {
          fail("invalid SQL number")
        }
      }
      tokens.push({
        word: @utf8.decode_lossy(bytes[start:i]).replace_all(old="_", new=""),
        kind: 3,
        start,
        end: i,
      })
    } else if (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122) ||
      c == 95 ||
      c >= 128 {
      i += 1
      while i < bytes.length() {
        let n = bytes[i].to_int()
        if (n >= 65 && n <= 90) ||
          (n >= 97 && n <= 122) ||
          (n >= 48 && n <= 57) ||
          n == 95 ||
          n >= 128 {
          i += 1
        } else {
          break
        }
      }
      tokens.push({
        word: @utf8.decode_lossy(bytes[start:i]),
        kind: 0,
        start,
        end: i,
      })
    } else {
      i += 1
      if i < bytes.length() {
        let pair = @utf8.decode_lossy(bytes[start:i + 1])
        if ["<=", ">=", "!=", "<>", "==", "||", "<<", ">>", "->"].contains(pair) {
          i += 1
          if pair == "->" && i < bytes.length() && bytes[i] == b'>' {
            i += 1
          }
        }
      }
      tokens.push({
        word: @utf8.decode_lossy(bytes[start:i]),
        kind: 4,
        start,
        end: i,
      })
    }
    guard tokens.length() <= 10000 else { fail("SQL token resource limit") }
  }
  tokens.push({ word: "", kind: 4, start: i, end: i, })
  {
    source: bytes,
    tokens,
    position: 0,
    parameter: 0,
    derived: 0,
    parameter_names: Map([]),
    depth: 0,
  }
}

///|
fn Parser::peek(p : Parser) -> String {
  let t = p.tokens[p.position]
  if t.kind == 1 || t.kind == 2 {
    "quoted"
  } else {
    identifier(t.word)
  }
}

///|
fn Parser::take(p : Parser, word : String) -> Bool {
  if p.peek() == word {
    p.position += 1
    true
  } else {
    false
  }
}

///|
fn Parser::expect(p : Parser, word : String) -> Unit raise SqlError {
  guard p.take(word) else {
    fail(
      "SQL syntax: expected " + word + ", found " + p.tokens[p.position].word,
    )
  }
}

///|
fn Parser::name(p : Parser) -> String raise SqlError {
  let t = p.tokens[p.position]
  guard t.kind == 0 || t.kind == 2 else {
    fail("SQL syntax: expected identifier")
  }
  p.position += 1
  t.word
}

///|
fn Parser::names(
  p : Parser,
  ordered~ : Bool = false,
  qualifier~ : String = "",
) -> Array[String] raise SqlError {
  p.expect("(")
  let result = []
  while true {
    let first = p.name()
    let name = if qualifier != "" && p.take(".") {
      guard identifier(first) == identifier(qualifier) else {
        fail("unknown conflict target table")
      }
      p.name()
    } else {
      first
    }
    result.push(name)
    if ordered {
      ignore(p.take("asc") || p.take("desc"))
    }
    if !p.take(",") {
      break
    }
  }
  p.expect(")")
  result
}

///|
fn precedence(word : String) -> Int32 {
  match word {
    "or" => 1
    "and" => 2
    "="
    | "=="
    | "!="
    | "<>"
    | "is"
    | "like"
    | "glob"
    | "not"
    | "in"
    | "between" => 3
    "<" | ">" | "<=" | ">=" => 4
    "<<" | ">>" | "&" | "|" => 5
    "+" | "-" => 6
    "*" | "/" | "%" => 7
    "||" | "->" | "->>" => 8
    "collate" => 9
    _ => 0
  }
}

///|
fn Parser::expression(p : Parser, minimum : Int32) -> Expr raise SqlError {
  p.depth += 1
  guard p.depth <= 64 else { fail("SQL expression depth limit") }
  let token = p.tokens[p.position]
  let word = p.peek()
  p.position += 1
  let mut left : Expr = if token.kind == 1 {
    Literal(Text(token.word))
  } else if token.kind == 3 {
    Literal(sql_number(token.word))
  } else if word == "null" {
    Literal(Null)
  } else if word == "true" {
    TruthLiteral(true)
  } else if word == "false" {
    TruthLiteral(false)
  } else if ["current_timestamp", "current_date", "current_time"].contains(word) {
    CurrentTime(
      if word == "current_timestamp" {
        "datetime"
      } else if word == "current_date" {
        "date"
      } else {
        "time"
      },
    )
  } else if token.kind == 5 {
    let index = match p.parameter_names.get(token.word) {
      Some(index) => index
      None => {
        guard p.parameter < 32766 else { fail("SQL parameter limit") }
        let index = p.parameter
        p.parameter += 1
        p.parameter_names[token.word] = index
        index
      }
    }
    Parameter(index)
  } else if word == "?" {
    let mut index = p.parameter
    if p.tokens[p.position].kind == 3 && p.tokens[p.position].start == token.end {
      index = (@string.parse_int(p.tokens[p.position].word) catch {
          _ => fail("invalid SQL parameter")
        }) -
        1
      p.position += 1
    }
    guard index >= 0 && index < 32766 else { fail("SQL parameter limit") }
    p.parameter = (index + 1).max(p.parameter)
    Parameter(index)
  } else if word == "(" {
    let e = if p.peek() == "select" || p.peek() == "with" {
      ScalarSelect(p.selection())
    } else {
      let first = p.expression(1)
      if p.take(",") {
        let fields = [first, p.expression(1)]
        while p.take(",") {
          fields.push(p.expression(1))
        }
        Call("$row", fields)
      } else {
        first
      }
    }
    p.expect(")")
    e
  } else if word == "cast" {
    p.expect("(")
    let value = p.expression(1)
    p.expect("as")
    let names : Array[String] = []
    while p.peek() != ")" && p.peek() != "" {
      names.push(p.name())
    }
    p.expect(")")
    guard !names.is_empty() else { fail("missing CAST type") }
    Cast(value, affinity_name(names.join(" ")))
  } else if word == "exists" {
    p.expect("(")
    let select = p.selection()
    p.expect(")")
    Exists(select)
  } else if word == "case" {
    let base = if p.peek() == "when" { None } else { Some(p.expression(1)) }
    let arms : Array[(Expr, Expr)] = []
    p.expect("when")
    while true {
      let condition = p.expression(1)
      p.expect("then")
      arms.push((condition, p.expression(1)))
      if !p.take("when") {
        break
      }
    }
    let otherwise = if p.take("else") { p.expression(1) } else { Literal(Null) }
    p.expect("end")
    Case(base, arms, otherwise)
  } else if word == "-" &&
    p.tokens[p.position].kind == 3 &&
    p.tokens[p.position].word == "9223372036854775808" {
    p.position += 1
    Literal(Integer(-9223372036854775808L))
  } else if word == "-" || word == "+" || word == "not" || word == "~" {
    let start = p.position
    let e = p.expression(if word == "not" { 3 } else { 10 })
    if word == "-" &&
      sql_integer_min(e) &&
      p.tokens[start:p.position].any(t => {
        t.kind == 3 && identifier(t.word).has_prefix("0x")
      }) {
      fail("hex literal too big")
    }
    Unary(word, e)
  } else if word == "*" {
    Star("")
  } else if word == "x" && p.tokens[p.position].kind == 1 {
    let hex = p.tokens[p.position].word
    p.position += 1
    let hex = @utf8.encode(hex)
    guard hex.length() % 2 == 0 else { fail("invalid blob literal") }
    let b = @buffer.Buffer()
    for i = 0; i < hex.length(); i = i + 2 {
      let n = @string.parse_int(@utf8.decode_lossy(hex[i:i + 2]), base=16) catch {
        _ => fail("invalid blob literal")
      }
      b.write_byte(n.to_byte())
    }
    Literal(Blob(b.to_bytes()))
  } else if token.kind == 0 || token.kind == 2 {
    if p.take("(") {
      guard !token.word.has_prefix("$") && identifier(token.word) != "in" else {
        fail("unsupported SQL reserved function name")
      }
      let arguments : Array[Expr] = []
      let distinct_argument = p.take("distinct")
      let mut aggregate_orders : Array[Ordering] = []
      if !p.take(")") {
        arguments.push(p.expression(1))
        while p.take(",") {
          arguments.push(p.expression(1))
        }
        if p.take("order") {
          guard aggregate_name(identifier(token.word), arguments.length()) &&
            !(arguments[0] is Star(_)) else {
            fail("ORDER BY requires an aggregate argument")
          }
          p.expect("by")
          aggregate_orders = p.orderings()
        }
        p.expect(")")
      }
      if distinct_argument {
        guard arguments.length() == 1 else {
          fail("DISTINCT aggregates require one argument")
        }
        arguments[0] = Call("$distinct", [arguments[0]])
      }
      if !aggregate_orders.is_empty() {
        arguments[0] = Call(
          "$aggregate-order",
          [
            arguments[0],
            ..aggregate_orders.map(o => {
              Call(if o.descending { "$sort-desc" } else { "$sort-asc" }, [
                o.expression,
              ])
            }),
          ],
        )
      }
      if p.take("filter") {
        guard !arguments.is_empty() &&
          aggregate_name(identifier(token.word), arguments.length()) else {
          fail("FILTER may only be used with an aggregate function")
        }
        p.expect("(")
        p.expect("where")
        let predicate = p.expression(1)
        p.expect(")")
        arguments[0] = Call("$filter", [arguments[0], predicate])
      }
      if p.take("over") {
        p.expect("(")
        let partitions : Array[Expr] = []
        if p.take("partition") {
          p.expect("by")
          partitions.push(p.expression(1))
          while p.take(",") {
            partitions.push(p.expression(1))
          }
        }
        let orders = if p.take("order") {
          p.expect("by")
          p.orderings()
        } else {
          []
        }
        let frame = p.window_frame()
        p.expect(")")
        Window(identifier(token.word), arguments, partitions, orders, frame)
      } else {
        Call(identifier(token.word), arguments)
      }
    } else if p.take(".") {
      if p.take("*") {
        Star(token.word)
      } else {
        Column(token.word, p.name())
      }
    } else {
      Column("", token.word)
    }
  } else {
    fail("SQL syntax: unexpected " + token.word)
  }
  while precedence(p.peek()) >= minimum && precedence(p.peek()) > 0 {
    let op = p.peek()
    let prec = precedence(op)
    p.position += 1
    if op == "collate" {
      let name = identifier(p.name())
      guard name == "binary" || name == "nocase" || name == "rtrim" else {
        fail("unsupported SQL collation")
      }
      left = Collate(left, name)
    } else if op == "->" || op == "->>" {
      left = Call(op, [left, p.expression(prec + 1)])
    } else if op == "is" {
      let negate = p.take("not")
      let distinct = p.take("distinct")
      if distinct {
        p.expect("from")
      }
      let op = if negate != distinct { "is not" } else { "is" }
      left = Binary(op, left, p.expression(prec + 1))
    } else if op == "not" ||
      op == "between" ||
      op == "in" ||
      op == "like" ||
      op == "glob" {
      let negate = op == "not"
      let operator = if negate {
        let o = p.peek()
        p.position += 1
        o
      } else {
        op
      }
      let expression = if operator == "between" {
        let low = p.expression(prec + 1)
        p.expect("and")
        Between(left, low, p.expression(prec + 1))
      } else if operator == "in" {
        p.expect("(")
        if p.peek() == "select" || p.peek() == "with" {
          let select = p.selection()
          p.expect(")")
          InSelect(left, select)
        } else {
          let arguments = [left]
          if !p.take(")") {
            arguments.push(p.expression(1))
            while p.take(",") {
              arguments.push(p.expression(1))
            }
            p.expect(")")
          }
          Call("in", arguments)
        }
      } else if operator == "glob" {
        Call("glob", [p.expression(prec + 1), left])
      } else if operator == "like" {
        let pattern = p.expression(prec + 1)
        if p.take("escape") {
          Call("like", [pattern, left, p.expression(5)])
        } else {
          Binary("like", left, pattern)
        }
      } else {
        fail("unsupported SQL NOT operator: " + operator)
      }
      left = if negate { Unary("not", expression) } else { expression }
    } else {
      left = Binary(op, left, p.expression(prec + 1))
    }
  }
  p.depth -= 1
  left
}

///|
fn Parser::orderings(p : Parser) -> Array[Ordering] raise SqlError {
  let orders : Array[Ordering] = []
  while true {
    let expression = p.expression(1)
    let descending = p.take("desc")
    if !descending {
      ignore(p.take("asc"))
    }
    let expression = if p.take("nulls") {
      let first = if p.take("first") {
        true
      } else {
        p.expect("last")
        false
      }
      if first == !descending {
        expression
      } else {
        Call(if first { "$nulls-first" } else { "$nulls-last" }, [expression])
      }
    } else {
      expression
    }
    orders.push({ expression, descending, })
    if !p.take(",") {
      break
    }
  }
  orders
}

///|
fn Parser::projections(p : Parser) -> Array[Projection] raise SqlError {
  let result : Array[Projection] = []
  while true {
    let start = p.tokens[p.position].start
    let expression = p.expression(1)
    let end = p.tokens[p.position - 1].end
    let explicit_label = p.peek() == "as" || p.tokens[p.position].kind == 2
    let label = if p.take("as") {
      p.name()
    } else if p.tokens[p.position].kind == 2 {
      p.name()
    } else {
      match expression {
        Column(_, name) => name
        _ => @utf8.decode_lossy(p.source[start:end])
      }
    }
    result.push({ expression, explicit_label, label, })
    if !p.take(",") {
      break
    }
  }
  result
}

///|
fn Parser::sources(
  p : Parser,
  ctes : Array[(String, Selection)],
  update_from~ : Bool = false,
) -> Array[Source] raise SqlError {
  let sources : Array[Source] = []
  let mut left = false
  let mut right = false
  let mut natural = false
  while true {
    let mut function_name : String? = None
    let arguments : Array[Expr] = []
    let name = if p.take("(") {
      // NUL cannot occur in user SQL identifiers. A parse-local ordinal stays
      // stable when declarations are normalized, renamed, or read back.
      let name = "\u{0}derived:" + p.derived.to_string()
      p.derived += 1
      let query = p.selection()
      p.expect(")")
      ctes.push((name, query))
      name
    } else {
      let name = p.name()
      if p.take("(") {
        guard FEATURE_JSON_TABLE else {
          fail("feature disabled: jsonTableFunctions")
        }
        let fn_name = identifier(name)
        guard ["json_each", "json_tree"].contains(fn_name) else {
          fail("unsupported table-valued function: " + name)
        }
        arguments.push(p.expression(1))
        if p.take(",") {
          arguments.push(p.expression(1))
        }
        p.expect(")")
        function_name = Some(fn_name)
        "\u{0}json:" + fn_name
      } else {
        name
      }
    }
    let qualifier = if p.take("as") {
      p.name()
    } else if p.tokens[p.position].kind == 2 ||
      (
        p.tokens[p.position].kind == 0 &&
        ![
          "where", "order", "group", "having", "limit", "join", "left", "inner",
          "cross", "using", "natural", "right", "full", "outer", "on", "returning",
          "union", "intersect", "except",
        ].contains(p.peek())
      ) {
      p.name()
    } else {
      function_name.unwrap_or(name)
    }
    let has_on = p.take("on")
    if FEATURE_UPDATE_FROM && update_from && sources.is_empty() && has_on {
      fail("JOIN required before ON in UPDATE FROM")
    }
    let on = if has_on {
      guard !natural else { fail("NATURAL join cannot have ON") }
      p.expression(1)
    } else {
      yes()
    }
    let using_columns = if p.take("using") {
      guard !natural && !has_on else {
        fail("USING cannot be combined with ON/NATURAL")
      }
      p.expect("(")
      let names = [p.name()]
      while p.take(",") {
        names.push(p.name())
      }
      p.expect(")")
      Some(names)
    } else {
      None
    }

    if FEATURE_UPDATE_FROM &&
      update_from &&
      sources.is_empty() &&
      using_columns is Some(_) {
      fail("JOIN required before USING in UPDATE FROM")
    }
    sources.push({
      name,
      qualifier,
      left,
      right: if right {
        Some(true)
      } else {
        None
      },
      using_columns,
      natural: if natural {
        Some(true)
      } else {
        None
      },
      on: match function_name {
        Some(fn_name) =>
          Call("$json-table", [
            Literal(Text(fn_name)),
            arguments[0],
            if arguments.length() == 2 {
              arguments[1]
            } else {
              Literal(Text("$"))
            },
            on,
          ])
        None => on
      },
    })
    left = false
    right = false
    natural = p.take("natural")
    if p.take(",") {
      guard !natural else { fail("NATURAL requires JOIN") }
      continue
    }
    if p.take("join") {
      continue
    }
    if p.take("right") || p.take("full") {
      right = true
      left = identifier(p.tokens[p.position - 1].word) == "full"
      ignore(p.take("outer"))
      p.expect("join")
      continue
    }
    if p.take("left") {
      left = true
      ignore(p.take("outer"))
      p.expect("join")
      continue
    }
    if p.take("inner") || p.take("cross") {
      p.expect("join")
      continue
    }
    guard !natural else { fail("NATURAL requires JOIN") }
    break
  }
  sources
}

///|
fn Parser::selection(
  p : Parser,
  arm~ : Bool = false,
) -> Selection raise SqlError {
  p.depth += 1
  guard p.depth <= 16 else { fail("SQL SELECT nesting limit") }
  let ctes : Array[(String, Selection)] = []
  let mut recursive : Bool? = None
  let names : Array[(String, Array[String])] = []
  if !arm && p.take("with") {
    if p.take("recursive") {
      recursive = Some(true)
    }
    while true {
      let name = p.name()
      if p.peek() == "(" {
        names.push((name, p.names()))
      }
      p.expect("as")
      p.expect("(")
      let select = p.selection()
      p.expect(")")
      ctes.push((name, select))
      if !p.take(",") {
        break
      }
    }
  }
  let is_values = p.take("values")
  if !is_values {
    p.expect("select")
  }
  let distinct = if is_values { false } else { p.take("distinct") }
  let projections = if is_values {
    p.expect("(")
    let columns : Array[Projection] = []
    while true {
      columns.push({
        expression: p.expression(1),
        explicit_label: true,
        label: "column" + (columns.length() + 1).to_string(),
      })
      if !p.take(",") {
        break
      }
    }
    p.expect(")")
    columns
  } else {
    p.projections()
  }
  let sources = if p.take("from") { p.sources(ctes) } else { [] }
  let predicate = if p.take("where") { p.expression(1) } else { yes() }
  let groups : Array[Expr] = []
  if p.take("group") {
    p.expect("by")
    groups.push(p.expression(1))
    while p.take(",") {
      groups.push(p.expression(1))
    }
  }
  let having = if p.take("having") { p.expression(1) } else { yes() }
  let compound : Array[(String, Selection)] = []
  if is_values {
    while p.take(",") {
      p.expect("(")
      let cols : Array[Projection] = []
      while true {
        cols.push({
          expression: p.expression(1),
          explicit_label: true,
          label: "column" + (cols.length() + 1).to_string(),
        })
        if !p.take(",") {
          break
        }
      }
      p.expect(")")
      compound.push(
        (
          "union all",
          {
            ctes: [],
            projections: cols,
            sources: [],
            predicate: yes(),
            groups: [],
            having: yes(),
            orders: [],
            limit: Literal(Integer(-1L)),
            offset: Literal(Integer(0L)),
            distinct: false,
            compound: None,
            recursive: None,
            cte_names: None,
          },
        ),
      )
    }
  }
  if !arm {
    while ["union", "intersect", "except"].contains(p.peek()) {
      let operator = p.peek()
      p.position += 1
      let operator = if operator == "union" && p.take("all") {
        "union all"
      } else {
        operator
      }
      compound.push((operator, p.selection(arm=true)))
    }
  }
  let orders = if !arm && p.take("order") {
    p.expect("by")
    p.orderings()
  } else {
    []
  }
  let limit = if !arm && p.take("limit") {
    p.expression(1)
  } else {
    Literal(Integer(-1L))
  }
  let offset = if !arm && p.take("offset") {
    p.expression(1)
  } else {
    Literal(Integer(0L))
  }
  p.depth -= 1
  {
    ctes,
    projections,
    sources,
    predicate,
    groups,
    having,
    orders,
    limit,
    offset,
    distinct,
    compound: if compound.is_empty() {
      None
    } else {
      Some(compound)
    },
    recursive,
    cte_names: if names.is_empty() {
      None
    } else {
      Some(names)
    },
  }
}

///|
fn Parser::setters(p : Parser) -> Array[(String, Expr)] raise SqlError {
  let result : Array[(String, Expr)] = []
  while true {
    let name = p.name()
    p.expect("=")
    result.push((name, p.expression(1)))
    if !p.take(",") {
      break
    }
  }
  result
}

///|
fn Parser::column_def(
  p : Parser,
) -> (ColumnDef, Bool, Bool, Array[Expr], ForeignReference?) raise SqlError {
  let name = p.name()
  let types : Array[String] = []
  while p.tokens[p.position].kind == 0 &&
        ![
          "primary", "not", "null", "unique", "check", "default", "references", "collate",
          "constraint", "generated", "as",
        ].contains(p.peek()) {
    types.push(p.name())
  }
  let declared = types.join(" ").to_upper()
  let mut not_null = false
  let mut primary = false
  let mut primary_desc = false
  let mut unique = false
  let mut auto = false
  let mut default_value : Expr = Literal(Null)
  let mut default_source : String? = Some("")
  let mut generated : Expr? = None
  let mut collation = "binary"
  let checks : Array[Expr] = []
  let mut foreign : ForeignReference? = None
  while ![",", ")", ";", ""].contains(p.peek()) {
    if p.take("constraint") {
      ignore(p.name())
    }
    if p.take("primary") {
      p.expect("key")
      primary = true
      primary_desc = p.take("desc")
      if !primary_desc {
        ignore(p.take("asc"))
      }
      auto = p.take("autoincrement")
    } else if p.take("not") {
      p.expect("null")
      not_null = true
    } else if p.take("null") {
      ()
    } else if p.take("unique") {
      unique = true
    } else if p.take("generated") || p.peek() == "as" {
      guard FEATURE_GENERATED_COLUMNS else {
        fail("feature disabled: generatedColumns")
      }
      if p.peek() != "as" {
        p.expect("always")
      }
      p.expect("as")
      p.expect("(")
      guard generated is None else {
        fail("duplicate generated column expression")
      }
      generated = Some(p.expression(1))
      p.expect(")")
      guard !p.take("stored") else {
        fail("unsupported STORED generated column")
      }
      ignore(p.take("virtual"))
    } else if p.take("default") {
      let begin = p.position
      let token = p.tokens[begin]
      let start = token.start
      let parenthesized = p.take("(")
      default_value = if parenthesized {
        let e = p.expression(1)
        p.expect(")")
        guard !p.tokens[begin:p.position].any(t => t.kind == 2) else {
          fail("unsupported quoted DEFAULT expression")
        }
        e
      } else if token.kind == 2 {
        p.position += 1
        Literal(Text(token.word))
      } else {
        let e = p.expression(10)
        let count = p.position - begin
        if count == 1 && e is Column("", name) {
          Literal(Text(name))
        } else {
          guard (
              count == 1 &&
              (e is Literal(_) || e is TruthLiteral(_) || e is CurrentTime(_))
            ) ||
            (
              count == 2 &&
              (token.word == "+" || token.word == "-") &&
              p.tokens[begin + 1].kind == 3
            ) ||
            (
              count == 2 &&
              identifier(token.word) == "x" &&
              e is Literal(Blob(_)) &&
              token.end == p.tokens[begin + 1].start
            ) else {
            fail("SQL DEFAULT expression requires parentheses")
          }
          e
        }
      }
      let end = p.tokens[p.position - 1].end
      let raw = @utf8.decode_lossy(p.source[start:end])
      default_source = Some(
        if parenthesized {
          raw[1:raw.length() - 1].trim().to_owned()
        } else {
          raw
        },
      )
    } else if p.take("check") {
      p.expect("(")
      checks.push(p.expression(1))
      p.expect(")")
    } else if p.take("collate") {
      collation = identifier(p.name())
      guard ["binary", "nocase", "rtrim"].contains(collation) else {
        fail("unsupported SQL collation")
      }
    } else if p.take("references") {
      foreign = Some(p.foreign_reference())
    } else {
      fail("unsupported SQL column constraint: " + p.peek())
    }
  }
  if generated is Some(expression) {
    guard default_source == Some("") else {
      fail("cannot use DEFAULT on a generated column")
    }
    guard !primary else { fail("generated column cannot be PRIMARY KEY") }
    default_value = Call("$generated-virtual", [expression])
  }
  (
    {
      name,
      declared,
      not_null,
      primary: if primary {
        1
      } else {
        0
      },
      default_value,
      default_source,
      collation,
      primary_desc: if primary_desc {
        Some(true)
      } else {
        None
      },
    },
    unique,
    auto,
    checks,
    foreign,
  )
}

///|
fn Parser::if_exists(p : Parser, create : Bool) -> Bool raise SqlError {
  if p.take("if") {
    if create {
      p.expect("not")
    }
    p.expect("exists")
    true
  } else {
    false
  }
}

///|
fn parse_statement(
  p : Parser,
  nested~ : Bool = false,
) -> ParsedStatement raise SqlError {
  let word = p.peek()
  let stmt : ParsedStatement = if word == "select" ||
    word == "with" ||
    word == "values" {
    Select(p.selection())
  } else if ["begin", "commit", "end", "rollback", "savepoint", "release"].contains(
      word,
    ) {
    p.position += 1
    if word == "begin" {
      if ["deferred", "immediate", "exclusive"].contains(p.peek()) {
        p.position += 1
      }
      ignore(p.take("transaction"))
      Transaction("begin", "")
    } else if word == "savepoint" || word == "release" {
      if word == "release" {
        ignore(p.take("savepoint"))
      }
      Transaction(word, p.name())
    } else if word == "rollback" {
      ignore(p.take("transaction"))
      if p.take("to") {
        ignore(p.take("savepoint"))
        Transaction("rollback to", p.name())
      } else {
        Transaction("rollback", "")
      }
    } else {
      ignore(p.take("transaction"))
      Transaction("commit", "")
    }
  } else if p.take("create") {
    let unique_index = p.take("unique")
    if p.take("table") {
      guard !unique_index else { fail("unsupported SQL CREATE UNIQUE TABLE") }
      let optional = p.if_exists(true)
      let name_start = p.tokens[p.position].start
      let name = p.name()
      if p.take("as") {
        CreateTableAs(name, p.selection(), optional)
      } else {
        p.expect("(")
        let columns : Array[ColumnDef] = []
        let uniques : Array[Array[String]] = []
        let primary : Array[String] = []
        let checks : Array[Expr] = []
        let foreign_keys : Array[ForeignKey] = []
        let references : Array[(Array[String], ForeignReference)] = []
        let mut autoincrement = false
        while true {
          if p.take("constraint") {
            ignore(p.name())
          }
          if p.take("foreign") {
            p.expect("key")
            let names = p.names()
            p.expect("references")
            references.push((names, p.foreign_reference()))
          } else if p.take("primary") {
            p.expect("key")
            for n in p.names(ordered=true) {
              primary.push(n)
            }
          } else if p.take("unique") {
            uniques.push(p.names())
          } else if p.take("check") {
            p.expect("(")
            checks.push(p.expression(1))
            p.expect(")")
          } else {
            let (col, unique, auto, col_checks, fk) = p.column_def()
            guard !columns.any(c => identifier(c.name) == identifier(col.name)) else {
              fail("duplicate column name")
            }
            let index = columns.length()
            columns.push(col)
            if col.primary > 0 {
              primary.push(col.name)
            }
            if unique {
              uniques.push([col.name])
            }
            autoincrement = autoincrement || auto
            for e in col_checks {
              checks.push(e)
            }
            if fk is Some(reference) {
              foreign_keys.push(make_foreign_key([index], reference))
            }
          }
          if !p.take(",") {
            break
          }
        }
        p.expect(")")
        for (names, reference) in references {
          let indices = names.map(name => {
            let mut i = -1
            for pos, col in columns {
              if identifier(col.name) == identifier(name) {
                i = pos
                break
              }
            }
            guard i >= 0 else { fail("unknown foreign key column") }
            i
          })
          foreign_keys.push(make_foreign_key(indices, reference))
        }
        let mut without_rowid = false
        let mut strict = false
        while true {
          if p.take("without") {
            guard !without_rowid else { fail("duplicate WITHOUT ROWID") }
            p.expect("rowid")
            without_rowid = true
          } else if p.take("strict") {
            guard !strict else { fail("duplicate STRICT") }
            strict = true
          } else {
            break
          }
          if !p.take(",") {
            break
          }
        }
        if strict {
          validate_strict_columns(columns)
        }
        guard !without_rowid || !primary.is_empty() else {
          fail("PRIMARY KEY missing on WITHOUT ROWID table")
        }
        let end = p.tokens[p.position - 1].end
        let sql = "CREATE TABLE " + @utf8.decode_lossy(p.source[name_start:end])
        let table : Table = {
          name,
          sql,
          columns,
          unique_keys: [],
          checks,
          foreign_keys,
          without_rowid,
          strict: if strict {
            Some(true)
          } else {
            None
          },
          autoincrement,
          sequence: 0L,
          sequence_present: None,
          rows: row_pages([]),
        }
        for pos, name in primary {
          table.columns[column_index(table, name)].primary = pos + 1
        }
        if !primary.is_empty() {
          uniques.push(primary)
        }
        for names in uniques {
          table.unique_keys.push(names.map(n => column_index(table, n)))
        }
        guard !autoincrement ||
          (
            primary.length() == 1 &&
            table.columns[column_index(table, primary[0])].declared == "INTEGER" &&
            !without_rowid &&
            integer_primary(table) >= 0
          ) else {
          fail("AUTOINCREMENT requires INTEGER PRIMARY KEY")
        }
        CreateTable(table, optional)
      }
    } else if p.take("index") {
      let optional = p.if_exists(true)
      let name_start = p.tokens[p.position].start
      let name = p.name()
      p.expect("on")
      let table = p.name()
      p.expect("(")
      let terms : Array[Ordering] = []
      let columns : Array[String] = []
      while true {
        let expression = p.expression(1)
        let column = match expression {
          Column("", n) | Collate(Column("", n), _) => n
          _ => ""
        }
        let descending = p.take("desc")
        if !descending {
          ignore(p.take("asc"))
        }
        terms.push({ expression, descending, })
        columns.push(column)
        if !p.take(",") {
          break
        }
      }
      p.expect(")")
      let index_predicate = if p.take("where") {
        Some(p.expression(1))
      } else {
        None
      }
      let end = p.tokens[p.position - 1].end
      CreateObject(
        {
          kind: "index",
          name,
          table,
          sql: "CREATE " +
          (if unique_index { "UNIQUE " } else { "" }) +
          "INDEX " +
          @utf8.decode_lossy(p.source[name_start:end]),
          unique: unique_index,
          columns,
          query: "",
          selection: None,
          index_terms: if terms.any(t => {
              t.descending || !(t.expression is Column("", _))
            }) {
            Some(terms)
          } else {
            None
          },
          index_predicate,
          trigger: None,
        },
        optional,
      )
    } else if p.take("view") {
      guard !unique_index else { fail("unsupported UNIQUE view") }
      let optional = p.if_exists(true)
      let start = p.tokens[p.position].start
      let name = p.name()
      p.expect("as")
      let query_start = p.tokens[p.position].start
      let selection = p.selection()
      let end = p.tokens[p.position - 1].end
      CreateObject(
        {
          kind: "view",
          name,
          table: name,
          sql: "CREATE VIEW " + @utf8.decode_lossy(p.source[start:end]),
          unique: false,
          columns: [],
          query: @utf8.decode_lossy(p.source[query_start:end]),
          selection: Some(selection),
          index_terms: None,
          index_predicate: None,
          trigger: None,
        },
        optional,
      )
    } else if p.take("trigger") {
      guard !unique_index else { fail("unsupported UNIQUE trigger") }
      let optional = p.if_exists(true)
      let start = p.tokens[p.position].start
      let name = p.name()
      let timing = if p.take("after") {
        "after"
      } else {
        ignore(p.take("before"))
        "before"
      }
      let event = p.peek()
      guard ["insert", "update", "delete"].contains(event) else {
        fail("unsupported trigger event")
      }
      p.position += 1
      let columns : Array[String] = []
      if event == "update" && p.take("of") {
        columns.push(p.name())
        while p.take(",") {
          columns.push(p.name())
        }
      }
      p.expect("on")
      let table = p.name()
      if p.take("for") {
        p.expect("each")
        p.expect("row")
      }
      let condition = if p.take("when") { p.expression(1) } else { yes() }
      p.expect("begin")
      let body : Array[DataStatement] = []
      while !p.take("end") {
        guard body.length() < 1000 else { fail("trigger body resource limit") }
        let statement = parse_statement(p, nested=true)
        let data = match statement {
          Select(select) => PreparedSelect(select)
          Insert(insert) => {
            guard insert.returning.is_empty() &&
              !(insert.values.length() == 1 && insert.values[0].is_empty()) else {
              fail("unsupported trigger INSERT clause")
            }
            PreparedInsert(insert)
          }
          Update(name, setters, predicate, returning) => {
            guard returning.is_empty() else {
              fail("RETURNING is not allowed in triggers")
            }
            PreparedUpdate(name, setters, predicate, [])
          }
          Delete(name, predicate, returning) => {
            guard returning.is_empty() else {
              fail("RETURNING is not allowed in triggers")
            }
            PreparedDelete(name, predicate, [])
          }
          _ => fail("unsupported trigger body statement")
        }
        guard timing != "before" || data_readonly(data) else {
          fail("BEFORE triggers currently support validation SELECT only")
        }
        body.push(data)
        p.expect(";")
      }
      guard !body.is_empty() && p.parameter == 0 else {
        fail("invalid trigger body or parameter")
      }
      let end = p.tokens[p.position - 1].end
      CreateObject(
        {
          kind: "trigger",
          name,
          table,
          sql: "CREATE TRIGGER " + @utf8.decode_lossy(p.source[start:end]),
          unique: false,
          columns: [],
          query: "",
          selection: None,
          index_terms: None,
          index_predicate: None,
          trigger: Some({ timing, event, columns, condition, body, }),
        },
        optional,
      )
    } else {
      fail("unsupported SQL CREATE " + p.peek())
    }
  } else if p.take("drop") {
    let kind = p.peek()
    guard ["table", "view", "index", "trigger"].contains(kind) else {
      fail("unsupported SQL DROP")
    }
    p.position += 1
    let optional = p.if_exists(false)
    Drop(kind, p.name(), optional)
  } else if p.take("insert") || p.take("replace") {
    let mut conflict_override : String? = None
    let conflict = if word == "replace" {
      conflict_override = Some("replace")
      "replace"
    } else if p.take("or") {
      let c = p.peek()
      p.position += 1
      guard ["ignore", "replace", "abort"].contains(c) else {
        fail("unsupported conflict algorithm")
      }
      conflict_override = Some(c)
      c
    } else {
      "abort"
    }
    p.expect("into")
    let table = p.name()
    let columns = if p.peek() == "(" { p.names() } else { [] }
    let values : Array[Array[Expr]] = []
    let mut selection : Selection? = None
    if p.peek() == "select" || p.peek() == "with" {
      selection = Some(p.selection())
    } else if p.take("default") {
      p.expect("values")
      values.push([])
    } else {
      p.expect("values")
      while true {
        p.expect("(")
        let row : Array[Expr] = []
        row.push(p.expression(1))
        while p.take(",") {
          row.push(p.expression(1))
        }
        p.expect(")")
        values.push(row)
        if !p.take(",") {
          break
        }
      }
    }
    let mut target : Array[String] = []
    let mut target_predicate : Expr? = None
    let mut updates : Array[(String, Expr)] = []
    let mut predicate = yes()
    let mut conflict = conflict
    if p.take("on") {
      p.expect("conflict")
      if p.peek() == "(" {
        target = p.names(qualifier=table, ordered=true)
        if p.take("where") {
          target_predicate = Some(p.expression(1))
        }
      }
      p.expect("do")
      if p.take("nothing") {
        conflict = "nothing"
      } else {
        p.expect("update")
        p.expect("set")
        conflict = "update"
        updates = p.setters()
        if p.take("where") {
          predicate = p.expression(1)
        }
      }
    }
    let returning = if p.take("returning") { p.projections() } else { [] }
    Insert({
      table,
      columns,
      values,
      conflict,
      target,
      updates,
      predicate,
      returning,
      conflict_override,
      target_predicate,
      selection,
    })
  } else if p.take("update") {
    let name = p.name()
    let target_alias = if p.take("as") { p.name() } else { name }
    p.expect("set")
    let setters = p.setters()
    let has_from = p.take("from")
    let extended = has_from || target_alias != name
    if extended {
      guard FEATURE_UPDATE_FROM else { fail("feature disabled: updateFrom") }
      guard !nested else { fail("unsupported UPDATE FROM in trigger body") }
    }
    let ctes : Array[(String, Selection)] = []
    let sources = if has_from { p.sources(ctes, update_from=true) } else { [] }
    let condition = if p.take("where") { p.expression(1) } else { yes() }
    let predicate = if extended {
      Call("$update-from", [
        Literal(Text(target_alias)),
        ScalarSelect({
          ctes,
          sources,
          predicate: condition,
          projections: [],
          groups: [],
          having: yes(),
          orders: [],
          limit: Literal(Integer(-1L)),
          offset: Literal(Integer(0L)),
          distinct: false,
          compound: None,
          recursive: None,
          cte_names: None,
        }),
      ])
    } else {
      condition
    }
    let returning = if p.take("returning") { p.projections() } else { [] }
    Update(name, setters, predicate, returning)
  } else if p.take("delete") {
    p.expect("from")
    let name = p.name()
    let predicate = if p.take("where") { p.expression(1) } else { yes() }
    let returning = if p.take("returning") { p.projections() } else { [] }
    Delete(name, predicate, returning)
  } else if p.take("pragma") {
    let name = identifier(p.name())
    if p.take("(") {
      let table = p.name()
      p.expect(")")
      Pragma(name, table, None)
    } else if p.take("=") {
      Pragma(name, "", Some(p.expression(1)))
    } else {
      Pragma(name, "", None)
    }
  } else if p.take("alter") {
    p.expect("table")
    let table = p.name()
    if p.take("add") {
      ignore(p.take("column"))
      let start = p.tokens[p.position].start
      let (col, unique, auto, checks, fk) = p.column_def()
      guard col.primary == 0 &&
        !unique &&
        !auto &&
        checks.is_empty() &&
        fk is None else {
        fail("unsupported ALTER ADD constraint")
      }
      let end = p.tokens[p.position - 1].end
      AddColumn(table, col, @utf8.decode_lossy(p.source[start:end]))
    } else if p.take("drop") {
      ignore(p.take("column"))
      DropColumn(table, p.name())
    } else {
      p.expect("rename")
      if p.take("to") {
        RenameTable(table, p.name())
      } else {
        ignore(p.take("column"))
        let old = p.name()
        p.expect("to")
        let quoted = p.tokens[p.position].kind == 2
        RenameColumn(table, old, p.name(), quoted)
      }
    }
  } else {
    fail("unsupported SQL statement: " + word)
  }
  if !nested {
    ignore(p.take(";"))
    guard p.peek() == "" else {
      fail("unsupported or trailing SQL: " + p.tokens[p.position].word)
    }
  }
  stmt
}

// Source: persistence.mbt

///|
/// Deterministic materialized edits, not SQL replay. Version 2 adds column
/// patches; version 1 after-images remain readable. Preserve publication order.
#derive(ToJson, FromJson)
priv enum RowEdit {
  AppendRow(String, StoredRow)
  ReplaceRow(String, Int64, StoredRow)
  DeleteRow(String, Int64)
  PatchRow(String, Int64, Int64, Array[(Int32, Value)])
}

///|
priv struct DirtyState {
  mut full : Bool
  base : Int32
  edits : Array[RowEdit]
}

///|
fn dirty_state() -> DirtyState {
  { full: true, base: 0, edits: [], }
}

///|
fn dirty_snapshot(store : Store) -> Unit {
  store.dirty.full = true
  store.dirty.edits.clear()
}

///|
fn dirty_edit(store : Store, edit : RowEdit) -> Unit {
  if !store.dirty.full {
    if store.dirty.edits.length() >= 4096 {
      dirty_snapshot(store)
    } else {
      store.dirty.edits.push(edit)
    }
  }
}

///|
/// Storage equality must not use SQL comparison/affinity, or merge +0 / -0.
/// Unchanged TEXT/BLOB values usually share the immutable Value object.
fn same_stored_value(before : Value, after : Value) -> Bool {
  if physical_equal(before, after) {
    return true
  }
  match (before, after) {
    (Real(a), Real(b)) => a.reinterpret_as_uint64() == b.reinterpret_as_uint64()
    _ => before == after
  }
}

///|
/// Capture at row replacement, without dumping/diffing the database or keeping
/// the previous row alive. Published patch arrays and row values are immutable.
fn dirty_replace(
  store : Store,
  table : Table,
  before : StoredRow,
  after : StoredRow,
) -> Unit {
  if store.dirty.full {
    return
  }
  if store.dirty.edits.length() >= 4096 {
    dirty_snapshot(store)
    return
  }
  let name = table.name
  let before = persistent_generated_row(table, before)
  let after = persistent_generated_row(table, after)
  let columns : Array[(Int32, Value)] = []
  for i, value in after.values {
    if !same_stored_value(before.values[i], value) {
      columns.push((i, value))
    }
  }
  if columns.is_empty() && before.id == after.id {
    return
  }
  // A complete replacement is more compact when every column changed.
  dirty_edit(
    store,
    if columns.length() == after.values.length() {
      ReplaceRow(name, before.id, after)
    } else {
      PatchRow(name, before.id, after.id, columns)
    },
  )
}

///|
#derive(ToJson, FromJson)
priv struct FlushMetadata {
  encoding : Int32?
  cookie : Int32
  changes : Int32
  last_rowid : Int64
  foreign_keys : Bool
  deferred : Bool
  sequences : Array[(String, Int64, Bool?)]
}

///|
pub fn database_delta(db : Database, force_snapshot : Bool) -> String {
  let store = db.store
  if force_snapshot || store.dirty.full {
    (
      {
        "format": "sqlike-flush@1",
        "full": true,
        "serial": db.serial,
        "state": @json.to_json(store),
      } : Json).stringify()
  } else {
    let meta : FlushMetadata = {
      encoding: store.encoding,
      cookie: store.cookie,
      changes: store.changes,
      last_rowid: store.last_rowid,
      foreign_keys: store.foreign_keys,
      deferred: store.deferred,
      sequences: store.tables.map(t => (t.name, t.sequence, t.sequence_present)),
    }
    (
      {
        "format": "sqlike-flush@2",
        "full": false,
        "base": store.dirty.base,
        "serial": db.serial,
        "meta": @json.to_json(meta),
        "edits": @json.to_json(store.dirty.edits),
      } : Json).stringify()
  }
}

///|
/// The host calls this only after durable ACK, or after opening a known image.
pub fn database_ack_delta(db : Database, serial : Int32) -> String {
  if serial < 0 || serial != db.serial {
    return ({ "error": "stale flush acknowledgement" } : Json).stringify()
  }
  db.store.dirty = { full: false, base: serial, edits: [], }
  "{}"
}

///|
fn flush_row(
  store : Store,
  table : Table,
  row : StoredRow,
  except : Int64?,
) -> Unit raise SqlError {
  let ipk = integer_primary(table)
  guard row.values.length() == table.columns.length() &&
    (ipk < 0 || row.values[ipk] == Integer(row.id)) else {
    fail("invalid flush row")
  }
  for value in row.values {
    if value is Real(n) && n.is_nan() {
      fail("invalid flush real")
    }
  }
  guard table_row_by_id(store, table, row.id).filter(r => Some(r.id) != except)
    is None else {
    fail("duplicate flush rowid")
  }
  check_row(store, table, row.values, [])
  guard conflict_row(store, table, row.values, except, None) is None else {
    fail("flush UNIQUE constraint failed")
  }
}

///|
fn decode_flush(db : Database, text : String) -> (Store, Int32, Bool) raise {
  guard text.length() <= 67108864 else { fail("flush resource limit") }
  let json = @json.parse(text)
  guard json
    is { "format": String(format), "serial": serial, "full": is_full, .. } &&
    (format == "sqlike-flush@1" || format == "sqlike-flush@2") else {
    fail("invalid flush format")
  }
  let serial = flush_integer(serial)
  let full : Bool = @json.from_json(is_full)
  guard serial >= 0 else { fail("invalid flush serial") }
  if full {
    guard format == "sqlike-flush@1" else {
      fail("invalid flush snapshot version")
    }
    guard json is { "state": state, .. } else { fail("missing flush snapshot") }
    let store : Store = @json.from_json(state)
    return (store, serial, true)
  }
  guard json is { "base": base, "meta": meta, "edits": edits, .. } else {
    fail("invalid flush delta")
  }
  let base = flush_integer(base)
  guard base == db.serial && serial > base else {
    fail("flush serial mismatch")
  }
  guard meta is { "cookie": cookie, "changes": changes, .. } else {
    fail("invalid flush metadata")
  }
  ignore(flush_integer(cookie))
  ignore(flush_integer(changes))
  let meta : FlushMetadata = @json.from_json(meta)
  guard meta.cookie == db.store.cookie &&
    meta.encoding == db.store.encoding &&
    meta.changes >= 0 &&
    !meta.deferred &&
    meta.sequences.length() == db.store.tables.length() else {
    fail("flush metadata mismatch")
  }
  // FromJson[Int32] truncates fractions. Validate wire positions before typed
  // decoding so a malformed index cannot silently target a different column.
  guard edits is Array(raw_edits) && raw_edits.length() <= 100000 else {
    fail("flush edit limit")
  }
  for edit in raw_edits {
    if edit is Array([String("PatchRow"), _, _, _, Array(columns)]) {
      guard format == "sqlike-flush@2" else {
        fail("invalid flush patch version")
      }
      for column in columns {
        guard column is Array([index, _]) else { fail("invalid flush column") }
        ignore(flush_integer(index))
      }
    }
  }
  let edits : Array[RowEdit] = @json.from_json(edits)
  guard edits.length() <= 100000 else { fail("flush edit limit") }
  let store = copy_store(db.store)
  store.dirty = dirty_state()
  if format != "sqlike-flush@2" &&
    edits.any(edit => edit is PatchRow(_, _, _, _)) {
    fail("invalid flush patch version")
  }
  apply_materialized_edits(store, edits)
  for i, (name, sequence, present) in meta.sequences {
    let table = store.tables[i]
    guard table.name == name else { fail("flush table mismatch") }
    table.sequence = sequence
    table.sequence_present = present
  }
  store.changes = meta.changes
  store.last_rowid = meta.last_rowid
  store.foreign_keys = meta.foreign_keys
  store.deferred = false
  validate_foreign_keys(store)
  (store, serial, false)
}

///|
fn flush_integer(value : Json) -> Int32 raise SqlError {
  guard value is Number(number, ..) &&
    number >= 0.0 &&
    number <= 2147483647.0 &&
    number.to_int().to_double() == number else {
    fail("invalid flush integer")
  }
  number.to_int()
}

///|
fn publish_flush(db : Database, store : Store, serial : Int32) -> Unit {
  store.dirty = { full: false, base: serial, edits: [], }
  db.store = store
  db.serial = serial
  db.schema_epoch += 1L
}

///|
pub fn database_apply_delta(db : Database, text : String) -> String {
  try {
    let (store, serial, full) = decode_flush(db, text)
    if full {
      validate_image(store, storage=true)
    }
    publish_flush(db, store, serial)
    "{}"
  } catch {
    error => ({ "error": public_error(error) } : Json).stringify()
  }
}

///|
fn same_stored_values(before : Array[Value], after : Array[Value]) -> Bool {
  if before.length() != after.length() {
    return false
  }
  for i in 0..<before.length() {
    if !same_stored_value(before[i], after[i]) {
      return false
    }
  }
  true
}

// Source: persistence_edits.mbt

///|
fn apply_materialized_edits(
  store : Store,
  edits : Array[RowEdit],
) -> Unit raise SqlError {
  for edit in edits {
    match edit {
      AppendRow(name, row) => {
        let table = get_table(store, name)
        let row = generated_row(store, table, row, storage=true)
        flush_row(store, table, row, None)
        append_table_row(store, table, row)
        guard table.rows.length() <= 100000 else { fail("flush table limit") }
      }
      ReplaceRow(name, id, row) => {
        let table = get_table(store, name)
        guard table_row_by_id(store, table, id) is Some(previous) else {
          fail("missing flush row")
        }
        let row = generated_row(store, table, row, storage=true)
        flush_row(store, table, row, Some(id))
        replace_table_row(store, table, previous, row)
      }
      DeleteRow(name, id) => {
        let table = get_table(store, name)
        guard table_row_by_id(store, table, id) is Some(row) else {
          fail("missing flush row")
        }
        remove_table_row(store, table, row)
      }
      PatchRow(name, id, next_id, columns) => {
        let table = get_table(store, name)
        guard table_row_by_id(store, table, id) is Some(previous) else {
          fail("missing flush row")
        }
        let values = persistent_generated_row(table, previous).values.copy()
        let mut last = -1
        for (index, value) in columns {
          guard index > last && index < values.length() else {
            fail("invalid flush column index")
          }
          guard !FEATURE_GENERATED_COLUMNS ||
            !generated_column(table.columns[index]) else {
            fail("cannot patch generated column")
          }
          values[index] = value
          last = index
        }
        let row = generated_row(
          store,
          table,
          { id: next_id, values, },
          storage=true,
        )
        flush_row(store, table, row, Some(id))
        replace_table_row(store, table, previous, row)
      }
    }
  }
}

// Source: prepare.mbt

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
    Column(q, n) => {
      let found = resolve_context(ctx, q, n)
      guard !FEATURE_JSON_TABLE ||
        !ctx.forbid_json_inputs ||
        !found.hidden ||
        !["json", "root"].contains(found.name) else {
        fail("unsupported JSON table input constraint")
      }
    }
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
    Cast(e, target) =>
      if CAP_EXPRESSION_CAST {
        guard ["integer", "real", "numeric", "text", "blob"].contains(target) else {
          fail("unsupported SQL cast: " + target)
        }
        prepare_expression(e, ctx, aggregates, windows)
      } else {
        fail("catalog capability disabled: expression cast")
      }
    Binary(op, a, b) => {
      if FEATURE_ROW_VALUES &&
        (row_value_expression(a) || row_value_expression(b)) {
        guard comparison_operator(op) else { fail("row value misused") }
        let width = prepare_row_value(a, ctx, aggregates, windows)
        guard prepare_row_value(b, ctx, aggregates, windows) == width else {
          fail("row value size mismatch")
        }
        return
      }
      if CAP_CATALOG_SPECIALIZED && !CAP_FUNCTION_LIKE && op == "like" {
        fail("catalog capability disabled: function like")
      }
      guard [
        "+", "-", "*", "/", "%", "<<", ">>", "&", "|", "||", "and", "or", "=", "==",
        "!=", "<>", "<", ">", "<=", ">=", "is", "is not", "like",
      ].contains(op) else {
        fail("unsupported SQL binary operator: " + op)
      }
      prepare_expression(a, ctx, aggregates, windows)
      prepare_expression(b, ctx, aggregates, windows)
    }
    Between(e, a, b) =>
      if CAP_EXPRESSION_BETWEEN {
        if FEATURE_ROW_VALUES && row_value_expression(e) {
          let width = prepare_row_value(e, ctx, aggregates, windows)
          guard prepare_row_value(a, ctx, aggregates, windows) == width &&
            prepare_row_value(b, ctx, aggregates, windows) == width else {
            fail("row value size mismatch")
          }
          return
        }
        prepare_expression(e, ctx, aggregates, windows)
        prepare_expression(a, ctx, aggregates, windows)
        prepare_expression(b, ctx, aggregates, windows)
      } else {
        fail("catalog capability disabled: expression between")
      }
    Case(base, arms, otherwise) =>
      if CAP_EXPRESSION_CASE {
        if FEATURE_ROW_VALUES && base is Some(e) && row_value_expression(e) {
          let width = prepare_row_value(e, ctx, aggregates, windows)
          for (condition, value) in arms {
            guard prepare_row_value(condition, ctx, aggregates, windows) ==
              width else {
              fail("row value size mismatch")
            }
            prepare_expression(value, ctx, aggregates, windows)
          }
          prepare_expression(otherwise, ctx, aggregates, windows)
          return
        }
        if base is Some(e) {
          prepare_expression(e, ctx, aggregates, windows)
        }
        for (condition, value) in arms {
          prepare_expression(condition, ctx, aggregates, windows)
          prepare_expression(value, ctx, aggregates, windows)
        }
        prepare_expression(otherwise, ctx, aggregates, windows)
      } else {
        fail("catalog capability disabled: expression case")
      }
    InSelect(value, select) =>
      if CAP_EXPRESSION_SUBQUERY && CAP_QUERY_IN_SELECT {
        validate_runtime_query_part("inSelect")
        if FEATURE_ROW_VALUES && row_value_expression(value) {
          let width = prepare_row_value(value, ctx, aggregates, windows)
          guard row_select_metadata(select, ctx).length() == width else {
            fail("row value size mismatch")
          }
          return
        }
        prepare_expression(value, ctx, aggregates, windows)
        guard selection_template(select, ctx.nested()).length() == 1 else {
          fail("sub-select returns more than one column")
        }
      } else {
        fail("catalog capability disabled: query inSelect")
      }
    ScalarSelect(select) =>
      if CAP_EXPRESSION_SUBQUERY {
        guard selection_template(select, ctx.nested()).length() == 1 else {
          fail("sub-select returns more than one column")
        }
      } else {
        fail("catalog capability disabled: expression subquery")
      }
    Exists(select) =>
      if CAP_EXPRESSION_SUBQUERY {
        ignore(selection_template(select, ctx.nested()))
      } else {
        fail("catalog capability disabled: expression subquery")
      }
    Window(name, args, partitions, orders, frame) => {
      guard FEATURE_WINDOWS else { fail("feature disabled: windowFunctions") }
      guard ["rows", "range", "groups"].contains(frame.kind) else {
        fail("unsupported SQL window frame: " + frame.kind)
      }
      guard windows && window_arity(name, args.length()) else {
        fail("misuse of window function: " + name)
      }
      guard !args.any(e => filter_input(e) is Call("$distinct", _)) else {
        fail("DISTINCT is not supported for window functions")
      }
      for i, e in args {
        if i == 0 && e is Call("$filter", _) {
          prepare_filtered_argument(e, ctx, name, true, args.length())
          continue
        }
        if i == 0 && e is Call("$aggregate-order", _) {
          prepare_ordered_argument(e, ctx, name, true, args.length())
          continue
        }
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
        prepare_expression(ordering_expression(o.expression), ctx, true, false)
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
        prepare_expression(ordering_expression(o.expression), ctx, false, false)
      }
    }
    Call(name, args) =>
      if CAP_EXPRESSION_CALL {
        // IN is a lowered SQL operator, not a variadic function invocation.
        guard name == "in" || args.length() <= 1000 else {
          fail("SQL function argument limit")
        }
        validate_runtime_call(name, args.length())
        validate_runtime_json_values(name, args)
        if FEATURE_JSON_TABLE &&
          runtime_json_values(name, args).any(e => json_table_ambiguous(e, ctx)) {
          fail(
            "unsupported JSON table subtype through relation boundary or extrema",
          )
        }
        validate_function_features(name)
        if FEATURE_ROW_VALUES && name == "in" && args.any(row_value_expression) {
          let width = prepare_row_value(args[0], ctx, aggregates, windows)
          for i in 1..<args.length() {
            guard prepare_row_value(args[i], ctx, aggregates, windows) == width else {
              fail("row value size mismatch")
            }
          }
          return
        }
        if name == "$distinct" {
          guard aggregates && args.length() == 1 else {
            fail("misuse of DISTINCT aggregate")
          }
          prepare_expression(args[0], ctx, false, false)
          return
        }
        if name == "raise" {
          guard CAP_FUNCTION_RAISE else {
            fail("catalog capability disabled: raise")
          }
          guard !ctx.store.triggers.active.is_empty() else {
            fail("RAISE() may only be used within a trigger-program")
          }
          ignore(trigger_raise_action(args))
          if args.length() == 2 {
            prepare_expression(args[1], ctx, false, false)
          }
          return
        }
        let grouped = aggregate_name(name, args.length())
        if grouped {
          guard aggregates &&
            (
              args.length() == 1 ||
              (
                (
                  name == "group_concat" ||
                  name == "string_agg" ||
                  name == "json_group_object"
                ) &&
                args.length() == 2
              )
            ) &&
            (name != "string_agg" || args.length() == 2) &&
            (name != "json_group_object" || args.length() == 2) else {
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
          guard valid else {
            fail("unsupported SQL function or arity: " + name)
          }
        }
        for i, arg in args {
          if i == 0 && arg is Call("$filter", _) {
            prepare_filtered_argument(arg, ctx, name, false, args.length())
          } else if i == 0 && arg is Call("$aggregate-order", _) {
            prepare_ordered_argument(arg, ctx, name, false, args.length())
          } else if arg is Star(_) {
            guard name == "count" else {
              fail("unsupported function * argument")
            }
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
      } else {
        fail("catalog capability disabled: expression call")
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
        guard b.readable else {
          fail("unsupported physical schema column: " + b.name)
        }
        output.push({
          ..(if b.join_column is Some(MergedJoinColumn(_, _, _)) {
            unqualified_binding(b).unwrap()
          } else {
            b
          }),
          qualifier: "",
          value: Null,
          join_column: None,
          json_value: if FEATURE_JSON_TABLE && b.json_value > 0 {
            2
          } else {
            0
          },
        })
      }
    } else {
      prepare_expression(projection.expression, ctx, true, true)
      let tvf_origin = FEATURE_JSON_TABLE &&
        json_table_origin(projection.expression, ctx)
      // A result column inherits affinity/collation only from a direct reference.
      output.push({
        ..binding(projection_name(projection, ctx), Null),
        json_value: if tvf_origin {
          2
        } else {
          0
        },
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
    Unary(_, e) | Cast(e, _) | Collate(e, _) => constant_default(e)
    Binary(_, a, b) => constant_default(a) && constant_default(b)
    Call(_, args) => args.all(constant_default)
    Between(e, a, b) =>
      constant_default(e) && constant_default(a) && constant_default(b)
    Case(base, arms, otherwise) =>
      base.map(constant_default).unwrap_or(true) &&
      arms.all(pair => constant_default(pair.0) && constant_default(pair.1)) &&
      constant_default(otherwise)
    _ => false
  }
}

///|
fn literal_default(expression : Expr) -> Bool {
  match expression {
    Literal(_) | TruthLiteral(_) => true
    Unary("+" | "-", e) => literal_default(e)
    _ => false
  }
}

///|
fn prepare_default(store : Store, col : ColumnDef) -> Unit raise SqlError {
  if FEATURE_GENERATED_COLUMNS && generated_column(col) {
    return
  }
  guard constant_default(col.default_value) else {
    fail("unsupported SQL DEFAULT expression")
  }
  prepare_expression(
    col.default_value,
    { ..evaluation(store, [], []), outer: [], },
    false,
    false,
  )
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

// Source: prepared.mbt

///|
#derive(ToJson)
priv struct CompiledQuery {
  name : String
  parameters : Int32
  names : Array[String]
  statement : DataStatement
}

///|
#derive(ToJson, FromJson)
priv struct CompiledProgram {
  format : String
  schema : Store
  queries : Array[CompiledQuery]
  storage : StoragePlan?
}

///|
struct Program {
  schema : Store
  queries : Map[String, CompiledQuery]
  selections : Map[String, PreparedSelection]
  updates : Map[String, PreparedUpdatePlan]
  id : String
  storage : StoragePlan?
}

///|
struct Query {
  program_id : String
  plan : CompiledQuery
  selection : PreparedSelection?
  update : PreparedUpdatePlan?
}

///|
/// Derived from the validated fixed schema, never serialized into moon-aot@1.
/// No Store, Table, row, parameter, clock or connection state is retained.
priv struct PreparedSelection {
  output : Environment
  simple : PreparedProjection?
  point : PreparedPoint?
  row_metadata : Array[PreparedRowMetadata]
  in_lists : Array[PreparedInList]
  in_selects : Array[PreparedInSelect]
  representative : AggregateRepresentativePlan?
}

///|
priv struct PreparedProjection {
  layout : Environment
  columns : Array[RowProjection]
}

///|
/// Runtime-only metadata from the validated fixed schema. Like PreparedSelection,
/// this contains no Store/Table, live row, bindings or connection state.
priv struct PreparedUpdatePlan {
  table_slot : Int32
  layout : Environment
  columns : Array[String]
  setters : Array[PreparedSetter]
  integer_primary : Int32
  predicate : BoundExpression
  access : BoundAccess
  returning : BoundProjection
  from_plan : PreparedUpdateFromPlan?
  in_lists : Array[PreparedInList]
}

///|
priv struct PreparedSetter {
  column : Int32
  affinity : String
  expression : BoundExpression
}

///|
fn prepare_update(
  store : Store,
  name : String,
  setters : Array[(String, Expr)],
  predicate : Expr,
  returning : Array[Projection],
  parameters : Int32,
  layouts~ : Map[String, Environment] = Map([]),
) -> (PreparedUpdatePlan, Array[String]) raise SqlError {
  guard CAP_STATEMENT_UPDATE else {
    fail("catalog capability disabled: update")
  }
  let table = get_table(store, name)
  prepare_foreign_table(store, table)
  let layout = match layouts.get(table.name) {
    Some(layout) => layout
    None => {
      let layout = row_environment(
        table,
        { id: 0L, values: Array::make(table.columns.length(), Null), },
        table.name,
      )
      layouts[table.name] = layout
      layout
    }
  }
  if FEATURE_UPDATE_FROM && update_from_expression(predicate) {
    return prepare_update_from(
      store, table, layout, setters, predicate, returning, parameters,
    )
  }
  let context = evaluation(store, Array::make(parameters, Null), layout)
  let resolved = validate_update(table, setters, predicate, returning, context).map(pair => {
      let (column, expression) = pair
      {
        column,
        affinity: column_affinity(table, table.columns[column]),
        expression: bind_expression(expression, context),
      }
    },
  )
  let in_lists = statement_in_lists(
    [predicate] + setters.map(p => p.1) + returning.map(p => p.expression),
    context,
  )
  let returning = bind_projection(returning, context)
  (
    {
      table_slot: prepared_table_slot(store, table),
      layout,
      columns: setters.map(p => p.0),
      setters: resolved,
      integer_primary: integer_primary(table),
      predicate: bind_expression(predicate, context),
      access: bind_access(table, predicate, layout),
      returning,
      from_plan: None,
      in_lists,
    },
    returning.output.map(b => b.name),
  )
}

///|
/// Semantic validation also serves trigger bodies with live OLD/NEW scopes.
/// Executable slot binding is a separate step for fixed-schema top-level plans.
fn validate_update(
  table : Table,
  setters : Array[(String, Expr)],
  predicate : Expr,
  returning : Array[Projection],
  context : Evaluation,
) -> Array[(Int32, Expr)] raise SqlError {
  prepare_expression(predicate, context, false, false)
  let resolved = setters.map(pair => {
    let (name, expression) = pair
    let column = writable_column(table, name)
    prepare_expression(expression, context, false, false)
    (column, expression)
  })
  prepare_returning(returning, context)
  resolved
}

///|
fn prepare_selection(
  store : Store,
  select : Selection,
  parameters : Int32,
  output~ : Environment? = None,
) -> PreparedSelection raise SqlError {
  let output = match output {
    Some(output) => output
    None =>
      selection_template(
        select,
        evaluation(store, Array::make(parameters, Null), []),
      )
  }
  let mut simple : PreparedProjection? = None
  let mut point : PreparedPoint? = None
  let row_metadata : Array[PreparedRowMetadata] = []
  let in_lists : Array[PreparedInList] = []
  let in_selects : Array[PreparedInSelect] = []
  if CAP_QUERY_SOURCE && select.sources.length() == 1 {
    let source = select.sources[0]
    let key = identifier(source.name)
    for slot, table in store.tables {
      if matches_identifier(table.name, key) {
        let layout = row_environment(
          table,
          { id: 0L, values: Array::make(table.columns.length(), Null), },
          source.qualifier,
        )
        let columns = simple_projection(select, table, source.qualifier)
        if columns is Some(columns) && columns.length() == output.length() {
          simple = Some({ layout, columns, })
        }
        point = prepare_point(
          store, select, table, slot, layout, columns, parameters,
        )
        if OPT_ROW_METADATA &&
          FEATURE_ROW_VALUES &&
          select.ctes.is_empty() &&
          select.compound is None {
          let context = evaluation(store, Array::make(parameters, Null), layout)
          if context.outer.is_empty() {
            prepare_row_metadata(select.predicate, context, row_metadata)
            for p in select.projections {
              prepare_row_metadata(p.expression, context, row_metadata)
            }
          }
        }
        break
      }
    }
  }
  if select.compound is None &&
    (
      (OPT_IN_LIST_LOOKUP && CAP_FUNCTION_IN_LIST) ||
      (OPT_IN_SELECT_LOOKUP && CAP_QUERY_IN_SELECT)
    ) &&
    ([select.predicate] + select.projections.map(p => p.expression)).any(
      lookup_expression,
    ) {
    let context = selection_source_context(
      select,
      evaluation(store, Array::make(parameters, Null), []),
    )
    for
      expression in [select.predicate] +
      select.projections.map(p => p.expression) {
      if OPT_IN_LIST_LOOKUP && CAP_FUNCTION_IN_LIST {
        prepare_in_lists(expression, context, in_lists)
      }
      if OPT_IN_SELECT_LOOKUP && CAP_QUERY_IN_SELECT {
        prepare_in_select(expression, context, in_selects)
      }
    }
  }
  {
    output,
    simple,
    point,
    row_metadata,
    in_lists,
    in_selects,
    representative: if CAP_QUERY_AGGREGATE_REPRESENTATIVE {
      aggregate_representative_plan(select)
    } else {
      None
    },
  }
}

///|
fn prepared_table_slot(store : Store, table : Table) -> Int32 raise SqlError {
  for i, candidate in store.tables {
    if candidate.name == table.name {
      return i
    }
  }
  fail("invalid prepared table")
}

///|
fn data_readonly(statement : DataStatement) -> Bool {
  match statement {
    PreparedSelect(_) | PreparedPragma(_, _) => true
    _ => false
  }
}

///|
fn prepared_names(
  store : Store,
  statement : DataStatement,
  count : Int32,
) -> Array[String] raise SqlError {
  let params = Array::make(count, Value::Null)
  match statement {
    PreparedTransaction(_, _) => {
      guard CAP_STATEMENT_TRANSACTION else {
        fail("catalog capability disabled: transaction")
      }
      []
    }
    PreparedSelect(select) => {
      guard CAP_STATEMENT_SELECT else {
        fail("catalog capability disabled: select")
      }
      selection_template(select, evaluation(store, params, [])).map(b => b.name)
    }
    PreparedPragma(name, table) => {
      guard CAP_STATEMENT_PRAGMA else {
        fail("catalog capability disabled: pragma")
      }
      ignore(execute_pragma(store, name, table, None, params))
      match name {
        "index_list" => ["seq", "name", "unique", "origin", "partial"]
        "index_info" => ["seqno", "cid", "name"]
        "index_xinfo" => ["seqno", "cid", "name", "desc", "coll", "key"]
        "table_info" => ["cid", "name", "type", "notnull", "dflt_value", "pk"]
        "table_xinfo" =>
          ["cid", "name", "type", "notnull", "dflt_value", "pk", "hidden"]
        "foreign_key_list" =>
          [
            "id", "seq", "table", "from", "to", "on_update", "on_delete", "match",
          ]
        "foreign_key_check" => ["table", "rowid", "parent", "fkid"]
        _ => [name]
      }
    }
    PreparedInsert(insertion) => {
      guard CAP_STATEMENT_INSERT else {
        fail("catalog capability disabled: insert")
      }
      let table = get_table(store, insertion.table)
      prepare_foreign_table(store, table)
      let columns = if insertion.columns.is_empty() {
        insert_columns(table).map(i => table.columns[i].name)
      } else {
        insertion.columns
      }
      for name in columns {
        ignore(insertion_column(table, name))
      }
      if insertion.selection is Some(select) {
        guard selection_template(select, evaluation(store, params, [])).length() ==
          columns.length() else {
          fail("INSERT SELECT column count mismatch")
        }
      }
      for row in insertion.values {
        guard row.is_empty() || row.length() == columns.length() else {
          fail("INSERT value count mismatch")
        }
        for value in row {
          prepare_expression(value, evaluation(store, params, []), false, false)
        }
      }
      let empty = { id: 0L, values: Array::make(table.columns.length(), Null), }
      let row = row_environment(table, empty, table.name)
      let excluded = row_environment(table, empty, "excluded")
      for (name, expression) in insertion.updates {
        ignore(writable_column(table, name))
        prepare_expression(
          expression,
          evaluation(store, params, row + excluded),
          false,
          false,
        )
      }
      prepare_expression(
        insertion.predicate,
        evaluation(store, params, row + excluded),
        false,
        false,
      )
      prepare_returning(insertion.returning, evaluation(store, params, row))
      project_template(insertion.returning, evaluation(store, params, row)).map(b => {
          b.name
        },
      )
    }
    PreparedUpdate(name, setters, predicate, returning) => {
      guard CAP_STATEMENT_UPDATE else {
        fail("catalog capability disabled: update")
      }
      if FEATURE_UPDATE_FROM && update_from_expression(predicate) {
        let (_, names) = prepare_update(
          store, name, setters, predicate, returning, count,
        )
        names
      } else {
        let table = get_table(store, name)
        prepare_foreign_table(store, table)
        let layout = row_environment(
          table,
          { id: 0L, values: Array::make(table.columns.length(), Null), },
          table.name,
        )
        let context = evaluation(store, params, layout)
        ignore(validate_update(table, setters, predicate, returning, context))
        project_template(returning, context).map(b => b.name)
      }
    }
    PreparedDelete(name, predicate, returning) => {
      guard CAP_STATEMENT_DELETE else {
        fail("catalog capability disabled: delete")
      }
      let table = get_table(store, name)
      prepare_foreign_table(store, table)
      let context = evaluation(
        store,
        params,
        row_environment(
          table,
          { id: 0L, values: Array::make(table.columns.length(), Null), },
          name,
        ),
      )
      prepare_expression(predicate, context, false, false)
      prepare_returning(returning, context)
      project_template(returning, context).map(b => b.name)
    }
  }
}

///|
fn program_id(input : String) -> String {
  let mut value = 14695981039346656037UL
  for byte in @utf8.encode(input) {
    value = (value ^ byte.to_uint64()) * 1099511628211UL
  }
  value.to_string()
}

///|
// Shared semantic validation has no dependency on a particular wire decoder.
fn prepare_compiled_program(
  program : CompiledProgram,
  id : String,
) -> Program raise SqlError {
  guard program.format == "moon-aot@1" &&
    program.queries.length() <= 1000 &&
    program.schema.encoding.unwrap_or(1) == 1 else {
    fail("unsupported compiled program")
  }
  validate_store_rows(program.schema)
  for object in program.schema.objects {
    if object.kind == "view" {
      guard object.selection is Some(select) else {
        fail("view has no compiled query")
      }
      ignore(selection_template(select, evaluation(program.schema, [], [])))
    }
  }
  let queries : Map[String, CompiledQuery] = Map([])
  let selections : Map[String, PreparedSelection] = Map([])
  let updates : Map[String, PreparedUpdatePlan] = Map([])
  // Share a table's null-valued layout rather than retaining it per UPDATE.
  let update_layouts : Map[String, Environment] = Map([])
  for query in program.queries {
    validate_optional_features(query)
    guard query.name != "" &&
      !queries.contains(query.name) &&
      query.parameters >= 0 &&
      query.parameters <= 10000 else {
      fail("invalid compiled query catalog")
    }
    let names = match query.statement {
      PreparedSelect(select) => {
        guard CAP_STATEMENT_SELECT else {
          fail("catalog capability disabled: select")
        }
        let prepared = prepare_selection(
          program.schema,
          select,
          query.parameters,
        )
        selections[query.name] = prepared
        prepared.output.map(b => b.name)
      }
      PreparedUpdate(name, setters, predicate, returning) => {
        guard CAP_STATEMENT_UPDATE else {
          fail("catalog capability disabled: update")
        }
        let (prepared, names) = prepare_update(
          program.schema,
          name,
          setters,
          predicate,
          returning,
          query.parameters,
          layouts=update_layouts,
        )
        updates[query.name] = prepared
        names
      }
      _ => prepared_names(program.schema, query.statement, query.parameters)
    }
    guard names == query.names else {
      fail("invalid compiled query result metadata")
    }
    queries[query.name] = query
  }
  {
    schema: program.schema,
    queries,
    selections,
    updates,
    id,
    storage: program.storage,
  }
}

///|
/// Load an application build artifact once. It is not an untrusted SQL endpoint.
fn Program::load(input : String) -> Program raise SqliteError {
  try {
    guard input.length() <= 1048576 else {
      fail("compiled program resource limit")
    }
    let program : CompiledProgram = @json.from_json(@json.parse(input))
    let validated = prepare_compiled_program(program, "")
    { ..validated, id: program_id(@json.to_json(program).stringify()), }
  } catch {
    error =>
      raise interface_error(
        match error {
          SqlError(message) => message
          _ => error.to_string()
        },
      )
  }
}

///|
fn Program::query(self : Program, name : String) -> Query raise SqliteError {
  guard self.queries.get(name) is Some(plan) else {
    raise sqlite_misuse("unknown query in compiled catalog: " + name)
  }
  {
    program_id: self.id,
    plan,
    selection: self.selections.get(name),
    update: self.updates.get(name),
  }
}

///|
fn Connection::from_program(program : Program) -> Connection {
  {
    database: {
      store: copy_store(program.schema),
      serial: 0,
      schema_epoch: 0L,
    },
    program: Some(program),
    closed: false,
    statements: 0,
  }
}

///|
fn Connection::prepare_compiled(
  self : Connection,
  query : Query,
) -> Statement raise SqliteError {
  self.healthy()
  guard self.program is Some(program) && program.id == query.program_id else {
    raise sqlite_misuse("compiled query belongs to a different program")
  }
  let plan = query.plan
  statement_new(
    self,
    plan.parameters,
    plan.names,
    data_readonly(plan.statement),
    params => {
      execute_data_statement(
        self.database.store,
        plan.statement,
        params,
        prepared_selection=query.selection,
        prepared_update=query.update,
      )
    },
    tracks_changes=!data_readonly(plan.statement),
  )
}

// Source: primary_index.mbt

///|
/// Derived persistent point indexes. Fork mutable wrappers, share immutable
/// roots, and read current row values through stable physical slots.
priv struct PrimaryIndex {
  mut slots : @rowmap.HashMap[Int64, Int32]
  mut keys : @rowmap.HashMap[String, Int64]
  mut maximum : Int64?
}

///|
fn primary_value_key(table : Table, values : Array[Value]) -> String? {
  let parts : Array[Json] = []
  for i in primary_key(table) {
    guard primary_part_key(
        values[i],
        column_affinity(table, table.columns[i]),
        table.columns[i].collation,
      )
      is Some(part) else {
      return None
    }
    parts.push(part)
  }
  if parts.is_empty() {
    None
  } else {
    Some(Json::array(parts).stringify())
  }
}

///|
fn primary_part_key(
  input : Value,
  affinity : String,
  collation : String,
) -> Json? {
  let mut value = apply_affinity(input, affinity)
  if value is Null {
    return None
  }
  if value is Real(n) &&
    n >= -9223372036854775808.0 &&
    n < 9223372036854775808.0 &&
    n.to_int64().to_double() == n {
    value = Integer(n.to_int64())
  }
  if value is Text(s) {
    if collation == "nocase" {
      return Some(
        Json::array([
          Json::number(@utf8.encode(s).length().to_double()),
          value_json(Text(nocase_prefix(s))),
        ]),
      )
    }
    if collation == "rtrim" {
      value = Text(s.trim_end(chars=" ").to_owned())
    }
  }
  Some(value_json(value))
}

///|
fn primary_index(store : Store, table : Table) -> PrimaryIndex {
  if store.primary_indexes.get(table.name) is Some(index) {
    return index
  }
  let slots : Array[(Int64, Int32)] = []
  let keys : Array[(String, Int64)] = []
  let composite = integer_primary(table) < 0
  let mut maximum : Int64? = None
  for (slot, row) in table.rows.slot_entries() {
    maximum = Some(maximum.map(n => n.max(row.id)).unwrap_or(row.id))
    slots.push((row.id, slot))
    if composite && primary_value_key(table, row.values) is Some(key) {
      keys.push((key, row.id))
    }
  }
  let index : PrimaryIndex = {
    slots: @rowmap.HashMap(slots[:]),
    keys: @rowmap.HashMap(keys[:]),
    maximum: Some(maximum.unwrap_or(0L)),
  }
  if store.primary_indexes.length() >= 4 {
    store.primary_indexes.clear()
  }
  store.primary_indexes[table.name] = index
  index
}

///|
fn update_primary_index(
  store : Store,
  table : Table,
  previous : StoredRow?,
  next : StoredRow?,
) -> Unit {
  if !FEATURE_PRIMARY_INDEX {
    return
  }
  if store.primary_indexes.get(table.name) is Some(index) {
    if previous is Some(row) &&
      next.map(r => r.id) != Some(row.id) &&
      index.maximum == Some(row.id) {
      index.maximum = None
    }
    if next is Some(row) {
      if previous is None && table.rows.is_empty() {
        index.maximum = Some(row.id)
      } else if index.maximum is Some(maximum) {
        index.maximum = Some(maximum.max(row.id))
      }
    }
    let slot = match previous {
      Some(row) => index.slots.get(row.id).unwrap_or(table.rows.used)
      None => table.rows.used
    }
    if previous is Some(row) && next.map(r => r.id) != Some(row.id) {
      index.slots = index.slots.remove(row.id)
    }
    if next is Some(row) && index.slots.get(row.id) != Some(slot) {
      index.slots = index.slots.add(row.id, slot)
    }
    if integer_primary(table) >= 0 {
      return
    }
    if previous is Some(row) {
      if primary_value_key(table, row.values) is Some(key) {
        index.keys = index.keys.remove(key)
      }
    }
    if next is Some(row) {
      if primary_value_key(table, row.values) is Some(key) {
        index.keys = index.keys.add(key, row.id)
      }
    }
  }
}

///|
/// Derived allocation metadata. Removing the maximum invalidates just this
/// value; the next automatic allocation scans once. Restore/clone remain safe.
fn maximum_rowid(store : Store, table : Table) -> Int64 {
  let index = if FEATURE_PRIMARY_INDEX {
    Some(primary_index(store, table))
  } else {
    None
  }
  if index is Some(index) && index.maximum is Some(maximum) {
    return if table.autoincrement {
      maximum.max(table.sequence)
    } else {
      maximum
    }
  }
  let mut maximum : Int64? = None
  for row in table.rows {
    maximum = Some(maximum.map(n => n.max(row.id)).unwrap_or(row.id))
  }
  let result = maximum.unwrap_or(0L)
  if index is Some(index) {
    index.maximum = Some(result)
  }
  if table.autoincrement {
    result.max(table.sequence)
  } else {
    result
  }
}

///|
fn primary_row(index : PrimaryIndex, table : Table, id : Int64) -> StoredRow? {
  match index.slots.get(id) {
    Some(slot) => table.rows.get_slot(slot)
    None => None
  }
}

///|
fn primary_key_row(
  index : PrimaryIndex,
  table : Table,
  key : String,
) -> StoredRow? {
  match index.keys.get(key) {
    Some(id) => primary_row(index, table, id)
    None => None
  }
}

///|
fn table_row_by_id(store : Store, table : Table, id : Int64) -> StoredRow? {
  if FEATURE_PRIMARY_INDEX {
    primary_row(primary_index(store, table), table, id)
  } else {
    table.rows.iter().find_first(row => row.id == id)
  }
}

///|
fn primary_terms(
  table : Table,
  predicate : Expr,
  params : Array[Value],
  qualifier : String,
  values : Map[Int32, Value],
) -> Unit {
  match predicate {
    Binary("and", a, b) => {
      primary_terms(table, a, params, qualifier, values)
      primary_terms(table, b, params, qualifier, values)
    }
    Binary(op, a, b) => {
      if op != "=" && op != "==" {
        return
      }
      for (column, expression) in [(a, b), (b, a)] {
        if column is Column(q, name) &&
          (q == "" || matches_identifier(q, identifier(qualifier))) {
          for i in primary_key(table) {
            if matches_identifier(table.columns[i].name, identifier(name)) {
              match expression {
                Literal(value) => values[i] = value
                Parameter(p) => if p < params.length() { values[i] = params[p] }
                _ => ()
              }
            }
          }
        }
      }
    }
    _ => ()
  }
}

///|
/// Some([]) is an indexed miss. None means a scan is necessary. The original
/// predicate is always evaluated so additional clauses retain SQL semantics.
fn primary_candidates(
  store : Store,
  table : Table,
  predicate : Expr,
  params : Array[Value],
  qualifier : String,
) -> Array[StoredRow]? {
  if !FEATURE_PRIMARY_INDEX {
    return None
  }
  if rowid_equality(table, predicate, params, qualifier) is Some(id) {
    return Some(
      primary_row(primary_index(store, table), table, id)
      .map(r => [r])
      .unwrap_or([]),
    )
  }
  let keys = primary_key(table)
  if keys.is_empty() {
    return None
  }
  let values : Map[Int32, Value] = Map([])
  primary_terms(table, predicate, params, qualifier, values)
  if !keys.all(i => values.contains(i)) {
    return None
  }
  let row : Array[Value] = Array::make(table.columns.length(), Null)
  for i in keys {
    row[i] = values[i]
  }
  let ipk = integer_primary(table)
  if ipk >= 0 {
    let value = apply_affinity(
      row[ipk],
      column_affinity(table, table.columns[ipk]),
    )
    let id = match value {
      Integer(n) => Some(n)
      Real(n) =>
        if n >= -9223372036854775808.0 &&
          n < 9223372036854775808.0 &&
          n.to_int64().to_double() == n {
          Some(n.to_int64())
        } else {
          None
        }
      _ => None
    }
    return Some(
      match id {
        Some(n) =>
          primary_row(primary_index(store, table), table, n)
          .map(r => [r])
          .unwrap_or([])
        None => []
      },
    )
  }
  if primary_value_key(table, row) is Some(key) {
    return Some(
      primary_key_row(primary_index(store, table), table, key)
      .map(r => [r])
      .unwrap_or([]),
    )
  }
  Some([])
}

// Source: program_compiler.mbt

///|
#derive(FromJson)
priv struct QueryInput {
  name : String
  sql : String
}

///|
#derive(FromJson)
priv struct ProgramInput {
  schema : Array[String]
  queries : Array[QueryInput]
  storage : StoragePlan?
}

///|
fn compile_program(request : String) -> String {
  try {
    guard request.length() <= 1048576 else {
      fail("compiler input resource limit")
    }
    let input : ProgramInput = @json.from_json(@json.parse(request))
    let db = database_open()
    for sql in input.schema {
      let parser = lex(sql)
      let statement = parse_statement(parser)
      guard parser.parameter == 0 &&
        (
          statement is CreateTable(_, _) ||
          statement is CreateTableAs(_, _, _) ||
          statement is CreateObject(_, _)
        ) else {
        fail("schema catalog accepts CREATE TABLE/INDEX/VIEW/TRIGGER only")
      }
      if statement is CreateTableAs(_, select, _) {
        validate_ctas_selection(db.store, select, true, 0)
      }
      ignore(execute_statement(db.store, statement, []))
    }
    for object in db.store.objects {
      if object.kind == "trigger" {
        prepare_trigger(db.store, get_table(db.store, object.table), object)
      }
    }
    let queries : Array[CompiledQuery] = []
    for query in input.queries {
      let parser = lex(query.sql)
      let parsed = parse_statement(parser)
      let statement = match parsed {
        Transaction(op, name) => PreparedTransaction(op, name)
        Select(select) => PreparedSelect(select)
        Pragma(name, table, None) => PreparedPragma(name, table)
        Insert(insert) => PreparedInsert(insert)
        Update(name, setters, predicate, returning) =>
          PreparedUpdate(name, setters, predicate, returning)
        Delete(name, predicate, returning) =>
          PreparedDelete(name, predicate, returning)
        _ => fail("runtime query catalog cannot contain DDL or writable PRAGMA")
      }
      queries.push({
        name: query.name,
        parameters: parser.parameter,
        names: prepared_names(db.store, statement, parser.parameter),
        statement,
      })
    }
    // Declaration spelling is observable only through table_info/xinfo. Leave
    // other application artifacts byte-compatible and keep the AOT parser absent.
    if !queries.any(q => {
        match q.statement {
          PreparedPragma("table_info", _) | PreparedPragma("table_xinfo", _) =>
            true
          _ => false
        }
      }) {
      for table in db.store.tables {
        for col in table.columns {
          col.default_source = None
        }
      }
    }
    let program : CompiledProgram = {
      format: "moon-aot@1",
      schema: db.store,
      queries,
      storage: input.storage,
    }
    let result = @json.to_json(program).stringify()
    ignore(Program::load(result))
    result
  } catch {
    error =>
      (
        {
          "error": match error {
            SqlError(message) => message
            SqliteError(msg=message, ..) => message
            _ => error.to_string()
          },
        } : Json).stringify()
  }
}

// Source: query.mbt

///|
/// Result columns survive even when a CTE/view produces no rows.
priv struct Relation {
  rows : Array[Environment]
  template : Environment
}

///|
/// Virtual schema rows use the same evaluator as user tables.
fn schema_binding(name : String, value : Value) -> Binding {
  {
    ..binding(name, value),
    // Logical schemas do not track SQLite's physical page allocation or the
    // persistent sqlite_schema rowids. Never expose placeholder values.
    readable: name != "rootpage" && name != "rowid",
    affinity: if name == "rootpage" || name == "rowid" {
      "integer"
    } else {
      "text"
    },
  }
}

///|
fn schema_rows(store : Store) -> Array[Environment] {
  let rows : Array[Environment] = []
  for table in store.tables {
    rows.push([
      schema_binding("type", Text("table")),
      schema_binding("name", Text(table.name)),
      schema_binding("tbl_name", Text(table.name)),
      schema_binding("rootpage", Integer(0L)),
      schema_binding("sql", Text(table.sql)),
      {
        ..schema_binding("rowid", Integer((rows.length() + 1).to_int64())),
        hidden: true,
      },
    ])
  }
  for object in store.objects {
    rows.push([
      schema_binding("type", Text(object.kind)),
      schema_binding("name", Text(object.name)),
      schema_binding("tbl_name", Text(object.table)),
      schema_binding("rootpage", Integer(0L)),
      schema_binding("sql", Text(object.sql)),
      {
        ..schema_binding("rowid", Integer((rows.length() + 1).to_int64())),
        hidden: true,
      },
    ])
  }
  rows
}

///|
fn source_rows(
  store : Store,
  name : String,
  params : Array[Value],
  ctes : Map[String, Relation],
  depth : Int32,
) -> Array[Environment] raise SqlError {
  guard depth <= 16 else { fail("SQL view/CTE recursion limit") }
  if ctes.get(identifier(name)) is Some(relation) {
    return source_column_rows(relation.rows)
  }
  if identifier(name) == "sqlite_schema" || identifier(name) == "sqlite_master" {
    return schema_rows(store)
  }
  for object in store.objects {
    if identifier(object.name) == identifier(name) && object.kind == "view" {
      guard object.selection is Some(selection) else {
        fail("view has no compiled query")
      }
      return source_column_rows(
        select_rows(store, selection, params, depth + 1),
      )
    }
  }
  let table = get_table(store, name)
  let rows = table.rows.copy()
  if table.without_rowid {
    let keys = primary_key(table)
    rows.sort_by((a, b) => {
      for i in keys {
        let c = compare_stored(
          store,
          a.values[i],
          b.values[i],
          table.columns[i].collation,
        )
        if c != 0 {
          return c
        }
      }
      0
    })
  } else {
    rows.sort_by((a, b) => a.id.compare(b.id))
  }
  let layout = row_environment(
    table,
    { id: 0L, values: Array::make(table.columns.length(), Null), },
    name,
  )
  rows.map(row => row_environment_from(layout, row))
}

///|
/// A compound's raw results preserve INTEGER cells, but reading a derived REAL
/// column applies SQLite's RealAffinity. FLEXNUM/NUMERIC columns keep the cells.
fn source_column_rows(rows : Array[Environment]) -> Array[Environment] {
  if rows.is_empty() || !rows[0].any(b => b.affinity == "real") {
    return rows
  }
  rows.map(row => {
    if row.any(b => b.affinity == "real" && b.value is Integer(_)) {
      row.map(b => {
        if b.affinity == "real" && b.value is Integer(n) {
          { ..b, value: Real(n.to_double()), }
        } else {
          b
        }
      })
    } else {
      row
    }
  })
}

///|
fn empty_source(
  store : Store,
  source : Source,
  ctes : Map[String, Relation],
  params : Array[Value],
  depth : Int32,
) -> Environment raise SqlError {
  if FEATURE_JSON_TABLE && json_table_source(source) {
    return json_table_template(source)
  }
  if ctes.get(identifier(source.name)) is Some(relation) {
    return relation.template.map(b => {
      ..b,
      value: Null,
      qualifier: source.qualifier,
    })
  }
  if identifier(source.name) == "sqlite_schema" ||
    identifier(source.name) == "sqlite_master" {
    return ["type", "name", "tbl_name", "rootpage", "sql", "rowid"].map(n => {
      ..schema_binding(n, Null),
      qualifier: source.qualifier,
      hidden: n == "rowid",
    })
  }
  for object in store.objects {
    if identifier(object.name) == identifier(source.name) &&
      object.kind == "view" {
      guard object.selection is Some(select) else {
        fail("view has no compiled query")
      }
      let template = selection_template(select, {
        ..evaluation(store, params, []),
        depth: depth + 1,
      })
      return template.map(b => {
        ..b,
        value: Null,
        qualifier: source.qualifier,
      })
    }
  }
  let table = get_table(store, source.name)
  row_environment(
    table,
    { id: 0L, values: Array::make(table.columns.length(), Null), },
    source.qualifier,
  )
}

///|
fn sort_query_rows(
  rows : Array[QueryRow],
  orders : Array[Ordering],
  collations : Array[String],
) -> Unit {
  rows.sort_by((a, b) => {
    for i, order in orders {
      let c = ordering_compare(
        a.context.store,
        order,
        a.keys[i],
        b.keys[i],
        collations[i],
      )
      if c != 0 {
        return c
      }
    }
    a.context.position.compare(b.context.position)
  })
}

///|
fn select_relation_in(
  select : Selection,
  context : Evaluation,
  existence : Bool,
  prepared~ : PreparedSelection? = None,
  source_only~ : Bool = false,
) -> Relation raise SqlError {
  if CAP_QUERY_COMPOUND && select.compound is Some(_) {
    return compound_relation(select, context, existence)
  }
  let store = context.store
  let params = context.params
  let depth = context.depth
  let mut metadata = prepared
  guard depth <= 16 else { fail("SQL query recursion limit") }
  let output_template = if FEATURE_UPDATE_FROM && source_only {
    []
  } else {
    match prepared {
      Some(plan) => plan.output
      None => selection_template(select, context)
    }
  }
  if prepared is None &&
    !existence &&
    (!FEATURE_UPDATE_FROM || !source_only) &&
    context.outer.is_empty() &&
    context.row.is_empty() &&
    context.ctes.is_empty() {
    let inferred = prepare_selection(
      store,
      select,
      params.length(),
      output=Some(output_template),
    )
    if CAP_QUERY_SOURCE &&
      inferred.point is Some(plan) &&
      execute_bound_point(plan, store, params) is Some(rows) {
      return { rows, template: output_template, }
    }
    metadata = Some(inferred)
  }
  let cache_budget = in_cache_budget()
  let execution = {
    ..context,
    row_metadata: if FEATURE_ROW_VALUES {
      metadata.map(m => m.row_metadata).unwrap_or([])
    } else {
      []
    },
    in_lists: if OPT_IN_LIST_LOOKUP {
      in_list_frames(
        metadata.map(m => m.in_lists).unwrap_or([]),
        budget=cache_budget,
      )
    } else {
      []
    },
    in_selects: if OPT_IN_SELECT_LOOKUP && CAP_QUERY_IN_SELECT {
      in_select_frames(
        metadata.map(m => m.in_selects).unwrap_or([]),
        budget=cache_budget,
      )
    } else {
      []
    },
  }
  if CAP_QUERY_SOURCE &&
    CAP_FUNCTION_AGGREGATES &&
    FEATURE_JSON_TABLE &&
    (!FEATURE_UPDATE_FROM || !source_only) &&
    !existence &&
    json_table_aggregate(select, execution, output_template) is Some(result) {
    return result
  }
  if CAP_QUERY_SOURCE &&
    CAP_FUNCTION_AGGREGATES &&
    (!FEATURE_UPDATE_FROM || !source_only) &&
    !existence &&
    simple_aggregate(
      select,
      execution,
      output_template,
      filter=if OPT_AGGREGATE_SCAN {
        if OPT_IN_LIST_LOOKUP && select.predicate is Call("in", _) {
          in_list_aggregate_filter(select, execution)
        } else if OPT_IN_SELECT_LOOKUP && CAP_QUERY_IN_SELECT {
          in_select_aggregate_filter(select, execution)
        } else {
          None
        }
      } else {
        None
      },
    )
    is Some(result) {
    return result
  }
  if CAP_QUERY_SOURCE &&
    !existence &&
    (!FEATURE_UPDATE_FROM || !source_only) &&
    simple_relation(
      select,
      execution,
      output_template,
      prepared=match metadata {
        Some(plan) => plan.simple
        None => None
      },
    )
    is Some(result) {
    return result
  }
  let ctes : Map[String, Relation] = if CAP_QUERY_CTE {
    Map(context.ctes.to_array())
  } else {
    context.ctes
  }
  if CAP_QUERY_CTE {
    for (name, selection) in select.ctes {
      ctes[identifier(name)] = execute_cte(select, name, selection, {
        ..context,
        ctes,
      })
    }
  }
  let json_budget : JsonTableBudget? = if FEATURE_JSON_TABLE &&
    select.sources.any(json_table_source) {
    json_table_joins(select.sources)
    Some({ bytes: 0, nodes: 0, paths: 0, })
  } else {
    None
  }
  let mut input : Array[Environment] = [[]]
  let mut template : Environment = []
  if CAP_QUERY_SOURCE {
    if !CAP_QUERY_JOIN {
      if select.sources.length() == 1 {
        let source = select.sources[0]
        if FEATURE_JSON_TABLE && json_table_source(source) {
          let joined = json_table_join(
            source,
            input,
            template,
            { ..context, ctes, },
            json_budget.unwrap(),
            select.predicate,
          )
          input = joined.rows
          template = joined.template
        } else {
          input = source_rows(store, source.name, params, ctes, depth).map(row => {
            row.map(b => { ..b, qualifier: source.qualifier, })
          })
          guard input.length() <= 100000 else {
            fail("SQL result resource limit")
          }
          template = empty_source(store, source, ctes, params, depth)
        }
      }
    } else {
      for source in select.sources {
        if FEATURE_JSON_TABLE && json_table_source(source) {
          let joined = json_table_join(
            source,
            input,
            template,
            { ..context, ctes, },
            json_budget.unwrap(),
            select.predicate,
          )
          input = joined.rows
          template = joined.template
          continue
        }
        if source.right == Some(true) && !FEATURE_OUTER_JOIN {
          fail("feature disabled: rightFullJoin")
        }
        let right = source_rows(store, source.name, params, ctes, depth).map(row => {
          row.map(b => { ..b, qualifier: source.qualifier, })
        })
        let empty = empty_source(store, source, ctes, params, depth)
        prepare_expression(
          source.on,
          { ..context, ctes, row: template + empty, forbid_json_inputs: true, },
          false,
          false,
        )
        let pairs = using_pairs(source, template, empty)
        let track_right = FEATURE_OUTER_JOIN && source.right == Some(true)
        let empty_left = if track_right {
          template.map(b => { ..b, value: Null, })
        } else {
          []
        }
        template = using_row(source, template, empty, pairs)
        let matched_right = if track_right {
          Array::make(right.length(), false)
        } else {
          []
        }
        let next : Array[Environment] = []
        for left in input {
          let mut matched = false
          for ri, row in right {
            let joined = left + row
            if truth(evaluate(source.on, { ..context, ctes, row: joined, })) ==
              1 &&
              using_matches(left, row, pairs, context) {
              next.push(using_row(source, left, row, pairs))
              matched = true
              if track_right {
                matched_right[ri] = true
              }
            }
            guard next.length() <= 100000 else {
              fail("SQL result resource limit")
            }
          }
          if source.left && !matched {
            next.push(using_row(source, left, empty, pairs))
          }
        }
        if FEATURE_OUTER_JOIN && source.right == Some(true) {
          for ri, row in right {
            if !matched_right[ri] {
              next.push(using_row(source, empty_left, row, pairs))
            }
            guard next.length() <= 100000 else {
              fail("SQL result resource limit")
            }
          }
        }
        input = next
      }
    }
  }
  let base : Evaluation = { ..execution, ctes, row: template, }
  if FEATURE_UPDATE_FROM && source_only {
    return { rows: input, template, }
  }
  input = input.filter(row => {
    truth(evaluate(select.predicate, { ..base, row, })) == 1
  })
  let groups : Array[Array[Environment]] = []
  if CAP_QUERY_GROUP_BY && !select.groups.is_empty() {
    let collations = select.groups.map(e => expression_collation(e, base))
    let keys : Array[Array[Value]] = []
    for row in input {
      let values = select.groups.map(e => evaluate(e, { ..base, row, }))
      let mut found = -1
      for i, key in keys {
        if key.length() == values.length() &&
          key
          .mapi((j, v) => {
            compare_stored(store, v, values[j], collations[j]) == 0
          })
          .all(v => v) {
          found = i
          break
        }
      }
      if found < 0 {
        keys.push(values)
        groups.push([row])
      } else {
        groups[found].push(row)
      }
    }
  } else if select.projections.any(p => aggregate(p.expression)) {
    groups.push(input)
  } else {
    for row in input {
      groups.push([row])
    }
  }
  let representative = if CAP_QUERY_AGGREGATE_REPRESENTATIVE {
    match metadata {
      Some(plan) => plan.representative
      None => aggregate_representative_plan(select)
    }
  } else {
    None
  }
  let contexts : Array[Evaluation] = []
  for group in groups {
    let ctx = {
      ..base,
      row: if CAP_QUERY_AGGREGATE_REPRESENTATIVE && representative is Some(plan) {
        aggregate_representative_row(plan, group, base, template)
      } else if group.is_empty() {
        template
      } else {
        group[0]
      },
      group: Some(group),
      position: contexts.length(),
      window_values: Map([]),
    }
    if truth(evaluate(select.having, ctx)) == 1 {
      contexts.push(ctx)
    }
  }
  if existence {
    let rows = if CAP_QUERY_LIMIT_OFFSET {
      let (count, start) = query_limit(select, base)
      contexts
      .mapi((i, _) => i)
      .filter(i => {
        i.to_int64() >= start.max(0L) &&
        (count < 0L || i.to_int64() - start.max(0L) < count)
      })
      .map(_ => ([] : Environment))
    } else {
      contexts.map(_ => [])
    }
    return { rows, template: output_template, }
  }
  let numbered : Map[Int32, Array[Int32]] = Map([])
  if FEATURE_WINDOWS {
    let window_expressions : Array[Expr] = []
    for p in select.projections {
      collect_windows(p.expression, window_expressions)
    }
    for o in select.orders {
      collect_windows(ordering_expression(o.expression), window_expressions)
    }
    compute_windows(window_expressions, contexts, base)
    // row_number has its own ORDER BY, independently of final result ordering.
    for pi, projection in select.projections {
      if projection.expression is RowNumber(orders) {
        let ranked = contexts.map(ctx => {
          output: [],
          context: ctx,
          keys: orders.map(o => evaluate(ordering_expression(o.expression), ctx)),
        })
        let collations = orders.map(o => {
          expression_collation(ordering_expression(o.expression), base)
        })
        sort_query_rows(ranked, orders, collations)
        let positions = Array::make(contexts.length(), 0)
        for i, row in ranked {
          positions[row.context.position] = i + 1
        }
        numbered[pi] = positions
      }
    }
  }
  let output : Array[QueryRow] = []
  for ctx in contexts {
    let projected = project(select.projections, ctx)
    if FEATURE_WINDOWS {
      for pi, _ in select.projections {
        if numbered.get(pi) is Some(positions) {
          projected[pi] = {
            ..projected[pi],
            value: Integer(positions[ctx.position].to_int64()),
          }
        }
      }
    }
    if CAP_QUERY_DISTINCT &&
      select.distinct &&
      output.any(previous => {
        previous.output.length() == projected.length() &&
        previous.output
        .mapi((i, b) => {
          compare_stored(store, b.value, projected[i].value, b.collation) == 0
        })
        .all(b => b)
      }) {
      continue
    }
    let keys = if CAP_QUERY_ORDER_BY {
      query_order_keys(select, projected, ctx)
    } else {
      []
    }
    output.push({ output: projected, context: ctx, keys, })
  }
  if CAP_QUERY_ORDER_BY {
    sort_query_rows(
      output,
      select.orders,
      query_order_collations(select, output_template, base),
    )
  }
  let rows = if CAP_QUERY_LIMIT_OFFSET {
    let (count, start) = query_limit(select, base)
    output
    .mapi((i, row) => (i, row))
    .filter(pair => {
      pair.0.to_int64() >= start.max(0L) &&
      (count < 0L || pair.0.to_int64() - start.max(0L) < count)
    })
    .map(pair => pair.1.output)
  } else {
    output.map(row => row.output)
  }
  { rows, template: output_template, }
}

///|
fn query_limit(
  select : Selection,
  base : Evaluation,
) -> (Int64, Int64) raise SqlError {
  if CAP_QUERY_LIMIT_OFFSET {
    let limit = apply_affinity(evaluate(select.limit, base), "integer")
    let offset = apply_affinity(evaluate(select.offset, base), "integer")
    guard limit is Integer(count) && offset is Integer(start) else {
      fail("datatype mismatch: LIMIT/OFFSET")
    }
    (count, start)
  } else {
    (-1L, 0L)
  }
}

///|
fn query_order_keys(
  select : Selection,
  projected : Environment,
  ctx : Evaluation,
) -> Array[Value] raise SqlError {
  let ordering_ctx = {
    ..ctx,
    row: projected +
    ctx.row.filter(b => {
      b.qualifier != "" ||
      !projected.any(p => identifier(p.name) == identifier(b.name))
    }),
  }
  select.orders.map(o => {
    match ordering_expression(o.expression) {
      Literal(Integer(n)) => {
        guard n >= 1L && n <= projected.length().to_int64() else {
          fail("ORDER BY position out of range")
        }
        projected[n.to_int() - 1].value
      }
      _ => evaluate(ordering_expression(o.expression), ordering_ctx)
    }
  })
}

///|
fn query_order_collations(
  select : Selection,
  output_template : Environment,
  base : Evaluation,
) -> Array[String] raise SqlError {
  select.orders.map(o => {
    match ordering_expression(o.expression) {
      Literal(Integer(n)) => output_template[n.to_int() - 1].collation
      Column("", name) => {
        let projection = select.projections.filter(p => {
          identifier(p.label) == identifier(name)
        })
        if projection.length() == 1 {
          expression_collation(projection[0].expression, base)
        } else {
          expression_collation(ordering_expression(o.expression), base)
        }
      }
      _ => expression_collation(ordering_expression(o.expression), base)
    }
  })
}

///|
fn select_rows(
  store : Store,
  select : Selection,
  params : Array[Value],
  depth : Int32,
  prepared~ : PreparedSelection? = None,
) -> Array[Environment] raise SqlError {
  select_relation_in(
    select,
    { ..evaluation(store, params, []), depth, },
    false,
    prepared~,
  ).rows
}

///|
/// Validate source scopes without evaluating rows or retaining source data.
fn selection_source_context(
  select : Selection,
  context : Evaluation,
) -> Evaluation raise SqlError {
  guard context.depth <= 16 else { fail("SQL query recursion limit") }
  let ctes : Map[String, Relation] = if CAP_QUERY_CTE {
    Map(context.ctes.to_array())
  } else {
    context.ctes
  }
  if CAP_QUERY_CTE {
    for (name, selection) in select.ctes {
      ctes[identifier(name)] = prepare_cte(select, name, selection, {
        ..context,
        ctes,
      })
    }
  }
  if FEATURE_JSON_TABLE {
    json_table_joins(select.sources)
  }
  let mut row : Environment = []
  if CAP_QUERY_SOURCE {
    for source in select.sources {
      if source.right == Some(true) && !FEATURE_OUTER_JOIN {
        fail("feature disabled: rightFullJoin")
      }
      if FEATURE_JSON_TABLE && json_table_source(source) {
        prepare_json_table(source, { ..context, ctes, row, })
      }
      let right = empty_source(
        context.store,
        source,
        ctes,
        context.params,
        context.depth,
      )
      let condition = if FEATURE_JSON_TABLE && json_table_source(source) {
        let (_, _, _, condition) = json_table_parts(source)
        condition
      } else {
        source.on
      }
      prepare_expression(
        condition,
        { ..context, ctes, row: row + right, forbid_json_inputs: true, },
        false,
        false,
      )
      row = if CAP_QUERY_JOIN {
        using_row(source, row, right, using_pairs(source, row, right))
      } else {
        right
      }
    }
  }
  { ..context, ctes, row, }
}

///|
/// Resolve SELECT output and correlated scopes without evaluating any values.
fn selection_template(
  select : Selection,
  context : Evaluation,
  source_only~ : Bool = false,
) -> Environment raise SqlError {
  let base = selection_source_context(select, context)
  let ctes = base.ctes
  let row = base.row
  if FEATURE_UPDATE_FROM && source_only {
    return row
  }
  validate_aggregate_output(select, base)
  prepare_expression(
    select.predicate,
    { ..base, forbid_json_inputs: true, },
    false,
    false,
  )
  for e in select.groups {
    prepare_expression(e, base, false, false)
  }
  prepare_expression(
    select.having,
    { ..base, forbid_json_inputs: true, },
    true,
    false,
  )
  let mut output = project_template(select.projections, base)
  if CAP_QUERY_COMPOUND && select.compound is Some(arms) {
    let templates = [output]
    for (_, arm) in arms {
      let template = selection_template(arm, { ..context, ctes, })
      guard template.length() == output.length() else {
        fail("SELECTs do not have the same number of result columns")
      }
      templates.push(template)
    }
    output = compound_column_template(select, { ..context, ctes, }, templates)
  }
  if CAP_QUERY_ORDER_BY {
    let ordering = { ..base, row: output + row, }
    for order in select.orders {
      if CAP_QUERY_COMPOUND && select.compound is Some(_) {
        ignore(
          compound_order_index(
            select,
            ordering_expression(order.expression),
            output.length(),
          ),
        )
      } else if ordering_expression(order.expression) is Literal(Integer(n)) {
        guard n >= 1L && n <= output.length().to_int64() else {
          fail("ORDER BY position out of range")
        }
      } else {
        prepare_expression(
          ordering_expression(order.expression),
          ordering,
          true,
          true,
        )
      }
    }
  }
  if CAP_QUERY_LIMIT_OFFSET {
    prepare_expression(select.limit, context, false, false)
    prepare_expression(select.offset, context, false, false)
  }
  output
}

///|
/// A compound SELECT returns the first arm's labels, but SQLite's scalar
/// expression metadata comes from the rightmost arm. Carry its WITH scope.
fn subquery_metadata_selection(select : Selection) -> Selection {
  if !CAP_QUERY_COMPOUND {
    return select
  }
  let mut current = select
  while current.compound is Some(arms) && !arms.is_empty() {
    let last = arms[arms.length() - 1].1
    let names = current.cte_names.unwrap_or([]) + last.cte_names.unwrap_or([])
    current = {
      ..last,
      ctes: current.ctes + last.ctes,
      recursive: if current.recursive == Some(true) ||
        last.recursive == Some(true) {
        Some(true)
      } else {
        None
      },
      cte_names: if names.is_empty() {
        None
      } else {
        Some(names)
      },
    }
  }
  current
}

// Source: query_plan.mbt

///|
/// Conservative execution shortcuts. Plans contain no persistent index state.
fn rowid_column(table : Table, expression : Expr, qualifier : String) -> Bool {
  guard expression is Column(q, name) else { return false }
  if q != "" && !matches_identifier(q, identifier(qualifier)) {
    return false
  }
  let key = identifier(name)
  for i, column in table.columns {
    if matches_identifier(column.name, key) {
      return i == integer_primary(table)
    }
  }
  !table.without_rowid && ["rowid", "_rowid_", "oid"].contains(key)
}

///|
fn rowid_value(expression : Expr, params : Array[Value]) -> Int64? {
  match expression {
    Literal(Integer(value)) => Some(value)
    Parameter(i) =>
      if i < params.length() && params[i] is Integer(value) {
        Some(value)
      } else {
        None
      }
    _ => None
  }
}

///|
/// Other storage classes retain the evaluator's affinity/coercion behavior.
fn rowid_equality(
  table : Table,
  predicate : Expr,
  params : Array[Value],
  qualifier : String,
) -> Int64? {
  guard predicate is Binary(op, left, right) && (op == "=" || op == "==") else {
    return None
  }
  if rowid_column(table, left, qualifier) {
    rowid_value(right, params)
  } else if rowid_column(table, right, qualifier) {
    rowid_value(left, params)
  } else {
    None
  }
}

///|
/// Use the primary index for a requested rowid when enabled; otherwise filter rows.
fn candidate_rows(
  store : Store,
  table : Table,
  rowid : Int64?,
) -> Array[StoredRow] {
  if rowid is Some(id) {
    if FEATURE_PRIMARY_INDEX {
      primary_row(primary_index(store, table), table, id)
      .map(r => [r])
      .unwrap_or([])
    } else {
      table.rows.filter(r => r.id == id)
    }
  } else {
    table.rows.copy()
  }
}

///|
fn rowid_order(select : Selection, table : Table, qualifier : String) -> Bool {
  if select.orders.is_empty() {
    return true
  }
  guard select.orders.length() == 1 && !select.orders[0].descending else {
    return false
  }
  let expression = select.orders[0].expression
  if expression is Column("", name) {
    let key = identifier(name)
    // ORDER BY prefers output aliases over the original source column.
    for projection in select.projections {
      if projection.expression is Star(_) {
        for column in table.columns {
          if matches_identifier(column.name, key) {
            return rowid_column(
              table,
              Column(qualifier, column.name),
              qualifier,
            )
          }
        }
      }
      if matches_identifier(projection.label, key) {
        return rowid_column(table, projection.expression, qualifier)
      }
    }
  }
  rowid_column(table, expression, qualifier)
}

///|
priv enum RowProjection {
  Stored(Int32)
  RowidValue
  Constant(Value)
}

///|
/// Resolve positions for a single physical source. Correlated output falls back.
fn simple_projection(
  select : Selection,
  table : Table,
  qualifier : String,
) -> Array[RowProjection]? {
  let plan : Array[RowProjection] = []
  for projection in select.projections {
    match projection.expression {
      Literal(value) => plan.push(Constant(value))
      Star(q) => {
        guard q == "" || matches_identifier(q, identifier(qualifier)) else {
          return None
        }
        for i in 0..<table.columns.length() {
          plan.push(Stored(i))
        }
      }
      Column(q, name) => {
        guard q == "" || matches_identifier(q, identifier(qualifier)) else {
          return None
        }
        let key = identifier(name)
        let mut position = -1
        for i, column in table.columns {
          if matches_identifier(column.name, key) {
            position = i
            break
          }
        }
        if position >= 0 {
          plan.push(Stored(position))
        } else if !table.without_rowid &&
          ["rowid", "_rowid_", "oid"].contains(key) {
          plan.push(RowidValue)
        } else {
          return None
        }
      }
      _ => return None
    }
  }
  Some(plan)
}

///|
fn project_stored_row(
  plan : Array[RowProjection],
  output : Environment,
  row : StoredRow,
) -> Environment {
  output.mapi((i, b) => {
    ..b,
    value: match plan[i] {
      Stored(index) => row.values[index]
      RowidValue => Integer(row.id)
      Constant(value) => value
    },
  })
}

///|
/// Name validation has already run, including when LIMIT is zero / no row matches.
fn simple_relation(
  select : Selection,
  context : Evaluation,
  output_template : Environment,
  prepared~ : PreparedProjection? = None,
) -> Relation? raise SqlError {
  guard OPT_SIMPLE_SCAN &&
    select.sources.length() == 1 &&
    select.ctes.is_empty() &&
    context.ctes.length() == 0 &&
    !select.distinct &&
    select.groups.is_empty() &&
    select.having is Literal(Integer(1L)) &&
    select.projections.all(p => {
      match p.expression {
        Column(_, _) | Star(_) | Literal(_) => true
        _ => false
      }
    }) else {
    return None
  }
  let source = select.sources[0]
  guard !source.left && source.on is Literal(Integer(1L)) else { return None }
  let mut found : Table? = None
  let key = identifier(source.name)
  if key == "sqlite_schema" || key == "sqlite_master" {
    return None
  }
  for table in context.store.tables {
    if matches_identifier(table.name, key) {
      found = Some(table)
      break
    }
  }
  guard found is Some(table) && table.rows.length() <= 100000 else {
    return None
  }
  guard rowid_value(select.limit, context.params) is Some(limit) &&
    rowid_value(select.offset, context.params) is Some(offset) else {
    return None
  }
  let rows : Array[Environment] = []
  if limit == 0L {
    return Some({ rows, template: output_template, })
  }
  let point = primary_candidates(
    context.store,
    table,
    select.predicate,
    context.params,
    source.qualifier,
  )
  if table.without_rowid && point is None {
    return None
  }
  let point_order = point is Some(_) &&
    select.orders.all(order => {
      match order.expression {
        Column(_, _) | Literal(Integer(_)) => true
        _ => false
      }
    })
  let secondary = if point_order || rowid_order(select, table, source.qualifier) {
    None
  } else {
    guard OPT_SECONDARY_RANGE else { return None }
    let range = secondary_range(select, context, table, source.qualifier)
    guard range is Some(_) else { return None }
    range
  }
  let target = rowid_equality(
    table,
    select.predicate,
    context.params,
    source.qualifier,
  )
  let candidates = match secondary {
    Some(range) => range
    None => {
      let rows = if point is Some(rows) {
        index_pages(rows, pages=false)
      } else if target is Some(_) {
        index_pages(candidate_rows(context.store, table, target), pages=false)
      } else {
        ordered_rowid_rows(context.store, table)
      }
      { rows, start: 0, end: rows.length(), reverse: false, residual: false, }
    }
  }
  let layout = match prepared {
    Some(plan) => plan.layout
    None =>
      row_environment(
        table,
        { id: 0L, values: Array::make(table.columns.length(), Null), },
        source.qualifier,
      )
  }
  let projection = if prepared is Some(plan) {
    Some(plan.columns)
  } else if simple_projection(select, table, source.qualifier) is Some(plan) &&
    plan.length() == output_template.length() {
    Some(plan)
  } else {
    None
  }
  let test_predicate = candidates.residual ||
    (
      secondary is None &&
      target is None &&
      !(select.predicate is Literal(Integer(1L)))
    )
  let mut skipped = 0L
  let count = candidates.end - candidates.start
  let first = if candidates.reverse {
    candidates.end - 1
  } else {
    candidates.start
  }
  let mut page = if count == 0 { 0 } else { candidates.rows.block_at(first) }
  let mut slot = first -
    (if page == 0 { 0 } else { candidates.rows.ends[page - 1] })
  // Resolve the first leaf once. Sequential scans never binary-search a leaf
  // for each row, including reverse ranges and OFFSET with a residual filter.
  for _ in 0..<count {
    let block = candidates.rows.blocks[page]
    let row = block[slot]
    if candidates.reverse {
      slot -= 1
      if slot < 0 {
        page -= 1
        if page >= 0 {
          slot = candidates.rows.blocks[page].length() - 1
        }
      }
    } else {
      slot += 1
      if slot == block.length() {
        page += 1
        slot = 0
      }
    }
    let ctx = {
      ..context,
      row: if test_predicate || projection is None {
        row_environment_from(layout, row)
      } else {
        []
      },
    }
    if test_predicate && truth(evaluate(select.predicate, ctx)) != 1 {
      continue
    }
    if skipped < offset.max(0L) {
      skipped += 1L
      continue
    }
    rows.push(
      match projection {
        Some(plan) => project_stored_row(plan, output_template, row)
        None => project(select.projections, ctx)
      },
    )
    if limit >= 0L && rows.length().to_int64() >= limit {
      break
    }
  }
  Some({ rows, template: output_template, })
}

// Source: result_writer.mbt

///|
/// Keep the existing Cell wire representation without allocating Json objects
/// and Maps for each cell. Strings/numbers retain the core JSON formatter.
fn write_result_cell(output : StringBuilder, value : Value) -> Unit {
  match value {
    Null => output.write_string("{\"t\":\"null\"}")
    Integer(n) => {
      output.write_string("{\"t\":\"integer\",\"v\":\"")
      output.write_string(n.to_string())
      output.write_string("\"}")
    }
    Real(n) => {
      output.write_string("{\"t\":\"real\",\"v\":")
      if !n.is_finite() {
        output.write_string(
          if n < 0.0 {
            "\"-Infinity\""
          } else {
            "\"Infinity\""
          },
        )
      } else if n.reinterpret_as_uint64() == 0x8000000000000000UL {
        output.write_string("-0.0")
      } else {
        output.write_string(Json::number(n).stringify())
      }
      output.write_char('}')
    }
    Text(s) => {
      output.write_string("{\"t\":\"text\",\"v\":")
      output.write_string(Json::string(s).stringify())
      output.write_char('}')
    }
    Blob(bytes) => {
      output.write_string("{\"t\":\"blob\",\"v\":[")
      for i, byte in bytes {
        if i > 0 {
          output.write_char(',')
        }
        output.write_string(byte.to_int().to_string())
      }
      output.write_string("]}")
    }
  }
}

///|
fn write_result_row(output : StringBuilder, row : Environment) -> Unit {
  output.write_char('[')
  let mut first = true
  for binding in row {
    if !binding.hidden {
      if !first {
        output.write_char(',')
      }
      first = false
      write_result_cell(output, binding.value)
    }
  }
  output.write_char(']')
}

///|
fn positional_result_json(
  rows : Array[Environment],
  read_only : Bool,
) -> String {
  let output = StringBuilder()
  output.write_string("{\"rows\":[")
  for i, row in rows {
    if i > 0 {
      output.write_char(',')
    }
    write_result_row(output, row)
  }
  output.write_string("],\"readonly\":")
  output.write_string(if read_only { "true" } else { "false" })
  output.write_char('}')
  output.to_string()
}

// Source: row_pages.mbt

///|
/// An epoch is an identity-bearing mutable cell. Freezing a root also freezes
/// pages owned by that epoch; the next writer takes a fresh one.
priv struct RowEpoch {
  mut shared : Bool
}

///|
priv struct RowPage {
  epoch : RowEpoch
  rows : Array[StoredRow?]
}

///|
/// Stable physical slots, ordered iteration and bounded page copy-on-write.
/// Only roots/epochs are forked. All persistent metadata stays out of images.
priv struct RowPages {
  mut pages : @rowvector.Vector[RowPage]
  mut epoch : RowEpoch
  mut count : Int32
  mut used : Int32
}

///|
fn row_pages(rows : Array[StoredRow]) -> RowPages {
  let epoch = { shared: false, }
  let pages : Array[RowPage] = []
  let mut start = 0
  while start < rows.length() {
    let offset = start
    pages.push({
      epoch,
      rows: Array::makei((rows.length() - start).min(64), i => {
        Some(rows[offset + i])
      }),
    })
    start += 64
  }
  {
    pages: @rowvector.Vector(pages[:]),
    epoch,
    count: rows.length(),
    used: rows.length(),
  }
}

///|
fn RowPages::fork(self : RowPages) -> RowPages {
  self.epoch.shared = true
  { ..self, epoch: { shared: false, }, }
}

///|
fn RowPages::length(self : RowPages) -> Int32 {
  self.count
}

///|
fn RowPages::is_empty(self : RowPages) -> Bool {
  self.count == 0
}

///|
fn RowPages::get_slot(self : RowPages, slot : Int32) -> StoredRow? {
  if slot < 0 || slot >= self.used {
    None
  } else {
    self.pages[slot / 64].rows[slot % 64]
  }
}

///|
/// Logical indexing is needed only at compatibility/DDL boundaries. Point
/// lookup and mutation use stable slots, never dense ordinal positions.
#alias("_[_]")
fn RowPages::at(self : RowPages, index : Int32) -> StoredRow {
  guard index >= 0 && index < self.count else {
    abort("row index out of bounds")
  }
  if self.count == self.used {
    return self.get_slot(index).unwrap()
  }
  let mut logical = 0
  for page in self.pages {
    for row in page.rows {
      if row is Some(row) {
        if logical == index {
          return row
        }
        logical += 1
      }
    }
  }
  abort("row count mismatch")
}

///|
fn RowPages::own_page(self : RowPages, index : Int32) -> RowPage {
  if self.epoch.shared {
    self.epoch = { shared: false, }
  }
  let previous = self.pages[index]
  if physical_equal(previous.epoch, self.epoch) {
    return previous
  }
  let page = { epoch: self.epoch, rows: previous.rows.copy(), }
  self.pages = self.pages.set(index, page)
  page
}

///|
fn RowPages::push(self : RowPages, row : StoredRow) -> Unit {
  if self.epoch.shared {
    self.epoch = { shared: false, }
  }
  if self.used % 64 == 0 {
    self.pages = self.pages.push({ epoch: self.epoch, rows: [Some(row)], })
  } else {
    self.own_page(self.used / 64).rows.push(Some(row))
  }
  self.count += 1
  self.used += 1
}

///|
fn RowPages::set_slot(self : RowPages, slot : Int32, row : StoredRow) -> Unit {
  guard self.get_slot(slot) is Some(_) else { abort("missing row slot") }
  self.own_page(slot / 64).rows[slot % 64] = Some(row)
}

///|
/// Deletion leaves other physical slots unchanged. Occasionally repack after
/// at least half the slots are empty; this bounds tombstones, amortizing O(N).
fn RowPages::remove_slot(self : RowPages, slot : Int32) -> Bool {
  guard self.get_slot(slot) is Some(_) else { abort("missing row slot") }
  self.own_page(slot / 64).rows[slot % 64] = None
  self.count -= 1
  if self.count == 0 || (self.used > 128 && self.used > self.count * 2) {
    let packed = row_pages(self.copy())
    self.pages = packed.pages
    self.epoch = packed.epoch
    self.used = packed.used
    return true
  }
  false
}

///|
/// Iterators retain the old page root, even when a callback mutates this table.
fn RowPages::cursor(self : RowPages) -> RowCursor {
  self.epoch.shared = true
  { pages: self.pages, page: 0, offset: 0, }
}

///|
priv struct RowCursor {
  pages : @rowvector.Vector[RowPage]
  mut page : Int32
  mut offset : Int32
}

///|
fn RowCursor::next(self : RowCursor) -> StoredRow? {
  while self.page < self.pages.length() {
    let page = self.pages[self.page]
    if self.offset >= page.rows.length() {
      self.page += 1
      self.offset = 0
      continue
    }
    let row = page.rows[self.offset]
    self.offset += 1
    if row is Some(row) {
      return Some(row)
    }
  }
  None
}

///|
fn RowPages::slot_entries(self : RowPages) -> Iter[(Int32, StoredRow)] {
  let cursor = self.cursor()
  Iter::new(fn() {
    cursor.next().map(row => (cursor.page * 64 + cursor.offset - 1, row))
  })
}

///|
fn RowPages::iter(self : RowPages) -> Iter[StoredRow] {
  let cursor = self.cursor()
  Iter::new(fn() { cursor.next() })
}

///|
fn RowPages::copy(self : RowPages) -> Array[StoredRow] {
  self.iter().collect()
}

///|
fn[T] RowPages::map(
  self : RowPages,
  f : (StoredRow) -> T raise?,
) -> Array[T] raise? {
  let result : Array[T] = []
  for row in self.iter() {
    result.push(f(row))
  }
  result
}

///|
fn RowPages::filter(
  self : RowPages,
  f : (StoredRow) -> Bool raise?,
) -> Array[StoredRow] raise? {
  let result : Array[StoredRow] = []
  for row in self.iter() {
    if f(row) {
      result.push(row)
    }
  }
  result
}

///|
fn RowPages::any(
  self : RowPages,
  f : (StoredRow) -> Bool raise?,
) -> Bool raise? {
  for row in self.iter() {
    if f(row) {
      return true
    }
  }
  false
}

///|
impl @json.ToJson for RowPages with fn to_json(self) {
  Json::array(self.map(row => @json.to_json(row)))
}

///|
impl @json.FromJson for RowPages with fn from_json(json, path) {
  row_pages(@json.from_json(json, path~))
}

// Source: row_values.mbt

///|
/// A row is metadata inside a comparison, never a public storage class or cell.
fn row_value_expression(e : Expr) -> Bool {
  e is Call("$row", _)
}

///|
/// Extract a safe superset only. A leading-key range must include equality so
/// that later fields can decide cursor membership; the original predicate stays.
fn row_index_constraints(
  op : String,
  left : Array[Expr],
  right : Array[Expr],
  table : Table,
  qualifier : String,
  params : Array[Value],
  constraints : Array[IndexConstraint],
) -> Bool {
  guard left.length() >= 2 && left.length() == right.length() else {
    return false
  }
  let terms : Array[IndexConstraint] = []
  if op == "=" || op == "==" {
    for i in 0..<left.length() {
      guard index_constraints(
        Binary(op, left[i], right[i]),
        table,
        qualifier,
        params,
        terms,
      ) else {
        return false
      }
    }
  } else {
    let inclusive = if op == ">" || op == ">=" { ">=" } else { "<=" }
    guard index_constraints(
      Binary(inclusive, left[0], right[0]),
      table,
      qualifier,
      params,
      terms,
    ) else {
      return false
    }
  }
  for term in terms {
    constraints.push(term)
  }
  true
}

///|
fn row_constraint_expression(e : Expr) -> Bool {
  match e {
    Binary("and", a, b) =>
      row_constraint_expression(a) || row_constraint_expression(b)
    Binary(_, a, b) => row_value_expression(a) || row_value_expression(b)
    _ => false
  }
}

///|
/// Seek a complete tuple in uniformly directed index fields, optionally after
/// a fixed tenant prefix. Mixed directions/expressions keep the leading-key
/// superset. NULLs also retain the original row predicate as a residual.
fn row_seek_bounds(
  e : Expr,
  store : Store,
  table : Table,
  qualifier : String,
  params : Array[Value],
  fields : Array[IndexField],
  rows : IndexRows,
  prefix : Array[Value],
  start : Int32,
  end : Int32,
) -> (Int32, Int32) {
  if e is Binary("and", a, b) {
    let (start, end) = row_seek_bounds(
      a, store, table, qualifier, params, fields, rows, prefix, start, end,
    )
    return row_seek_bounds(
      b, store, table, qualifier, params, fields, rows, prefix, start, end,
    )
  }
  guard e is Binary(op, Call("$row", left), Call("$row", right)) &&
    ["<", "<=", ">", ">="].contains(op) &&
    left.length() >= 2 &&
    left.length() == right.length() &&
    prefix.length() + left.length() <= fields.length() else {
    return (start, end)
  }
  let values = prefix.copy()
  let descending = fields[prefix.length()].descending
  let mut operator = ""
  for i in 0..<left.length() {
    let terms : Array[IndexConstraint] = []
    guard index_constraints(
        Binary(op, left[i], right[i]),
        table,
        qualifier,
        params,
        terms,
      ) &&
      terms.length() == 1 else {
      return (start, end)
    }
    let term = terms[0]
    let field = fields[prefix.length() + i]
    guard same_index_column(table, field.column, term.column) &&
      field.collation == term.collation &&
      field.descending == descending else {
      return (start, end)
    }
    if i == 0 {
      operator = term.op
    } else if operator != term.op {
      return (start, end)
    }
    values.push(term.value)
  }
  let lower = operator == ">" || operator == ">="
  let after = if lower { operator == ">" } else { operator == "<=" }
  let bound = index_prefix_bound(
    store,
    rows,
    fields,
    values,
    after != descending,
  )
  if lower != descending {
    (start.max(bound), end)
  } else {
    (start, end.min(bound))
  }
}

///|
fn prepare_row_value(
  e : Expr,
  ctx : Evaluation,
  aggregates : Bool,
  windows : Bool,
) -> Int32 raise SqlError {
  guard e is Call("$row", fields) &&
    fields.length() >= 2 &&
    fields.length() <= 1000 else {
    fail("row value misused or unsupported subquery operand")
  }
  for field in fields {
    guard !has_subquery(field) else {
      fail("unsupported subquery in row value field")
    }
    prepare_expression(field, ctx, aggregates, windows)
  }
  fields.length()
}

///|
fn row_column_operand(e : Expr, ctx : Evaluation) -> Bool raise SqlError {
  match e {
    Column(_, _) => true
    TruthLiteral(value) =>
      find_context(ctx, "", if value { "true" } else { "false" }) is Some(_)
    Unary("+", e) | Cast(e, _) => row_column_operand(e, ctx)
    _ => false
  }
}

///|
priv struct RowValueMetadata {
  affinity : String
  collation : String
  explicit_collation : Bool
  column : Bool
  merged : Bool
}

///|
/// Schema facts only, keyed by immutable AST identity inside a prepared query.
/// A bounded list avoids retaining all row-list RHS nodes or serializing keys.
priv struct PreparedRowMetadata {
  expression : Expr
  metadata : Array[RowValueMetadata]
}

///|
fn prepare_row_metadata(
  e : Expr,
  ctx : Evaluation,
  output : Array[PreparedRowMetadata],
) -> Unit raise SqlError {
  if output.length() >= 16 {
    return
  }
  match e {
    Call("$row", fields) =>
      if !fields.any(has_subquery) &&
        !output.any(p => physical_equal(p.expression, e)) {
        output.push({
          expression: e,
          metadata: fields.map(e => row_field_metadata(e, ctx)),
        })
      }
    Call(_, args) =>
      for arg in args {
        prepare_row_metadata(arg, ctx, output)
      }
    Unary(_, e) | Cast(e, _) | Collate(e, _) =>
      prepare_row_metadata(e, ctx, output)
    Binary(_, a, b) => {
      prepare_row_metadata(a, ctx, output)
      prepare_row_metadata(b, ctx, output)
    }
    Between(e, a, b) =>
      for field in [e, a, b] {
        prepare_row_metadata(field, ctx, output)
      }
    Case(base, arms, otherwise) => {
      if base is Some(e) {
        prepare_row_metadata(e, ctx, output)
      }
      for (a, b) in arms {
        prepare_row_metadata(a, ctx, output)
        prepare_row_metadata(b, ctx, output)
      }
      prepare_row_metadata(otherwise, ctx, output)
    }
    InSelect(left, _) => prepare_row_metadata(left, ctx, output)
    _ => ()
  }
}

///|
priv struct RowValue {
  fields : Array[Expr]
  metadata : Array[RowValueMetadata]
  values : Array[Value?]
}

///|
fn row_field_metadata(
  e : Expr,
  ctx : Evaluation,
) -> RowValueMetadata raise SqlError {
  let explicit = explicit_collation(e)
  let merged = match e {
    Column("", name) =>
      find_context(ctx, "", name)
      .map(b => b.join_column is Some(MergedJoinColumn(_, _, _)))
      .unwrap_or(false)
    TruthLiteral(value) =>
      find_context(ctx, "", if value { "true" } else { "false" })
      .map(b => b.join_column is Some(MergedJoinColumn(_, _, _)))
      .unwrap_or(false)
    _ => false
  }
  {
    affinity: expression_affinity(e, ctx),
    collation: explicit.unwrap_or(expression_collation(e, ctx)),
    explicit_collation: explicit is Some(_),
    column: row_column_operand(e, ctx),
    merged,
  }
}

///|
fn row_value(
  e : Expr,
  ctx : Evaluation,
  eager : Bool,
) -> RowValue raise SqlError {
  guard e is Call("$row", fields) else { fail("row value misused") }
  let row = {
    fields,
    metadata: ctx.row_metadata
    .iter()
    .find_first(p => physical_equal(p.expression, e))
    .map(p => p.metadata)
    .unwrap_or_else(() => fields.map(e => row_field_metadata(e, ctx))),
    values: Array::make(fields.length(), None),
  }
  if eager {
    for i in 0..<fields.length() {
      ignore(row_value_at(row, i, ctx))
    }
  }
  row
}

///|
fn row_value_at(
  row : RowValue,
  index : Int32,
  ctx : Evaluation,
) -> Value raise SqlError {
  if row.values[index] is Some(value) {
    return value
  }
  let value = evaluate(row.fields[index], ctx)
  let value = if row.metadata[index].merged {
    apply_affinity(value, row.metadata[index].affinity)
  } else {
    value
  }
  row.values[index] = Some(value)
  value
}

///|
/// Equality continues after NULL to find a definite mismatch. Ordering stops at
/// the first unequal/unknown component. IS treats TRUE/FALSE as ordinary values.
fn compare_row_values(
  op : String,
  left : RowValue,
  right : RowValue,
  ctx : Evaluation,
) -> Value raise SqlError {
  guard left.metadata.length() == right.metadata.length() else {
    fail("row value size mismatch")
  }
  let ordering = ["<", "<=", ">", ">="].contains(op)
  let null_safe = op == "is" || op == "is not"
  let negate = op == "!=" || op == "<>" || op == "is not"
  let mut unknown = false
  for i, lm in left.metadata {
    let a = row_value_at(left, i, ctx)
    let b = row_value_at(right, i, ctx)
    if a is Null || b is Null {
      if null_safe {
        if !(a is Null && b is Null) {
          return boolean(negate)
        }
      } else {
        if ordering {
          return Null
        }
        unknown = true
      }
      continue
    }
    let rm = right.metadata[i]
    let collation = if lm.explicit_collation {
      lm.collation
    } else if rm.explicit_collation {
      rm.collation
    } else if lm.column {
      lm.collation
    } else {
      rm.collation
    }
    let equal = compare_nonnull(
      "=",
      a,
      b,
      lm.affinity,
      rm.affinity,
      collation,
      ctx.store,
    )
    if truth(equal) != 1 {
      return if ordering {
        compare_nonnull(
          op,
          a,
          b,
          lm.affinity,
          rm.affinity,
          collation,
          ctx.store,
        )
      } else {
        boolean(negate)
      }
    }
  }
  if unknown {
    Null
  } else if ordering {
    boolean(op == "<=" || op == ">=")
  } else {
    boolean(!negate)
  }
}

///|
/// A top-level compound IN query has version/planner-dependent output affinity.
/// Keep it explicit until the engine retains that metadata. Star expansion is
/// supported as the sole projection, where it cannot conceal an explicit COLLATE.
fn row_select_metadata(
  select : Selection,
  ctx : Evaluation,
) -> Array[RowValueMetadata] raise SqlError {
  guard select.compound is None else {
    fail("unsupported compound row IN subquery")
  }
  guard !select.sources.any(s => {
    s.natural == Some(true) || !s.using_columns.unwrap_or([]).is_empty()
  }) else {
    fail("unsupported merged-column row IN subquery")
  }
  let output = selection_template(select, ctx.nested())
  let star = select.projections.any(p => p.expression is Star(_))
  guard !star || select.projections.length() == 1 else {
    fail("unsupported mixed-star row IN projection")
  }
  output.mapi((i, b) => {
    let explicit = if star {
      None
    } else {
      explicit_collation(select.projections[i].expression)
    }
    {
      affinity: b.affinity,
      collation: explicit.unwrap_or(b.collation),
      explicit_collation: explicit is Some(_),
      column: true,
      merged: false,
    }
  })
}

///|
fn materialized_row(
  values : Array[Value],
  metadata : Array[RowValueMetadata],
) -> RowValue {
  { fields: [], metadata, values: values.map(v => Some(v)), }
}

///|
fn row_in_select(
  e : Expr,
  select : Selection,
  ctx : Evaluation,
) -> Value raise SqlError {
  let left = row_value(e, ctx, true)
  let metadata = row_select_metadata(select, ctx)
  let relation = select_relation_in(select, ctx.nested(), false)
  row_in_rows(
    left,
    relation.rows.iter().map(row => row.map(b => b.value)),
    metadata,
    ctx,
  )
}

///|
/// SQLite 3.53/3.54 lowers a row-list IN to a VALUES subquery. Its final row
/// supplies the shared RHS affinity/collation; all RHS values are materialized.
fn row_in_list(args : Array[Expr], ctx : Evaluation) -> Value raise SqlError {
  if args.length() == 1 {
    return Integer(0L)
  }
  let left = row_value(args[0], ctx, true)
  let right : Array[RowValue] = []
  for i in 1..<args.length() {
    right.push(row_value(args[i], ctx, true))
  }
  let metadata = right[right.length() - 1].metadata
  row_in_rows(
    left,
    right.iter().map(row => row.values.map(v => v.unwrap())),
    metadata,
    ctx,
  )
}

///|
/// An IN b-tree applies the comparison affinity to BOTH sides before lookup.
/// This matters for heterogeneous RHS rows whose stored classes differ from
/// the final row's affinity; it cannot be modeled by a scalar OR of comparisons.
fn row_in_rows(
  left : RowValue,
  rows : Iter[Array[Value]],
  metadata : Array[RowValueMetadata],
  ctx : Evaluation,
) -> Value raise SqlError {
  let affinities = metadata.mapi((i, m) => {
    let la = left.metadata[i].affinity
    let ra = m.affinity
    in_comparison_affinity(la, ra)
  })
  let normalized_left = materialized_row(
    affinities.mapi((i, affinity) => {
      apply_affinity(row_value_at(left, i, ctx), affinity)
    }),
    left.metadata.map(m => { ..m, affinity: "", }),
  )
  let normalized_metadata = metadata.map(m => { ..m, affinity: "", })
  let mut unknown = false
  for values in rows {
    let row = materialized_row(
      values.mapi((i, v) => apply_affinity(v, affinities[i])),
      normalized_metadata,
    )
    let result = compare_row_values("=", normalized_left, row, ctx)
    if truth(result) == 1 {
      return Integer(1L)
    }
    if result is Null {
      unknown = true
    }
  }
  if unknown {
    Null
  } else {
    Integer(0L)
  }
}

// Source: runtime_query_requirements.mbt

///|
/// Shared typed-IR facts for build-time inference and load-time validation.
/// These helpers must not depend on the SQL or SQL JSON parsers.
fn runtime_selection_parts(select : Selection) -> Array[String] {
  let parts : Array[String] = []
  if !select.sources.is_empty() {
    parts.push("source")
  }
  if !select.orders.is_empty() {
    parts.push("orderBy")
  }
  if select.distinct {
    parts.push("distinct")
  }
  if !(select.limit is Literal(Integer(-1L))) ||
    !(select.offset is Literal(Integer(0L))) {
    parts.push("limitOffset")
  }
  if !select.groups.is_empty() {
    parts.push("groupBy")
  }
  if select.projections.any(p => extremum_aggregate(p.expression)) ||
    extremum_aggregate(select.having) ||
    select.orders.any(o => extremum_aggregate(o.expression)) {
    parts.push("aggregateRepresentative")
  }
  if select.sources.any(s => s.on is Call("$json-table", _)) {
    parts.push("jsonSubtype")
  }
  if !select.ctes.is_empty() {
    parts.push("cte")
    if select.ctes.any(p => recursive_cte(select, p.0, p.1)) {
      parts.push("recursiveCte")
    }
  }
  if select.compound is Some(_) {
    parts.push("compound")
  }
  if select.sources.length() > 1 ||
    select.sources.any(s => {
      s.left ||
      s.right == Some(true) ||
      s.natural == Some(true) ||
      !s.using_columns.unwrap_or([]).is_empty() ||
      !(s.on is Literal(Integer(1L)))
    }) {
    parts.push("join")
  }
  parts
}

///|
fn runtime_json_may_have_subtype(expr : Expr) -> Bool {
  match expr {
    Call("$filter", [input, _])
    | Call("$aggregate-order", [input, ..])
    | Call("$distinct", [input]) => runtime_json_may_have_subtype(input)
    Call("coalesce", args)
    | Call("ifnull", args)
    | Call("iif", args)
    | Call("if", args)
    | Call("nullif", args)
    | Call("min", args)
    | Call("max", args) => args.any(runtime_json_may_have_subtype)
    Call(name, _) =>
      [
        "json", "json_quote", "json_array", "json_object", "json_extract", "json_set",
        "json_insert", "json_replace", "json_remove", "json_patch", "->", "json_group_array",
        "json_group_object",
      ].contains(name)
    Collate(e, _) | Unary("+", e) | Cast(e, "text") =>
      runtime_json_may_have_subtype(e)
    Case(_, arms, other) =>
      arms.any(p => runtime_json_may_have_subtype(p.1)) ||
      runtime_json_may_have_subtype(other)
    ScalarSelect(select) => runtime_json_selection_subtype(select)
    _ => false
  }
}

///|
fn runtime_json_selection_subtype(select : Selection) -> Bool {
  select.sources.any(s => s.on is Call("$json-table", _)) ||
  select.projections.any(p => runtime_json_may_have_subtype(p.expression)) ||
  select.compound.unwrap_or([]).any(p => runtime_json_selection_subtype(p.1))
}

///|
fn runtime_json_unsupported_subtype(expr : Expr) -> Bool {
  match expr {
    ScalarSelect(select) => runtime_json_selection_subtype(select)
    Collate(e, _) | Unary("+", e) | Cast(e, "text") =>
      runtime_json_unsupported_subtype(e)
    Call("min", args) | Call("max", args) =>
      args.any(runtime_json_may_have_subtype)
    Call("coalesce", args)
    | Call("ifnull", args)
    | Call("iif", args)
    | Call("if", args)
    | Call("nullif", args) => args.any(runtime_json_unsupported_subtype)
    Case(_, arms, other) =>
      arms.any(p => runtime_json_unsupported_subtype(p.1)) ||
      runtime_json_unsupported_subtype(other)
    _ => false
  }
}

///|
/// Only JSON VALUE positions propagate subtype. Labels and raw JSON inputs do not.
fn runtime_json_values(name : String, args : Array[Expr]) -> Array[Expr] {
  match name {
    "json_array" | "json_quote" => args
    "json_object" | "json_set" | "json_insert" | "json_replace" => {
      let values = []
      let start = if name == "json_object" { 1 } else { 2 }
      for i = start; i < args.length(); i = i + 2 {
        values.push(args[i])
      }
      values
    }
    "json_group_array" =>
      args.map(e => {
        let input = filter_input(e)
        match input {
          Call("$distinct", [inner]) => inner
          Call("$aggregate-order", [inner, ..]) =>
            match inner {
              Call("$distinct", [value]) => value
              _ => inner
            }
          _ => input
        }
      })
    "json_group_object" => if args.length() == 2 { [args[1]] } else { [] }
    _ => []
  }
}

///|
fn runtime_json_value_subtype(name : String, args : Array[Expr]) -> Bool {
  runtime_json_values(name, args).any(runtime_json_may_have_subtype)
}

///|
fn validate_runtime_json_values(
  name : String,
  args : Array[Expr],
) -> Unit raise SqlError {
  if FEATURE_SQL_JSON {
    let values = runtime_json_values(name, args)
    guard !values.any(runtime_json_unsupported_subtype) else {
      fail(
        "unsupported JSON subtype propagation through scalar subquery or extrema",
      )
    }
    if values.any(runtime_json_may_have_subtype) {
      validate_runtime_query_part("jsonSubtype")
    }
  }
}

// Source: runtime_usage_compiler.mbt

///|
priv struct RuntimeUsageState {
  mut features : UInt32
  functions : Map[String, Bool]
  groups : Map[String, Bool]
  expressions : Map[String, Bool]
  statements : Map[String, Bool]
  parts : Map[String, Bool]
}

///|
fn collect_runtime_call(
  name : String,
  arity : Int32,
  state : RuntimeUsageState,
) -> Unit {
  state.features = state.features | function_features(name)
  state.functions[name] = true
  if runtime_call_capability(name, arity) is Some(group) {
    state.groups[group] = true
  }
}

///|
fn sorted_usage_names(names : Map[String, Bool]) -> Array[String] {
  let values : Array[String] = names.keys().collect()
  values.sort_by((a, b) => bytes_compare(@utf8.encode(a), @utf8.encode(b)))
  values
}

///|
/// Build-only analysis over validated typed IR, including all schema expressions.
fn program_runtime_requirements(artifact : String) -> String {
  try {
    let program = Program::load(artifact)
    let state : RuntimeUsageState = {
      features: 0U,
      functions: Map([]),
      groups: Map([]),
      expressions: Map([]),
      statements: Map([]),
      parts: Map([]),
    }
    RuntimeUsage::collect(program.schema.tables, state)
    RuntimeUsage::collect(program.schema.objects, state)
    for _, query in program.queries {
      RuntimeUsage::collect(query, state)
    }
    if program.storage is Some(storage) {
      RuntimeUsage::collect(storage.trees, state)
    }
    (
      {
        "format": "sqlike-runtime-requirements@1",
        "featureBits": state.features.reinterpret_as_int(),
        "functions": sorted_usage_names(state.functions),
        "functionGroups": sorted_usage_names(state.groups),
        "expressionGroups": sorted_usage_names(state.expressions),
        "statements": sorted_usage_names(state.statements),
        "queryParts": sorted_usage_names(state.parts),
      } : Json).stringify()
  } catch {
    error => public_error_json(error).stringify()
  }
}

// Source: runtime_usage_generated.mbt
// Generated by scripts/generate-runtime-capabilities.ts.
// Capability SHA256: 29619c2e072435a6815a66a53f186049bab9599699b36935570352fe81d0b0be
// Contract SHA256: f3e811d415bf6e48620b30d666547b023504647406200f3b8e0f9abbe367dd96

///|
priv trait RuntimeUsage {
  fn collect(Self, RuntimeUsageState) -> Unit
}

///|
impl RuntimeUsage for Int32 with fn collect(_, _) {
  ()
}

///|
impl RuntimeUsage for Bool with fn collect(_, _) {
  ()
}

///|
impl RuntimeUsage for String with fn collect(_, _) {
  ()
}

///|
impl RuntimeUsage for Value with fn collect(_, _) {
  ()
}

///|
impl[A : RuntimeUsage] RuntimeUsage for Array[A] with fn collect(xs, state) {
  for x in xs {
    RuntimeUsage::collect(x, state)
  }
}

///|
impl[A : RuntimeUsage] RuntimeUsage for A? with fn collect(x, state) {
  if x is Some(x) {
    RuntimeUsage::collect(x, state)
  }
}

///|
impl[A : RuntimeUsage, B : RuntimeUsage] RuntimeUsage for (A, B) with fn collect(
  x,
  state,
) {
  RuntimeUsage::collect(x.0, state)
  RuntimeUsage::collect(x.1, state)
}

///|
impl RuntimeUsage for Ordering with fn collect(value, state) {
  RuntimeUsage::collect(value.expression, state)
  RuntimeUsage::collect(value.descending, state)
}

///|
impl RuntimeUsage for Projection with fn collect(value, state) {
  RuntimeUsage::collect(value.expression, state)
  RuntimeUsage::collect(value.explicit_label, state)
  RuntimeUsage::collect(value.label, state)
}

///|
impl RuntimeUsage for Source with fn collect(value, state) {
  if value.right == Some(true) ||
    value.natural == Some(true) ||
    !value.using_columns.unwrap_or([]).is_empty() {
    state.features = state.features | 8U
  }
  RuntimeUsage::collect(value.name, state)
  RuntimeUsage::collect(value.qualifier, state)
  RuntimeUsage::collect(value.left, state)
  RuntimeUsage::collect(value.right, state)
  RuntimeUsage::collect(value.using_columns, state)
  RuntimeUsage::collect(value.natural, state)
  RuntimeUsage::collect(value.on, state)
}

///|
impl RuntimeUsage for Selection with fn collect(value, state) {
  state.statements["select"] = true
  for part in runtime_selection_parts(value) {
    state.parts[part] = true
  }
  RuntimeUsage::collect(value.ctes, state)
  RuntimeUsage::collect(value.projections, state)
  RuntimeUsage::collect(value.sources, state)
  RuntimeUsage::collect(value.predicate, state)
  RuntimeUsage::collect(value.groups, state)
  RuntimeUsage::collect(value.having, state)
  RuntimeUsage::collect(value.orders, state)
  RuntimeUsage::collect(value.limit, state)
  RuntimeUsage::collect(value.offset, state)
  RuntimeUsage::collect(value.distinct, state)
  RuntimeUsage::collect(value.compound, state)
  RuntimeUsage::collect(value.recursive, state)
  RuntimeUsage::collect(value.cte_names, state)
}

///|
impl RuntimeUsage for ForeignKey with fn collect(value, state) {
  state.features = state.features | 1U
  RuntimeUsage::collect(value.column, state)
  RuntimeUsage::collect(value.parent, state)
  RuntimeUsage::collect(value.target, state)
  RuntimeUsage::collect(value.cascade, state)
  RuntimeUsage::collect(value.columns, state)
  RuntimeUsage::collect(value.targets, state)
  RuntimeUsage::collect(value.delete_action, state)
  RuntimeUsage::collect(value.update_action, state)
  RuntimeUsage::collect(value.initially_deferred, state)
}

///|
impl RuntimeUsage for ColumnDef with fn collect(value, state) {
  RuntimeUsage::collect(value.name, state)
  RuntimeUsage::collect(value.declared, state)
  RuntimeUsage::collect(value.not_null, state)
  RuntimeUsage::collect(value.primary, state)
  RuntimeUsage::collect(value.primary_desc, state)
  RuntimeUsage::collect(value.default_value, state)
  RuntimeUsage::collect(value.default_source, state)
  RuntimeUsage::collect(value.collation, state)
}

///|
impl RuntimeUsage for Table with fn collect(value, state) {
  if value.strict == Some(true) {
    state.features = state.features | 4U
  }
  RuntimeUsage::collect(value.name, state)
  RuntimeUsage::collect(value.sql, state)
  RuntimeUsage::collect(value.columns, state)
  RuntimeUsage::collect(value.unique_keys, state)
  RuntimeUsage::collect(value.checks, state)
  RuntimeUsage::collect(value.foreign_keys, state)
  RuntimeUsage::collect(value.without_rowid, state)
  RuntimeUsage::collect(value.strict, state)
  RuntimeUsage::collect(value.autoincrement, state)
}

///|
impl RuntimeUsage for SchemaObject with fn collect(value, state) {
  RuntimeUsage::collect(value.kind, state)
  RuntimeUsage::collect(value.name, state)
  RuntimeUsage::collect(value.table, state)
  RuntimeUsage::collect(value.sql, state)
  RuntimeUsage::collect(value.unique, state)
  RuntimeUsage::collect(value.columns, state)
  RuntimeUsage::collect(value.query, state)
  RuntimeUsage::collect(value.selection, state)
  RuntimeUsage::collect(value.index_terms, state)
  RuntimeUsage::collect(value.index_predicate, state)
  RuntimeUsage::collect(value.trigger, state)
}

///|
impl RuntimeUsage for Insertion with fn collect(value, state) {
  RuntimeUsage::collect(value.table, state)
  RuntimeUsage::collect(value.columns, state)
  RuntimeUsage::collect(value.values, state)
  RuntimeUsage::collect(value.conflict, state)
  RuntimeUsage::collect(value.target, state)
  RuntimeUsage::collect(value.updates, state)
  RuntimeUsage::collect(value.predicate, state)
  RuntimeUsage::collect(value.returning, state)
  RuntimeUsage::collect(value.conflict_override, state)
  RuntimeUsage::collect(value.target_predicate, state)
  RuntimeUsage::collect(value.selection, state)
}

///|
impl RuntimeUsage for TriggerDefinition with fn collect(value, state) {
  state.features = state.features | 2U
  RuntimeUsage::collect(value.timing, state)
  RuntimeUsage::collect(value.event, state)
  RuntimeUsage::collect(value.columns, state)
  RuntimeUsage::collect(value.condition, state)
  RuntimeUsage::collect(value.body, state)
}

///|
impl RuntimeUsage for WindowFrame with fn collect(value, state) {
  RuntimeUsage::collect(value.kind, state)
  RuntimeUsage::collect(value.start, state)
  RuntimeUsage::collect(value.end, state)
}

///|
impl RuntimeUsage for CompiledQuery with fn collect(value, state) {
  RuntimeUsage::collect(value.name, state)
  RuntimeUsage::collect(value.parameters, state)
  RuntimeUsage::collect(value.names, state)
  RuntimeUsage::collect(value.statement, state)
}

///|
impl RuntimeUsage for StorageTree with fn collect(value, state) {
  RuntimeUsage::collect(value.name, state)
  RuntimeUsage::collect(value.table, state)
  RuntimeUsage::collect(value.root, state)
  RuntimeUsage::collect(value.kind, state)
  RuntimeUsage::collect(value.fields, state)
  RuntimeUsage::collect(value.predicate, state)
}

///|
impl RuntimeUsage for StorageField with fn collect(value, state) {
  RuntimeUsage::collect(value.column, state)
  RuntimeUsage::collect(value.collation, state)
  RuntimeUsage::collect(value.descending, state)
  RuntimeUsage::collect(value.expression, state)
}

///|
impl RuntimeUsage for Expr with fn collect(value, state) {
  match value {
    Literal(v0) => RuntimeUsage::collect(v0, state)
    TruthLiteral(v0) => RuntimeUsage::collect(v0, state)
    CurrentTime(v0) => {
      state.features = state.features | 32U
      collect_runtime_call(v0, 1, state)
      RuntimeUsage::collect(v0, state)
    }
    Parameter(v0) => RuntimeUsage::collect(v0, state)
    Column(v0, v1) => {
      RuntimeUsage::collect(v0, state)
      RuntimeUsage::collect(v1, state)
    }
    Star(v0) => RuntimeUsage::collect(v0, state)
    Unary(v0, v1) => {
      RuntimeUsage::collect(v0, state)
      RuntimeUsage::collect(v1, state)
    }
    Binary(v0, v1, v2) => {
      if v0 == "like" {
        collect_runtime_call("like", 2, state)
      }
      RuntimeUsage::collect(v0, state)
      RuntimeUsage::collect(v1, state)
      RuntimeUsage::collect(v2, state)
    }
    Call(v0, v1) => {
      state.expressions["call"] = true
      collect_runtime_call(v0, v1.length(), state)
      if runtime_json_value_subtype(v0, v1) {
        state.parts["jsonSubtype"] = true
      }
      RuntimeUsage::collect(v0, state)
      RuntimeUsage::collect(v1, state)
    }
    Collate(v0, v1) => {
      RuntimeUsage::collect(v0, state)
      RuntimeUsage::collect(v1, state)
    }
    Cast(v0, v1) => {
      state.expressions["cast"] = true
      RuntimeUsage::collect(v0, state)
      RuntimeUsage::collect(v1, state)
    }
    RowNumber(v0) => {
      state.features = state.features | 64U
      collect_runtime_call("row_number", 0, state)
      RuntimeUsage::collect(v0, state)
    }
    Window(v0, v1, v2, v3, v4) => {
      state.features = state.features | 64U
      collect_runtime_call(v0, v1.length(), state)
      RuntimeUsage::collect(v0, state)
      RuntimeUsage::collect(v1, state)
      RuntimeUsage::collect(v2, state)
      RuntimeUsage::collect(v3, state)
      RuntimeUsage::collect(v4, state)
    }
    Between(v0, v1, v2) => {
      state.expressions["between"] = true
      RuntimeUsage::collect(v0, state)
      RuntimeUsage::collect(v1, state)
      RuntimeUsage::collect(v2, state)
    }
    Case(v0, v1, v2) => {
      state.expressions["case"] = true
      RuntimeUsage::collect(v0, state)
      RuntimeUsage::collect(v1, state)
      RuntimeUsage::collect(v2, state)
    }
    InSelect(v0, v1) => {
      state.expressions["subquery"] = true
      state.parts["inSelect"] = true
      RuntimeUsage::collect(v0, state)
      RuntimeUsage::collect(v1, state)
    }
    ScalarSelect(v0) => {
      state.expressions["subquery"] = true
      RuntimeUsage::collect(v0, state)
    }
    Exists(v0) => {
      state.expressions["subquery"] = true
      RuntimeUsage::collect(v0, state)
    }
  }
}

///|
impl RuntimeUsage for DataStatement with fn collect(value, state) {
  match value {
    PreparedTransaction(v0, v1) => {
      state.statements["transaction"] = true
      RuntimeUsage::collect(v0, state)
      RuntimeUsage::collect(v1, state)
    }
    PreparedSelect(v0) => {
      state.statements["select"] = true
      RuntimeUsage::collect(v0, state)
    }
    PreparedPragma(v0, v1) => {
      state.statements["pragma"] = true
      state.features = state.features | pragma_features(v0)
      RuntimeUsage::collect(v0, state)
      RuntimeUsage::collect(v1, state)
    }
    PreparedInsert(v0) => {
      state.statements["insert"] = true
      RuntimeUsage::collect(v0, state)
    }
    PreparedUpdate(v0, v1, v2, v3) => {
      state.statements["update"] = true
      RuntimeUsage::collect(v0, state)
      RuntimeUsage::collect(v1, state)
      RuntimeUsage::collect(v2, state)
      RuntimeUsage::collect(v3, state)
    }
    PreparedDelete(v0, v1, v2) => {
      state.statements["delete"] = true
      RuntimeUsage::collect(v0, state)
      RuntimeUsage::collect(v1, state)
      RuntimeUsage::collect(v2, state)
    }
  }
}

///|
impl RuntimeUsage for WindowBound with fn collect(value, state) {
  match value {
    UnboundedPreceding => ()
    Preceding(v0) => RuntimeUsage::collect(v0, state)
    Current => ()
    Following(v0) => RuntimeUsage::collect(v0, state)
    UnboundedFollowing => ()
  }
}

// Source: scalar.mbt

///|
/// Function metadata is checked while preparing, including unselected branches.
fn scalar_arity(name : String, count : Int32) -> Bool {
  match name {
    "char" | "format" | "printf" => true
    "glob" => count == 2
    "like" => count == 2 || count == 3
    "min" | "max" => count >= 2
    "substr" | "substring" => count == 2 || count == 3
    "trim" | "ltrim" | "rtrim" => count == 1 || count == 2
    "instr" | "nullif" => count == 2
    "replace" => count == 3
    "concat" => count >= 1
    "concat_ws" | "iif" | "if" => count >= 2
    "octet_length" | "quote" | "unicode" | "sign" => count == 1
    "round" => count == 1 || count == 2
    "ceil" | "ceiling" | "floor" | "trunc" => count == 1
    _ => false
  }
}

///|
fn saturated_add(a : Int64, b : Int64) -> Int64 {
  if b > 0L && a > 9223372036854775807L - b {
    9223372036854775807L
  } else if b < 0L && a < -9223372036854775808L - b {
    -9223372036854775808L
  } else {
    a + b
  }
}

///|
/// ESCAPE is validated before NULL pattern/text, as in SQLite's like().
fn like_value(values : Array[Value]) -> Value raise SqlError {
  let pattern = if values[0] is Null {
    ""
  } else {
    checked_text_value(values[0])
  }
  guard @utf8.encode(pattern).length() <= 50000 else {
    fail("LIKE or GLOB pattern too complex")
  }
  let mut escape : Char? = None
  if values.length() == 3 {
    if values[2] is Null {
      return Null
    }
    for c in checked_text_value(values[2]).iter() {
      if c == '\u{0}' {
        break
      }
      guard escape is None else {
        fail("ESCAPE expression must be a single character")
      }
      escape = Some(c)
    }
    guard escape is Some(_) else {
      fail("ESCAPE expression must be a single character")
    }
  }
  if values[0] is Null || values[1] is Null {
    return Null
  }
  boolean(like(checked_text_value(values[1]), pattern, escape))
}

///|
fn substring_bounds(
  size : Int32,
  start : Int64,
  count : Int64,
) -> (Int32, Int32) {
  let size = size.to_int64()
  let first = if start > 0L {
    start - 1L
  } else if start < 0L {
    saturated_add(size, start)
  } else {
    -1L
  }
  let (low, high) = if count >= 0L {
    (first, saturated_add(first, count))
  } else {
    (saturated_add(first, count), first)
  }
  (low.max(0L).min(size).to_int(), high.max(0L).min(size).to_int())
}

///|
/// SQLite substr counts Unicode scalar values for TEXT, bytes for BLOB.
fn substring_value(
  value : Value,
  start : Value,
  count : Value?,
) -> Value raise SqlError {
  if value is Null || start is Null || count is Some(Null) {
    return Null
  }
  let start = integer_value(start)
  // The native SQLite 3.53 oracle uses its default 1e9 value-length limit for an omitted count.
  let count = count.map(integer_value).unwrap_or(1000000000L)
  match value {
    Blob(bytes) => {
      let (first, last) = substring_bounds(bytes.length(), start, count)
      Blob(bytes[first:last].to_owned())
    }
    _ => {
      let chars : Array[Char] = []
      for char in checked_text_value(value).iter() {
        if char == '\u{0}' {
          break
        }
        chars.push(char)
      }
      let (first, last) = substring_bounds(chars.length(), start, count)
      Text(String::from_iter(chars[first:last].iter()))
    }
  }
}

///|
fn scalar_call(
  name : String,
  values : Array[Value],
  encoding : Int32,
) -> Value raise SqlError {
  match name {
    "format" | "printf" => {
      guard CAP_FUNCTION_FORMAT else {
        fail("catalog capability disabled: format")
      }
      format_value(values)
    }
    "ceil" | "ceiling" | "floor" | "trunc" => {
      guard CAP_FUNCTION_MATH_ROUNDING else {
        fail("catalog capability disabled: mathRounding")
      }
      math_rounding_value(name, values[0])
    }
    "glob" => {
      guard CAP_FUNCTION_GLOB else { fail("catalog capability disabled: glob") }
      let pattern = if values[0] is Null {
        ""
      } else {
        checked_text_value(values[0])
      }
      guard @utf8.encode(pattern).length() <= 50000 else {
        fail("LIKE or GLOB pattern too complex")
      }
      if values[0] is Null || values[1] is Null {
        Null
      } else {
        boolean(glob(checked_text_value(values[1]), pattern))
      }
    }
    "char" => {
      guard CAP_FUNCTION_CHARACTER else {
        fail("catalog capability disabled: char")
      }
      let b = StringBuilder()
      for value in values {
        let n = integer_value(value)
        guard n < 55296L || n > 57343L else {
          fail("unsupported SQL: char surrogate is not Unicode scalar text")
        }
        b.write_char(
          (if n < 0L || n > 1114111L { 65533 } else { n.to_int() }).unsafe_to_char(),
        )
      }
      Text(b.to_string())
    }
    "sign" => {
      guard CAP_FUNCTION_SIGN else { fail("catalog capability disabled: sign") }
      match numeric(values[0], true) {
        Integer(n) =>
          Integer(if n < 0L { -1L } else if n > 0L { 1L } else { 0L })
        Real(n) => Integer(if n < 0 { -1L } else if n > 0 { 1L } else { 0L })
        _ => Null
      }
    }
    "unicode" => {
      guard CAP_FUNCTION_UNICODE else {
        fail("catalog capability disabled: unicode")
      }
      if values[0] is Null {
        return Null
      }
      for c in checked_text_value(values[0]).iter() {
        return if c == '\u{0}' {
          Null
        } else {
          Integer(sqlite_utf8_char(c).to_int().to_int64())
        }
      }
      Null
    }
    "quote" => {
      guard CAP_FUNCTION_QUOTE else {
        fail("catalog capability disabled: quote")
      }
      Text(sql_quote_value(values[0]))
    }
    "round" => {
      guard CAP_FUNCTION_ROUND else {
        fail("catalog capability disabled: round")
      }
      if values.any(v => v is Null) {
        return Null
      }
      let n = if values.length() == 2 {
        integer_value(values[1]).max(0L).min(30L).to_int()
      } else {
        0
      }
      Real(sql_round(as_double(values[0]), n))
    }
    "substr" | "substring" => {
      guard CAP_FUNCTION_SUBSTRING else {
        fail("catalog capability disabled: substring")
      }
      substring_value(
        values[0],
        values[1],
        if values.length() == 3 {
          Some(values[2])
        } else {
          None
        },
      )
    }
    "concat" | "concat_ws" => {
      guard CAP_FUNCTION_CONCAT else {
        fail("catalog capability disabled: concat")
      }
      if name == "concat_ws" && values[0] is Null {
        return Null
      }
      let separator = if name == "concat_ws" {
        checked_text_value(values[0])
      } else {
        ""
      }
      let first = if name == "concat_ws" { 1 } else { 0 }
      let strings : Array[String] = []
      for index in first..<values.length() {
        if !(values[index] is Null) {
          strings.push(checked_text_value(values[index]))
        }
      }
      Text(strings.join(separator))
    }
    "octet_length" => {
      guard CAP_FUNCTION_OCTET_LENGTH else {
        fail("catalog capability disabled: octet_length")
      }
      match values[0] {
        Null => Null
        Blob(bytes) => Integer(bytes.length().to_int64())
        value => {
          let text = checked_text_value(value)
          Integer(
            (if encoding == 1 {
              @utf8.encode(text).length()
            } else {
              @utf16.encode(text).length()
            }).to_int64(),
          )
        }
      }
    }
    "trim" | "ltrim" | "rtrim" => {
      guard CAP_FUNCTION_TRIM else { fail("catalog capability disabled: trim") }
      if values.any(v => v is Null) {
        return Null
      }
      let text = checked_text_value(values[0])
      let chars = if values.length() == 2 {
        checked_text_value(values[1])
      } else {
        " "
      }
      Text(
        (if name == "trim" {
          text.trim(chars=chars[:])
        } else if name == "ltrim" {
          text.trim_start(chars=chars[:])
        } else {
          text.trim_end(chars=chars[:])
        }).to_owned(),
      )
    }
    "instr" => {
      guard CAP_FUNCTION_INSTR else {
        fail("catalog capability disabled: instr")
      }
      if values.any(v => v is Null) {
        return Null
      }
      if values[0] is Blob(haystack) && values[1] is Blob(needle) {
        Integer(
          haystack.find(needle[:]).map(i => (i + 1).to_int64()).unwrap_or(0L),
        )
      } else {
        let haystack = checked_text_value(values[0])
        let needle = checked_text_value(values[1])
        match haystack.find(needle[:]) {
          None => Integer(0L)
          Some(index) =>
            Integer(haystack[:index].iter().count().to_int64() + 1L)
        }
      }
    }
    "replace" => {
      guard CAP_FUNCTION_REPLACE else {
        fail("catalog capability disabled: replace")
      }
      if values[0] is Null || values[1] is Null {
        return Null
      }
      let text = checked_text_value(values[0])
      let old = checked_text_value(values[1])
      if old == "" || old.has_prefix("\u{0}") {
        return Text(text)
      }
      if values[2] is Null {
        return Null
      }
      let new = checked_text_value(values[2])
      Text(text.replace_all(old=old[:], new=new[:]))
    }
    _ => fail("unsupported SQL function: " + name)
  }
}

///|
fn sql_quote_value(value : Value) -> String {
  match value {
    Null => "NULL"
    Integer(n) => n.to_string()
    Real(n) =>
      if !n.is_finite() {
        if n < 0.0 {
          "-9.0e+999"
        } else {
          "9.0e+999"
        }
      } else {
        sqlite_real_text(n)
      }
    Blob(b) =>
      "X'" +
      b
      .to_array()
      .map(c => {
        let h = "0123456789ABCDEF"
        h[c.to_int() >> 4:(c.to_int() >> 4) + 1].to_owned() +
        h[c.to_int() & 15:(c.to_int() & 15) + 1].to_owned()
      })
      .join("") +
      "'"
    Text(s) => {
      let chars : Array[Char] = []
      for c in s.iter() {
        if c == '\u{0}' {
          break
        }
        chars.push(c)
      }
      "'" + String::from_iter(chars.iter()).replace_all(old="'", new="''") + "'"
    }
  }
}

///|
/// Round SQLite's decimal rendering, avoiding a binary multiply by 10^n.
fn sql_round(value : Double, places : Int32) -> Double {
  if !value.is_finite() || value.abs() > 4503599627370496.0 {
    return value
  }
  if places == 0 {
    return (if value < 0.0 {
        -(value.abs() + 0.5).floor()
      } else {
        (value + 0.5).floor()
      }) +
      0.0
  }
  if value == 0.0 {
    return 0.0
  }
  let bits = value.abs().reinterpret_as_uint64()
  let exponent = ((bits >> 52) & 0x7ffUL).to_int()
  let mantissa = (bits & 0xfffffffffffffUL) |
    (if exponent == 0 { 0UL } else { 0x10000000000000UL })
  let power = if exponent == 0 { -1074 } else { exponent - 1075 }
  let ten = @bigint.BigInt::from_int(10).pow(@bigint.BigInt::from_int(places))
  let mut numerator = @bigint.BigInt::from_uint64(mantissa) * ten
  let mut denominator = @bigint.BigInt::from_int(1)
  if power >= 0 {
    numerator = numerator << power
  } else {
    denominator = denominator << -power
  }
  let rounded = (numerator + denominator / @bigint.BigInt::from_int(2)) /
    denominator
  let result = @string.parse_double(
    rounded.to_string() + "e-" + places.to_string(),
  ) catch {
    _ => 0.0
  }
  if value < 0.0 {
    -result
  } else {
    result
  }
}

// Source: sql_prepared.mbt

///|
/// Opaque SQL handle owned by one Database. Only immutable data-statement ASTs
/// and schema-derived metadata are retained; bindings/rows/results are per call.
struct SqlPrepared {
  database : Database
  sql : String
  statement : ParsedStatement?
  parameters : Int32
  error : String?
  mut epoch : Int64
  mut selection : PreparedSelection?
  mut update : PreparedUpdatePlan?
}

///|
/// Parse once; semantic metadata is prepared after validating execution bindings.
/// DDL/transaction/PRAGMA retain the uncached parser/executor, including mutable
/// CREATE TABLE definitions and state-dependent PRAGMA behavior.
pub fn database_prepare(db : Database, sql : String) -> SqlPrepared {
  let (statement, parameters, error) = try {
    let parser = lex(sql)
    let statement = parse_statement(parser)
    let statement = match statement {
      Select(_) | Insert(_) | Update(_, _, _, _) | Delete(_, _, _) =>
        Some(statement)
      _ => None
    }
    (statement, parser.parameter, None)
  } catch {
    error => (None, 0, Some(public_error(error)))
  }
  {
    database: db,
    sql,
    statement,
    parameters,
    error,
    epoch: -1L,
    selection: None,
    update: None,
  }
}

///|
fn prepare_sql_metadata(query : SqlPrepared) -> Unit raise SqlError {
  let db = query.database
  guard query.statement is Some(statement) else { fail("invalid SQL plan") }
  if query.epoch != db.schema_epoch {
    let selection = match statement {
      Select(select) =>
        Some(prepare_selection(db.store, select, query.parameters))
      _ => None
    }
    let update = match statement {
      Update(name, setters, predicate, returning) => {
        let (plan, _) = prepare_update(
          db.store,
          name,
          setters,
          predicate,
          returning,
          query.parameters,
        )
        Some(plan)
      }
      _ => None
    }
    query.selection = selection
    query.update = update
    query.epoch = db.schema_epoch
  }
}

///|
fn prepared_sql_rows(
  query : SqlPrepared,
  params : Array[Value],
) -> Array[Environment] raise SqlError {
  let db = query.database
  guard query.statement is Some(statement) else { fail("invalid SQL plan") }
  prepare_sql_metadata(query)
  let data = match statement {
    Select(select) => PreparedSelect(select)
    Insert(insert) => PreparedInsert(insert)
    Update(name, setters, predicate, returning) =>
      PreparedUpdate(name, setters, predicate, returning)
    Delete(name, predicate, returning) =>
      PreparedDelete(name, predicate, returning)
    _ => fail("invalid SQL plan")
  }
  execute_data_statement(
    db.store,
    data,
    params,
    prepared_selection=query.selection,
    prepared_update=query.update,
  )
}

///|
/// Execute against the handle's owning connection and its current schema/state.
pub fn database_prepared_exec(
  query : SqlPrepared,
  bindings : String,
  read_only : Bool,
  positional : Bool,
) -> String {
  if query.error is Some(message) {
    return ({ "error": message } : Json).stringify()
  }
  database_exec_inner(
    query.database,
    query.sql,
    bindings,
    read_only,
    positional,
    prepared=if query.statement is Some(_) { Some(query) } else { None },
  )
}

// Source: sql_render.mbt

///|
fn sql_name(name : String) -> String {
  "\"" + name.replace_all(old="\"", new="\"\"") + "\""
}

// Source: sqlite_file.mbt

///|
/// SQLite file format 3 reader. All offsets, lengths and page ownership are
/// checked before use; no native SQLite or host SQL/parser is involved.
priv struct DiskCursor {
  data : Bytes
  mut position : Int32
  end : Int32
}

///|
priv struct DiskRow {
  key : Int64
  values : Array[Value]
}

///|
priv struct SQLiteFile {
  data : Bytes
  page_size : Int32
  usable : Int32
  pages : Int32
  encoding : Int32
  format : Int32
  owners : Array[Int32]
  parents : Array[Int32]
}

///|
fn DiskCursor::take(c : DiskCursor, n : Int32) -> BytesView raise SqlError {
  guard n >= 0 && n <= c.end - c.position else {
    fail("corrupt SQLite: truncated field")
  }
  let bytes = c.data[c.position:c.position + n]
  c.position += n
  bytes
}

///|
fn DiskCursor::byte(c : DiskCursor) -> Int32 raise SqlError {
  c.take(1)[0].to_int()
}

///|
fn DiskCursor::u16(c : DiskCursor) -> Int32 raise SqlError {
  (c.byte() << 8) | c.byte()
}

///|
fn DiskCursor::word(c : DiskCursor) -> Int64 raise SqlError {
  let mut result = 0L
  for _ in 0..<4 {
    result = (result << 8) | c.byte().to_int64()
  }
  result
}

///|
/// The ninth byte contributes all eight bits (including negative rowids).
fn DiskCursor::varint(c : DiskCursor) -> UInt64 raise SqlError {
  let mut result = 0UL
  for _ in 0..<8 {
    let b = c.byte()
    result = (result << 7) | (b & 127).to_uint64()
    if b < 128 {
      return result
    }
  }
  (result << 8) | c.byte().to_uint64()
}

///|
fn disk_int(value : UInt64, limit : Int32) -> Int32 raise SqlError {
  guard value <= limit.to_uint64() else {
    fail("corrupt SQLite: length/resource limit")
  }
  value.to_int()
}

///|
fn disk_cursor(
  data : Bytes,
  offset : Int32,
  end : Int32,
) -> DiskCursor raise SqlError {
  guard offset >= 0 && end >= offset && end <= data.length() else {
    fail("corrupt SQLite: invalid offset")
  }
  { data, position: offset, end, }
}

///|
fn SQLiteFile::page_number(
  file : SQLiteFile,
  n : Int64,
) -> Int32 raise SqlError {
  guard n >= 1L && n <= file.pages.to_int64() else {
    fail("corrupt SQLite: invalid page number")
  }
  n.to_int()
}

///|
/// Roles match SQLite pointer-map types. 6 is the pointer-map page itself.
fn SQLiteFile::claim(
  file : SQLiteFile,
  page : Int32,
  role : Int32,
  parent : Int32,
) -> Unit raise SqlError {
  guard page >= 1 && page <= file.pages && file.owners[page] == 0 else {
    fail("corrupt SQLite: cyclic/shared page ownership")
  }
  file.owners[page] = role
  file.parents[page] = parent
}

///|
fn SQLiteFile::at(
  file : SQLiteFile,
  page : Int32,
  offset : Int32,
) -> DiskCursor raise SqlError {
  guard page >= 1 && page <= file.pages && offset >= 0 && offset <= file.usable else {
    fail("corrupt SQLite: page offset")
  }
  disk_cursor(
    file.data,
    (page - 1) * file.page_size + offset,
    (page - 1) * file.page_size + file.usable,
  )
}

///|
fn sqlite_header(data : Bytes) -> SQLiteFile raise SqlError {
  guard data.length() >= 100 &&
    data.length() <= 67108864 &&
    data[0:16] == b"SQLite format 3\x00" else {
    fail("invalid SQLite image header/size")
  }
  let c = disk_cursor(data, 16, 100)
  let size = c.u16()
  let page_size = if size == 1 { 65536 } else { size }
  guard page_size >= 512 &&
    page_size <= 65536 &&
    (page_size & (page_size - 1)) == 0 &&
    data.length() % page_size == 0 else {
    fail("corrupt SQLite: page size/truncated image")
  }
  let write_version = c.byte()
  let read_version = c.byte()
  guard (write_version == 1 || write_version == 2) &&
    (read_version == 1 || read_version == 2) else {
    fail("unsupported SQLite file version")
  }
  let usable = page_size - c.byte()
  guard usable >= 480 && c.byte() == 64 && c.byte() == 32 && c.byte() == 32 else {
    fail("corrupt SQLite: page reserve/payload fractions")
  }
  let pages = data.length() / page_size
  let change = c.word()
  let declared = c.word()
  let valid = disk_cursor(data, 92, 100).word()
  guard declared == 0L || change != valid || declared == pages.to_int64() else {
    fail("corrupt SQLite: declared page count")
  }
  let format = disk_cursor(data, 44, 48).word()
  let encoding = disk_cursor(data, 56, 60).word()
  guard format >= 1L && format <= 4L && encoding >= 1L && encoding <= 3L else {
    fail("unsupported SQLite schema format/text encoding")
  }
  guard data[72:92].to_array().all(b => b == b'\x00') else {
    fail("unsupported SQLite header extension")
  }
  {
    data,
    page_size,
    usable,
    pages,
    encoding: encoding.to_int(),
    format: format.to_int(),
    owners: Array::make(pages + 1, 0),
    parents: Array::make(pages + 1, 0),
  }
}

///|
fn SQLiteFile::text(
  file : SQLiteFile,
  bytes : BytesView,
) -> String raise SqlError {
  try {
    if file.encoding == 1 {
      @utf8.decode(bytes, ignore_bom=false)
    } else {
      @utf16.decode(
        bytes,
        ignore_bom=false,
        endianness=if file.encoding == 2 { Little } else { Big },
      )
    }
  } catch {
    _ => fail("corrupt SQLite: malformed text encoding")
  }
}

///|
fn SQLiteFile::record(
  file : SQLiteFile,
  bytes : Bytes,
) -> Array[Value] raise SqlError {
  let header = disk_cursor(bytes, 0, bytes.length())
  let header_size = disk_int(header.varint(), bytes.length())
  guard header_size >= header.position else {
    fail("corrupt SQLite: record header size")
  }
  let header = { ..header, end: header_size, }
  let body = disk_cursor(bytes, header_size, bytes.length())
  let values : Array[Value] = []
  while header.position < header.end {
    guard values.length() < 2000 else {
      fail("SQLite record column resource limit")
    }
    let serial = disk_int(header.varint(), 134217741)
    let value : Value = if serial == 0 {
      Null
    } else if serial == 8 || serial == 9 {
      guard file.format >= 4 else {
        fail("corrupt SQLite: serial type in legacy format")
      }
      Integer((serial - 8).to_int64())
    } else if serial >= 1 && serial <= 7 {
      let width = match serial {
        1 => 1
        2 => 2
        3 => 3
        4 => 4
        5 => 6
        _ => 8
      }
      let mut bits = 0UL
      for b in body.take(width) {
        bits = (bits << 8) | b.to_uint64()
      }
      if serial == 7 {
        let real = bits.reinterpret_as_double()
        guard !real.is_nan() else { fail("unsupported SQLite non-finite REAL") }
        Real(real)
      } else {
        let shift = 64 - width * 8
        Integer(bits.reinterpret_as_int64() << shift >> shift)
      }
    } else if serial >= 12 {
      let bytes = body.take((serial - 12) / 2)
      if serial % 2 == 0 {
        Blob(bytes.to_owned())
      } else {
        Text(file.text(bytes))
      }
    } else {
      fail("corrupt SQLite: reserved serial type")
    }
    values.push(value)
  }
  guard body.position == body.end else {
    fail("corrupt SQLite: trailing record bytes")
  }
  values
}

///|
fn SQLiteFile::payload(
  file : SQLiteFile,
  page : Int32,
  cursor : DiskCursor,
  size : Int32,
  index : Bool,
) -> Bytes raise SqlError {
  guard size >= 1 && size <= 67108864 else {
    fail("corrupt SQLite: payload size")
  }
  let maximum = if index {
    (file.usable - 12) * 64 / 255 - 23
  } else {
    file.usable - 35
  }
  let minimum = (file.usable - 12) * 32 / 255 - 23
  let proposed = minimum + (size - minimum) % (file.usable - 4)
  let local_size = if size <= maximum {
    size
  } else if proposed <= maximum {
    proposed
  } else {
    minimum
  }
  let buffer = @buffer.Buffer()
  buffer.write_bytes(cursor.take(local_size).to_owned())
  let mut remaining = size - local_size
  if remaining > 0 {
    let mut next = file.page_number(cursor.word())
    let mut previous = page
    let mut first = true
    while remaining > 0 {
      file.claim(next, if first { 3 } else { 4 }, previous)
      let overflow = file.at(next, 0)
      let following = overflow.word()
      let count = remaining.min(file.usable - 4)
      buffer.write_bytes(overflow.take(count).to_owned())
      remaining -= count
      previous = next
      first = false
      if remaining > 0 {
        next = file.page_number(following)
      } else {
        guard following == 0L else {
          fail("corrupt SQLite: excess overflow chain")
        }
      }
    }
  }
  buffer.to_bytes()
}

///|
/// In-order traversal includes records on index interior pages (WITHOUT ROWID).
fn SQLiteFile::walk(
  file : SQLiteFile,
  page : Int32,
  index : Bool,
  parent : Int32,
  depth : Int32,
  output : Array[DiskRow],
) -> Int32 raise SqlError {
  guard depth <= 32 else { fail("SQLite B-tree depth resource limit") }
  file.claim(page, if parent == 0 { 1 } else { 5 }, parent)
  let offset = if page == 1 { 100 } else { 0 }
  let header = file.at(page, offset)
  let kind = header.byte()
  guard (if index { kind == 2 || kind == 10 } else { kind == 5 || kind == 13 }) else {
    fail("corrupt SQLite: B-tree page type")
  }
  let interior = kind == 2 || kind == 5
  let mut free = header.u16()
  let count = header.u16()
  let content = header.u16()
  let content = if content == 0 && file.page_size == 65536 {
    65536
  } else {
    content
  }
  let fragments = header.byte()
  let right = if interior { file.page_number(header.word()) } else { 0 }
  let pointers_end = header.position - (page - 1) * file.page_size + count * 2
  guard pointers_end <= content && content <= file.usable && fragments <= 60 else {
    fail("corrupt SQLite: B-tree header/cell array")
  }
  let spans : Array[(Int32, Int32)] = []
  let mut height = -1
  let mut previous_separator : Int64? = None
  for _ in 0..<count {
    let pointer = header.u16()
    guard pointer >= content && pointer < file.usable else {
      fail("corrupt SQLite: cell pointer")
    }
    let cell = file.at(page, pointer)
    let child = if interior { file.page_number(cell.word()) } else { 0 }
    if interior {
      let start = output.length()
      let h = file.walk(child, index, page, depth + 1, output)
      guard height < 0 || height == h else {
        fail("corrupt SQLite: unbalanced B-tree")
      }
      height = h
      if !index {
        guard output.length() > start else {
          fail("corrupt SQLite: empty table subtree")
        }
        if previous_separator is Some(key) {
          guard output[start].key > key else {
            fail("corrupt SQLite: table separator range")
          }
        }
      }
    }
    if kind == 5 {
      let key = cell.varint().reinterpret_as_int64()
      guard previous_separator is None ||
        (previous_separator is Some(previous) && previous < key) else {
        fail("corrupt SQLite: unordered table separators")
      }
      guard !output.is_empty() && output[output.length() - 1].key <= key else {
        fail("corrupt SQLite: table separator")
      }
      previous_separator = Some(key)
    } else {
      let size = disk_int(cell.varint(), 67108864)
      let key = if index { 0L } else { cell.varint().reinterpret_as_int64() }
      if !index && !output.is_empty() {
        guard output[output.length() - 1].key < key else {
          fail("corrupt SQLite: unordered/duplicate rowid")
        }
      }
      let payload = file.payload(page, cell, size, index)
      output.push({ key, values: file.record(payload), })
      guard output.length() <= 100000 else {
        fail("SQLite B-tree row resource limit")
      }
    }
    spans.push((pointer, cell.position - (page - 1) * file.page_size))
  }
  if interior {
    let start = output.length()
    let h = file.walk(right, index, page, depth + 1, output)
    guard height < 0 || height == h else {
      fail("corrupt SQLite: unbalanced right subtree")
    }
    height = h
    if !index && previous_separator is Some(key) {
      guard output.length() > start && output[start].key > key else {
        fail("corrupt SQLite: right separator range")
      }
    }
  }
  // Validate both cell extents and freeblock chains, including overlaps.
  while free != 0 {
    guard free >= content && free + 4 <= file.usable else {
      fail("corrupt SQLite: freeblock pointer")
    }
    let block = file.at(page, free)
    let next = block.u16()
    let size = block.u16()
    guard size >= 4 &&
      size <= file.usable - free &&
      (next == 0 || next >= free + size) else {
      fail("corrupt SQLite: freeblock chain")
    }
    spans.push((free, free + size))
    free = next
  }
  spans.sort_by((a, b) => a.0.compare(b.0))
  let mut end = content
  let mut actual_fragments = 0
  for span in spans {
    guard span.0 >= end && span.1 > span.0 && span.1 <= file.usable else {
      fail("corrupt SQLite: overlapping cells/freeblocks")
    }
    let gap = span.0 - end
    guard gap <= 3 else { fail("corrupt SQLite: unlisted free space") }
    actual_fragments += gap
    end = span.1
  }
  let gap = file.usable - end
  guard gap <= 3 && actual_fragments + gap == fragments else {
    fail("corrupt SQLite: fragmented space count")
  }
  if interior {
    height + 1
  } else {
    0
  }
}

///|
fn SQLiteFile::tree(
  file : SQLiteFile,
  root : Int32,
  index : Bool,
) -> Array[DiskRow] raise SqlError {
  let rows : Array[DiskRow] = []
  ignore(file.walk(root, index, 0, 0, rows))
  rows
}

///|
fn SQLiteFile::freelist(file : SQLiteFile) -> Unit raise SqlError {
  let header = disk_cursor(file.data, 32, 40)
  let mut next = header.word()
  let expected = header.word()
  guard expected <= file.pages.to_int64() else {
    fail("corrupt SQLite: freelist count")
  }
  let mut total = 0
  while next != 0L {
    let page = file.page_number(next)
    file.claim(page, 2, 0)
    total += 1
    let trunk = file.at(page, 0)
    next = trunk.word()
    let count = trunk.word()
    guard count <= ((file.usable - 8) / 4).to_int64() else {
      fail("corrupt SQLite: freelist trunk size")
    }
    for _ in 0..<count.to_int() {
      file.claim(file.page_number(trunk.word()), 2, 0)
      total += 1
    }
  }
  guard total.to_int64() == expected else {
    fail("corrupt SQLite: freelist size mismatch")
  }
}

///|
fn SQLiteFile::reserve_ptrmap(file : SQLiteFile) -> Unit raise SqlError {
  if disk_cursor(file.data, 52, 56).word() == 0L {
    return
  }
  let interval = file.usable / 5 + 1
  for page = 2; page <= file.pages; page = page + interval {
    file.claim(page, 6, 0)
  }
}

///|
fn SQLiteFile::validate_pages(file : SQLiteFile) -> Unit raise SqlError {
  let mapped = disk_cursor(file.data, 52, 56).word() != 0L
  let interval = file.usable / 5 + 1
  for page in 1..<=file.pages {
    guard file.owners[page] != 0 else {
      fail("corrupt SQLite: unreferenced page")
    }
    if !mapped || page == 1 || file.owners[page] == 6 {
      continue
    }
    let map_page = 2 + (page - 2) / interval * interval
    let entry = file.at(map_page, (page - map_page - 1) * 5)
    guard entry.byte() == file.owners[page] &&
      entry.word() == file.parents[page].to_int64() else {
      fail("corrupt SQLite: pointer-map backlink")
    }
  }
}

// Source: sqlite_import.mbt

///|
/// Physical decoding is separate from SQL/storage state. Only a fully checked
/// candidate replaces the destination connection.
priv struct DiskSchema {
  kind : String
  name : String
  table : String
  root : Int32
  sql : String?
}

///|
fn sqlite_schema(file : SQLiteFile) -> Array[DiskSchema] raise SqlError {
  let entries : Array[DiskSchema] = []
  let names : Map[String, Bool] = Map([])
  for row in file.tree(1, false) {
    guard row.values
      is [Text(kind), Text(name), Text(table), Integer(root), sql] else {
      fail("corrupt SQLite: schema record")
    }
    guard ["table", "index", "view", "trigger"].contains(kind) &&
      !names.contains(schema_name_key(kind, name)) else {
      fail("corrupt SQLite: schema object type/name")
    }
    names[schema_name_key(kind, name)] = true
    let definition = match sql {
      Text(s) => Some(s)
      Null => None
      _ => fail("corrupt SQLite: schema SQL")
    }
    let page = if kind == "table" || kind == "index" {
      file.page_number(root)
    } else {
      guard root == 0L else { fail("corrupt SQLite: non-table root page") }
      0
    }
    entries.push({ kind, name, table, root: page, sql: definition, })
    guard entries.length() <= 2000 else {
      fail("SQLite schema object resource limit")
    }
  }
  entries
}

///|
fn sqlite_table_rows(
  file : SQLiteFile,
  table : Table,
  root : Int32,
  store : Store,
) -> Unit raise SqlError {
  let keys = primary_key(table)
  let order = if table.without_rowid {
    keys + insert_columns(table).filter(i => !keys.contains(i))
  } else {
    insert_columns(table)
  }
  let ipk = integer_primary(table)
  let rows = file.tree(root, table.without_rowid)
  for c in table.columns {
    prepare_default(store, c)
  }
  for index, row in rows {
    guard row.values.length() <= order.length() else {
      fail("corrupt SQLite: table record width")
    }
    let values : Array[Value] = Array::make(table.columns.length(), Null)
    for i in row.values.length()..<order.length() {
      let column = order[i]
      guard literal_default(table.columns[column].default_value) else {
        fail("unsupported SQLite missing expression-default cell")
      }
      values[column] = column_default(store, table, table.columns[column], [])
    }
    for i, value in row.values {
      let column = order[i]
      // REAL-affinity integers are a physical storage optimization in SQLite.
      values[column] = if affinity_name(table.columns[column].declared) ==
        "real" &&
        value is Integer(n) {
        Real(n.to_double())
      } else {
        value
      }
    }
    if ipk >= 0 {
      values[ipk] = Integer(row.key)
    }
    let id = if table.without_rowid { (index + 1).to_int64() } else { row.key }
    if table.without_rowid && !table.rows.is_empty() {
      let before = table.rows[table.rows.length() - 1]
      let mut comparison = 0
      for i in keys {
        comparison = compare_stored(
          store,
          before.values[i],
          values[i],
          table.columns[i].collation,
        )
        if comparison != 0 {
          break
        }
      }
      guard comparison < 0 else {
        fail("corrupt SQLite: unordered WITHOUT ROWID keys")
      }
    }
    table.sequence = table.sequence.max(id)
    append_table_row(
      store,
      table,
      generated_row(store, table, { id, values, }, storage=true),
    )
  }
}

///|
/// Canonical numeric keys compare the INTEGER/REAL representations exactly.
fn sqlite_key(values : Array[Value]) -> String {
  Json::array(
    values.map(value => {
      let value = match value {
        Real(n) =>
          if n >= -9223372036854775808.0 &&
            n < 9223372036854775808.0 &&
            n.to_int64().to_double() == n {
            Value::Integer(n.to_int64())
          } else {
            value
          }
        _ => value
      }
      value_json(value)
    }),
  ).stringify()
}

///|
fn sqlite_index_matches(
  store : Store,
  table : Table,
  index : UniqueIndex,
  records : Array[DiskRow],
) -> Bool raise SqlError {
  let tail = if table.without_rowid {
    primary_key(table).filter(i => {
      !index.parts.any(p => {
        p.column == i && p.collation == table.columns[i].collation
      })
    })
  } else {
    [-1]
  }
  let fields = index.parts +
    tail.map(column => {
      column,
      expression: Literal(Null),
      collation: if column < 0 {
        "binary"
      } else {
        table.columns[column].collation
      },
      descending: false,
    })
  let expected : Map[String, Int32] = Map([])
  let mut count = 0
  for row in table.rows {
    guard index_values(store, table, index, row.values) is Some(values) else {
      continue
    }
    let values = values +
      tail.map(i => if i < 0 { Integer(row.id) } else { row.values[i] })
    let key = sqlite_key(values)
    expected[key] = expected.get(key).unwrap_or(0) + 1
    count += 1
  }
  if count != records.length() {
    return false
  }
  let mut previous : Array[Value]? = None
  for row in records {
    if row.values.length() != fields.length() {
      return false
    }
    if previous is Some(before) {
      if before.length() != row.values.length() {
        return false
      }
      let mut comparison = 0
      for i, value in row.values {
        let collation = fields[i].collation
        comparison = compare_stored(store, before[i], value, collation)
        if fields[i].descending {
          comparison = -comparison
        }
        if comparison != 0 {
          break
        }
      }
      if comparison >= 0 {
        return false
      }
    }
    previous = Some(row.values)
    let key = sqlite_key(row.values)
    let n = expected.get(key).unwrap_or(0)
    if n == 0 {
      return false
    }
    expected[key] = n - 1
  }
  true
}

///|
fn sqlite_import(data : Bytes) -> Store raise SqlError {
  let file = sqlite_header(data)
  file.reserve_ptrmap()
  file.freelist()
  let schema = sqlite_schema(file)
  let candidate = { ..database_open().store, encoding: Some(file.encoding), }
  let mut largest = 1
  for entry in schema {
    if entry.root > largest {
      largest = entry.root
    }
    if entry.kind != "table" {
      continue
    }
    guard entry.sql is Some(sql) else {
      fail("corrupt SQLite: table definition missing")
    }
    let parsed = parse_statement(lex(sql))
    guard parsed is CreateTable(table, _) &&
      identifier(table.name) == identifier(entry.name) &&
      identifier(entry.table) == identifier(entry.name) else {
      fail("unsupported SQLite table definition")
    }
    table.sql = sql
    candidate.tables.push(table)
    sqlite_table_rows(file, table, entry.root, candidate)
  }
  // Install all declared index constraints before validating rows / FK targets.
  for entry in schema {
    if entry.kind == "table" {
      continue
    }
    if entry.sql is Some(sql) {
      let parsed = parse_statement(lex(sql))
      guard parsed is CreateObject(object, _) &&
        object.kind == entry.kind &&
        identifier(object.name) == identifier(entry.name) &&
        identifier(object.table) == identifier(entry.table) else {
        fail("unsupported SQLite schema definition")
      }
      if object.kind == "index" {
        validate_index_definition(
          candidate,
          get_table(candidate, object.table),
          object,
        )
      }
      candidate.objects.push(object)
    } else {
      guard entry.kind == "index" && entry.name.has_prefix("sqlite_autoindex_") else {
        fail("corrupt SQLite: missing schema definition")
      }
    }
  }
  for entry in schema {
    if entry.kind != "index" {
      continue
    }
    let records = file.tree(entry.root, true)
    let table = get_table(candidate, entry.table)
    let alternatives = if entry.sql is Some(sql) {
      guard parse_statement(lex(sql)) is CreateObject(object, _) else {
        fail("unsupported SQLite index definition")
      }
      [object_index(object, table)]
    } else {
      table.unique_keys.map(key => {
        (
          {
            parts: key.map(column => {
              column,
              expression: Column("", table.columns[column].name),
              collation: table.columns[column].collation,
              descending: false,
            }),
            predicate: None,
          } : UniqueIndex)
      })
    }
    guard alternatives.any(index => {
      sqlite_index_matches(candidate, table, index, records)
    }) else {
      fail("corrupt SQLite: index/table records disagree")
    }
  }
  let sequences = candidate.tables.filter(t => {
    identifier(t.name) == "sqlite_sequence"
  })
  if !sequences.is_empty() {
    let sequence = sequences[0]
    let name = column_index(sequence, "name")
    let number = column_index(sequence, "seq")
    for row in sequence.rows {
      guard row.values[name] is Text(name) && row.values[number] is Integer(n) else {
        fail("corrupt SQLite: AUTOINCREMENT sequence")
      }
      for table in candidate.tables {
        if table.autoincrement && identifier(table.name) == identifier(name) {
          table.sequence = table.sequence.max(n)
          table.sequence_present = Some(true)
        }
      }
    }
  }
  let cookie = disk_cursor(data, 40, 44).word()
  guard cookie <= 2147483647L else {
    fail("unsupported SQLite schema cookie range")
  }
  candidate.cookie = cookie.to_int()
  let max_root = disk_cursor(data, 52, 56).word()
  guard max_root == 0L || max_root == largest.to_int64() else {
    fail("corrupt SQLite: largest root page")
  }
  file.validate_pages()
  validate_image(candidate)
  candidate
}

///|
fn database_import_sqlite(db : Database, image : Bytes) -> String {
  try {
    let candidate = sqlite_import(image)
    db.store = candidate
    db.serial += 1
    db.schema_epoch += 1L
    "{}"
  } catch {
    error => ({ "error": public_error(error) } : Json).stringify()
  }
}

///|
/// Portable string ABI for Wasm GC. The JavaScript backend uses bytes directly.
fn database_import_sqlite_base64(db : Database, image : String) -> String {
  try {
    guard image.length() <= 89478488 else {
      fail("SQLite base64 resource limit")
    }
    database_import_sqlite(db, @base64.decode(image))
  } catch {
    _ => "{\"error\":\"invalid SQLite base64 image\"}"
  }
}

// Source: sqlite_pager.mbt

///|
/// Explicit, optional export cursor. Clean pages live in the host's bounded
/// cache; this cursor retains only immutable logical row roots and metadata.
struct SqlitePager {
  mut base : PagerBase?
  mut generation : Int32
}

///|
priv struct PagerBase {
  program : String
  serial : Int32
  epoch : Int64
  cookie : Int32
  size : Int32
  count : Int32
  tables : Array[Table]
}

///|
priv struct PagerUpdate {
  root : Int32
  rowid : Int64
  before : Bytes
  after : Bytes
}

///|
priv enum PagerMode {
  Header
  Tree
  Overflow(Int32, Int32)
  Done
}

///|
priv struct PagerTask {
  owner : SqlitePager
  generation : Int32
  database : Database
  store : Store
  plan : StoragePlan
  program : String
  serial : Int32
  epoch : Int64
  base : PagerBase?
  updates : Array[PagerUpdate]
  dirty : Map[Int32, Bytes]
  visited : Map[Int32, Bool]
  mut image : Bytes?
  mut fallback : String?
  mut size : Int32
  mut count : Int32
  mut position : Int32
  mut request : Int32
  mut mode : PagerMode
  mut blocks : Int32
  mut reads : Int32
}

///|
struct SqlitePageBatch {
  task : PagerTask?
  mut error : String?
}

///|
fn sqlite_pager_open() -> SqlitePager {
  { base: None, generation: 0, }
}

///|
fn pager_full(task : PagerTask, reason : String) -> Unit raise {
  let image = sqlite_export(task.store, task.serial, task.plan)
  task.image = Some(image)
  task.size = task.plan.page_size
  task.count = image.length() / task.size
  task.fallback = Some(reason)
  task.dirty.clear()
  task.request = 0
  task.mode = Done
}

///|
fn pager_record(table : Table, row : StoredRow) -> Bytes raise SqlError {
  let ipk = integer_primary(table)
  sqlite_record(
    insert_columns(table).map(i => if i == ipk { Null } else { row.values[i] }),
  )
}

///|
fn pager_index_values(
  store : Store,
  tree : StorageTree,
  table : Table,
  row : StoredRow,
) -> Array[Value]? raise SqlError {
  let context = evaluation(store, [], row_environment(table, row, table.name))
  if tree.predicate is Some(e) && truth(evaluate(e, context)) != 1 {
    return None
  }
  Some(
    tree.fields.map(f => {
      if f.column == -2 {
        guard f.expression is Some(e) else {
          fail("missing pager index expression")
        }
        evaluate(e, context)
      } else if f.column == -1 {
        Integer(row.id)
      } else {
        row.values[f.column]
      }
    }),
  )
}

///|
fn pager_same_index(a : Array[Value]?, b : Array[Value]?) -> Bool {
  match (a, b) {
    (None, None) => true
    (Some(a), Some(b)) =>
      a.length() == b.length() &&
      a.mapi((i, v) => same_stored_value(v, b[i])).all(v => v)
    _ => false
  }
}

///|
fn pager_changes(task : PagerTask, base : PagerBase) -> String? raise SqlError {
  if task.store.tables.length() != base.tables.length() {
    return Some("schema")
  }
  for ti, table in task.store.tables {
    let before = base.tables[ti]
    if before.name != table.name ||
      before.sql != table.sql ||
      before.rows.count != table.rows.count ||
      before.rows.used != table.rows.used ||
      before.sequence != table.sequence ||
      before.sequence_present != table.sequence_present {
      return Some("row-layout-or-sequence")
    }
    if physical_equal(before.rows.pages, table.rows.pages) {
      continue
    }
    let trees = task.plan.trees.filter(t => t.table == table.name)
    let root = trees.iter().find_first(t => t.kind == "table")
    guard root is Some(root) && !table.without_rowid else {
      return Some("without-rowid")
    }
    for pi in 0..<table.rows.pages.length() {
      let page = table.rows.pages[pi]
      task.blocks += 1
      let old = before.rows.pages[pi]
      if physical_equal(page, old) {
        continue
      }
      if old.rows.length() != page.rows.length() {
        return Some("row-layout")
      }
      for ri, row in page.rows {
        match (old.rows[ri], row) {
          (None, None) => ()
          (Some(old), Some(row)) => {
            if physical_equal(old, row) {
              continue
            }
            if old.id != row.id {
              return Some("rowid-change")
            }
            let a = pager_record(table, old)
            let b = pager_record(table, row)
            if a == b {
              continue
            }
            for tree in trees {
              if tree.kind == "index" &&
                (
                  tree.predicate is Some(_) ||
                  tree.fields.any(f => {
                    f.expression is Some(_) ||
                    (f.column >= 0 && generated_column(table.columns[f.column]))
                  })
                ) {
                return Some("complex-index")
              }
              if tree.kind == "index" &&
                !pager_same_index(
                  pager_index_values(task.store, tree, table, old),
                  pager_index_values(task.store, tree, table, row),
                ) {
                return Some("index-key-change")
              }
            }
            if task.updates.length() >= 128 {
              return Some("changed-row-budget")
            }
            task.updates.push({
              root: root.root,
              rowid: row.id,
              before: a,
              after: b,
            })
          }
          _ => return Some("insert-or-delete")
        }
      }
    }
  }
  None
}

///|
fn pager_prepare(
  connection : Connection,
  program : Program,
  pager : SqlitePager,
  storage~ : StoragePlan? = None,
) -> PagerTask raise {
  connection.healthy()
  let database = connection.database
  guard database.store.transactions.frames.is_empty() else {
    fail("cannot page an active SQL transaction")
  }
  let chosen = if storage is Some(_) { storage } else { program.storage }
  guard chosen is Some(plan) else {
    fail("program has no prebuilt SQLite storage template")
  }
  let task : PagerTask = {
    owner: pager,
    generation: pager.generation,
    database,
    store: copy_store(database.store),
    plan,
    program: program.id,
    serial: database.serial,
    epoch: database.schema_epoch,
    base: pager.base,
    updates: [],
    dirty: Map([]),
    visited: Map([]),
    image: None,
    fallback: None,
    size: plan.page_size,
    count: 0,
    position: 0,
    request: 0,
    mode: Done,
    blocks: 0,
    reads: 0,
  }
  match pager.base {
    None => pager_full(task, "initial")
    Some(base) => {
      task.count = base.count
      if base.program != program.id ||
        base.epoch != database.schema_epoch ||
        base.cookie != database.store.cookie ||
        base.size != plan.page_size ||
        base.serial > database.serial {
        pager_full(task, "source-reset")
      } else if pager_changes(task, base) is Some(reason) {
        pager_full(task, reason)
      } else if database.serial != base.serial || !task.updates.is_empty() {
        task.mode = Header
        task.request = 1
      }
    }
  }
  task
}

///|
fn aot_pager_prepare(db : AotDatabase, pager : SqlitePager) -> SqlitePageBatch {
  try {
    let (connection, program) = db.ready()
    { task: Some(pager_prepare(connection, program, pager)), error: None, }
  } catch {
    e => { task: None, error: Some(public_error(e)), }
  }
}

///|
fn defined_pager_prepare(
  db : DefinedDatabase,
  layout : Bytes,
  pager : SqlitePager,
) -> SqlitePageBatch {
  try {
    let (connection, program) = db.core.ready()
    {
      task: Some(
        pager_prepare(
          connection,
          program,
          pager,
          storage=Some(defined_sqlite_plan(db, layout)),
        ),
      ),
      error: None,
    }
  } catch {
    e => { task: None, error: Some(public_error(e)), }
  }
}

///|
fn pager_page_number(task : PagerTask, page : Int64) -> Int32 raise SqlError {
  guard page > 0L && page <= task.count.to_int64() else {
    fail("corrupt pager page number")
  }
  page.to_int()
}

///|
fn pager_put(
  task : PagerTask,
  page : Int32,
  before : Bytes,
  after : Bytes,
) -> Unit raise {
  if before != after {
    task.dirty[page] = after
  }
  if task.dirty.length() > 4194304 / task.size {
    pager_full(task, "dirty-page-budget")
  }
}

///|
fn pager_next(task : PagerTask) -> Unit {
  task.position += 1
  task.visited.clear()
  if task.position < task.updates.length() {
    task.request = task.updates[task.position].root
    task.mode = Tree
  } else {
    task.request = 0
    task.mode = Done
  }
}

///|
fn pager_accept(task : PagerTask, page : Int32, data : Bytes) -> Unit raise {
  guard page == task.request && data.length() == task.size else {
    fail("unexpected pager page/size")
  }
  guard !task.visited.contains(page) else { fail("corrupt pager page cycle") }
  task.visited[page] = true
  match task.mode {
    Header => {
      let base = task.base.unwrap()
      let template = @base64.decode(task.plan.image)
      let initial = disk_cursor(template, 24, 28).word()
      guard data[0:16] == b"SQLite format 3\x00" &&
        disk_cursor(data, 16, 18).u16() ==
        (if task.size == 65536 { 1 } else { task.size }) &&
        disk_cursor(data, 28, 32).word() == task.count.to_int64() &&
        disk_cursor(data, 24, 28).word() ==
        ((initial + base.serial.to_int64()) & 0xffffffffL) &&
        disk_cursor(data, 40, 44).word() == disk_cursor(template, 40, 44).word() else {
        fail("pager base header mismatch")
      }
      let first = FixedArray::makei(task.size, i => data[i])
      let change = (initial + task.serial.to_int64()).reinterpret_as_uint64() &
        0xffffffffUL
      sqlite_word(first, 24, change, 4)
      sqlite_word(first, 92, change, 4)
      sqlite_word(first, 96, 0UL, 4)
      pager_put(task, 1, data, Bytes::from_array(first[:]))
      task.position = -1
      pager_next(task)
    }
    Tree => {
      let op = task.updates[task.position]
      let c = disk_cursor(data, 0, task.size)
      let flag = c.byte()
      ignore(c.u16())
      let count = c.u16()
      let header = if flag == 5 { 12 } else { 8 }
      guard (flag == 5 || flag == 13) && count <= (task.size - header) / 2 else {
        fail("corrupt pager B-tree header")
      }
      if flag == 5 {
        let mut child = disk_cursor(data, 8, 12).word()
        let mut previous : Int64? = None
        for i in 0..<count {
          let offset = disk_cursor(data, header + i * 2, header + i * 2 + 2).u16()
          guard offset >= header + count * 2 else {
            fail("corrupt pager cell offset")
          }
          let key = disk_cursor(data, offset, task.size)
          let next = key.word()
          let rowid = key.varint().reinterpret_as_int64()
          guard previous.map(p => p < rowid).unwrap_or(true) else {
            fail("corrupt pager key order")
          }
          previous = Some(rowid)
          if op.rowid <= rowid {
            child = next
            break
          }
        }
        task.request = pager_page_number(task, child)
      } else {
        let cells : Array[Bytes] = []
        let mut found = -1
        let mut local_offset = 0
        let mut overflow = 0
        let mut local_size = 0
        let mut previous : Int64? = None
        let ranges : Array[(Int32, Int32)] = []
        for i in 0..<count {
          let offset = disk_cursor(data, header + i * 2, header + i * 2 + 2).u16()
          guard offset >= header + count * 2 else {
            fail("corrupt pager cell offset")
          }
          let cell = disk_cursor(data, offset, task.size)
          let size = disk_int(cell.varint(), 67108864)
          let rowid = cell.varint().reinterpret_as_int64()
          guard previous.map(p => p < rowid).unwrap_or(true) else {
            fail("corrupt pager key order")
          }
          previous = Some(rowid)
          let maximum = task.size - 35
          let minimum = (task.size - 12) * 32 / 255 - 23
          let proposed = minimum + (size - minimum) % (task.size - 4)
          let n = if size <= maximum {
            size
          } else if proposed <= maximum {
            proposed
          } else {
            minimum
          }
          let start = cell.position
          ignore(cell.take(n))
          let next = if n < size {
            pager_page_number(task, cell.word())
          } else {
            0
          }
          guard ranges.all(r => cell.position <= r.0 || offset >= r.1) else {
            fail("corrupt pager overlapping cells")
          }
          ranges.push((offset, cell.position))
          cells.push(data[offset:cell.position].to_owned())
          if rowid == op.rowid {
            guard size == op.before.length() &&
              data[start:start + n] == op.before[0:n] else {
              fail("pager base row mismatch")
            }
            found = i
            local_offset = start
            local_size = n
            overflow = next
          }
        }
        guard found >= 0 else { fail("pager base row missing") }
        if overflow != 0 {
          if op.before.length() != op.after.length() {
            pager_full(task, "overflow-size-change")
            return
          }
          let bytes = FixedArray::makei(task.size, i => data[i])
          bytes.blit_from_bytes(local_offset, op.after, 0, local_size)
          pager_put(task, page, data, Bytes::from_array(bytes[:]))
          if task.image is Some(_) {
            return
          }
          task.request = overflow
          task.mode = Overflow(local_size, op.after.length())
        } else {
          if op.after.length() > task.size - 35 {
            pager_full(task, "overflow-growth")
            return
          }
          let out = @buffer.Buffer()
          out.write_bytes(sqlite_varint(op.after.length().to_uint64())[:])
          out.write_bytes(sqlite_varint(op.rowid.reinterpret_as_uint64())[:])
          out.write_bytes(op.after[:])
          cells[found] = out.to_bytes()
          let writer : PageWriter = {
            size: task.size,
            pages: [FixedArray::make(task.size, b'\x00')],
          }
          if !writer.fits(cells, false) {
            pager_full(task, "leaf-full")
            return
          }
          writer.page(1, 13, cells, 0)
          pager_put(task, page, data, Bytes::from_array(writer.pages[0][:]))
          if task.image is Some(_) {
            return
          }
          pager_next(task)
        }
      }
    }
    Overflow(position, total) => {
      let op = task.updates[task.position]
      let count = (total - position).min(task.size - 4)
      guard data[4:4 + count] == op.before[position:position + count] else {
        fail("pager overflow base mismatch")
      }
      let next = disk_cursor(data, 0, 4).word()
      guard (position + count == total) == (next == 0L) else {
        fail("corrupt pager overflow length")
      }
      let bytes = FixedArray::makei(task.size, i => data[i])
      bytes.blit_from_bytes(4, op.after, position, count)
      pager_put(task, page, data, Bytes::from_array(bytes[:]))
      if task.image is Some(_) {
        return
      }
      if next == 0L {
        pager_next(task)
      } else {
        task.request = pager_page_number(task, next)
        task.mode = Overflow(position + count, total)
      }
    }
    Done => fail("pager batch is already ready")
  }
}

///|
fn sqlite_pager_supply(
  batch : SqlitePageBatch,
  page : Int32,
  data : Bytes,
) -> String {
  if batch.error is None && batch.task is Some(task) {
    try {
      task.reads += 1
      pager_accept(task, page, data)
      while task.request != 0 {
        guard task.dirty.get(task.request) is Some(data) else { break }
        pager_accept(task, task.request, data)
      }
    } catch {
      e => batch.error = Some(public_error(e))
    }
  }
  sqlite_pager_info(batch)
}

///|
fn pager_numbers(task : PagerTask) -> Array[Int32] {
  if task.image is Some(_) {
    Array::makei(task.count, i => i + 1)
  } else {
    let pages = task.dirty.keys().to_array()
    pages.sort()
    pages
  }
}

///|
fn sqlite_pager_info(batch : SqlitePageBatch) -> String {
  if batch.error is Some(error) {
    return ({ "error": error } : Json).stringify()
  }
  guard batch.task is Some(task) else {
    return "{\"error\":\"invalid pager batch\"}"
  }
  let info : Json = {
    "ready": task.request == 0,
    "pageSize": task.size,
    "pageCount": task.count,
    "serial": task.serial,
    "programId": task.program,
    "snapshot": task.image is Some(_),
    "pages": @json.to_json(
      if task.request == 0 {
        pager_numbers(task)
      } else {
        []
      },
    ),
    "changedRows": task.updates.length(),
    "logicalBlocks": task.blocks,
    "reads": task.reads,
  }
  if info is Object(fields) {
    if task.request != 0 {
      fields["need"] = @json.to_json(task.request)
    }
    if task.fallback is Some(reason) {
      fields["fallback"] = @json.to_json(reason)
    }
  }
  info.stringify()
}

///|
fn sqlite_pager_page(batch : SqlitePageBatch, index : Int32) -> Bytes {
  if batch.error is Some(_) {
    return b""
  }
  guard batch.task is Some(task) && task.request == 0 else { return b"" }
  if task.image is Some(image) {
    guard index >= 0 && index < task.count else { return b"" }
    return image[index * task.size:(index + 1) * task.size].to_owned()
  }
  let pages = pager_numbers(task)
  guard index >= 0 && index < pages.length() else { return b"" }
  let page = pages[index]
  match task.image {
    Some(image) => image[(page - 1) * task.size:page * task.size].to_owned()
    None => Bytes::from_array(task.dirty[page].to_array())
  }
}

///|
fn sqlite_pager_page_base64(batch : SqlitePageBatch, index : Int32) -> String {
  @base64.encode(sqlite_pager_page(batch, index))
}

///|
fn sqlite_pager_supply_base64(
  batch : SqlitePageBatch,
  page : Int32,
  text : String,
) -> String {
  try {
    guard text.length() <= 87384 else { fail("pager page input limit") }
    sqlite_pager_supply(batch, page, @base64.decode(text))
  } catch {
    e => {
      batch.error = Some(public_error(e))
      sqlite_pager_info(batch)
    }
  }
}

///|
fn sqlite_pager_ack(pager : SqlitePager, batch : SqlitePageBatch) -> String {
  try {
    guard batch.error is None && batch.task is Some(task) && task.request == 0 else {
      fail("invalid pager acknowledgement")
    }
    guard physical_equal(task.owner, pager) &&
      task.generation == pager.generation &&
      task.serial == task.database.serial &&
      task.database.store.transactions.frames.is_empty() &&
      task.epoch == task.database.schema_epoch &&
      task.store.cookie == task.database.store.cookie &&
      task.store.tables.length() == task.database.store.tables.length() &&
      task.store.tables
      .mapi((i, t) => {
        physical_equal(t.rows.pages, task.database.store.tables[i].rows.pages)
      })
      .all(v => v) else {
      fail("stale pager acknowledgement")
    }
    pager.base = Some({
      program: task.program,
      serial: task.serial,
      epoch: task.epoch,
      cookie: task.store.cookie,
      size: task.size,
      count: task.count,
      tables: task.store.tables,
    })
    pager.generation += 1
    "{}"
  } catch {
    e => ({ "error": public_error(e) } : Json).stringify()
  }
}

///|
fn defined_pager_prepare_base64(
  db : DefinedDatabase,
  layout : String,
  pager : SqlitePager,
) -> SqlitePageBatch {
  defined_pager_prepare(db, @base64.decode(layout), pager) catch {
    e => { task: None, error: Some(public_error(e)), }
  }
}

// Source: sqlite_writer.mbt

///|
/// Fixed-schema SQLite page writer. DDL pages and implicit index layout come
/// from a native build-time template; all row/index/overflow bytes are MoonBit.
priv struct PageWriter {
  size : Int32
  pages : Array[FixedArray[Byte]]
}

///|
fn sqlite_word(
  page : FixedArray[Byte],
  offset : Int32,
  value : UInt64,
  width : Int32,
) -> Unit {
  for i in 0..<width {
    page[offset + i] = ((value >> ((width - i - 1) * 8)) & 255UL).to_byte()
  }
}

///|
fn sqlite_bytes_word(
  out : @buffer.Buffer,
  value : UInt64,
  width : Int32,
) -> Unit {
  for i in 0..<width {
    out.write_byte(((value >> ((width - i - 1) * 8)) & 255UL).to_byte())
  }
}

///|
fn sqlite_varint(value : UInt64) -> Bytes {
  let out = @buffer.Buffer(size_hint=9)
  if value >= 0x100000000000000UL {
    for i in 0..<8 {
      out.write_byte((((value >> ((7 - i) * 7 + 8)) & 127UL) | 128UL).to_byte())
    }
    out.write_byte((value & 255UL).to_byte())
  } else {
    let mut width = 1
    let mut rest = value >> 7
    while rest > 0UL {
      width += 1
      rest = rest >> 7
    }
    for i in 0..<width {
      let byte = ((value >> ((width - i - 1) * 7)) & 127UL).to_int()
      out.write_byte((if i + 1 == width { byte } else { byte | 128 }).to_byte())
    }
  }
  out.to_bytes()
}

///|
fn sqlite_record(values : Array[Value]) -> Bytes raise SqlError {
  let header = @buffer.Buffer()
  let body = @buffer.Buffer()
  for value in values {
    let serial = match value {
      Null => 0UL
      Integer(0L) => 8UL
      Integer(1L) => 9UL
      Integer(value) => {
        let width = if value >= -128L && value <= 127L {
          1
        } else if value >= -32768L && value <= 32767L {
          2
        } else if value >= -8388608L && value <= 8388607L {
          3
        } else if value >= -2147483648L && value <= 2147483647L {
          4
        } else if value >= -140737488355328L && value <= 140737488355327L {
          6
        } else {
          8
        }
        sqlite_bytes_word(body, value.reinterpret_as_uint64(), width)
        if width == 8 {
          6UL
        } else if width == 6 {
          5UL
        } else {
          width.to_uint64()
        }
      }
      Real(value) => {
        guard !value.is_nan() else { fail("SQLite writer rejects NaN REAL") }
        sqlite_bytes_word(body, value.reinterpret_as_uint64(), 8)
        7UL
      }
      Text(value) => {
        let bytes = @utf8.encode(value)
        body.write_bytes(bytes[:])
        13UL + bytes.length().to_uint64() * 2UL
      }
      Blob(bytes) => {
        body.write_bytes(bytes[:])
        12UL + bytes.length().to_uint64() * 2UL
      }
    }
    header.write_bytes(sqlite_varint(serial)[:])
    guard body.length() <= 67108864 else {
      fail("SQLite record resource limit")
    }
  }
  let mut size = header.length() + 1
  while true {
    let next = header.length() + sqlite_varint(size.to_uint64()).length()
    if next == size {
      break
    }
    size = next
  }
  let out = @buffer.Buffer(size_hint=size + body.length())
  out.write_bytes(sqlite_varint(size.to_uint64())[:])
  out.write_bytes(header.to_bytes()[:])
  out.write_bytes(body.to_bytes()[:])
  out.to_bytes()
}

///|
fn PageWriter::allocate(writer : PageWriter) -> Int32 raise SqlError {
  guard writer.pages.length() < 67108864 / writer.size else {
    fail("SQLite output exceeds 64 MiB limit")
  }
  writer.pages.push(FixedArray::make(writer.size, b'\x00'))
  writer.pages.length()
}

///|
fn PageWriter::cell(
  writer : PageWriter,
  payload : Bytes,
  key : Int64?,
  index : Bool,
) -> Bytes raise SqlError {
  let maximum = if index {
    (writer.size - 12) * 64 / 255 - 23
  } else {
    writer.size - 35
  }
  let minimum = (writer.size - 12) * 32 / 255 - 23
  let proposed = minimum + (payload.length() - minimum) % (writer.size - 4)
  let local_size = if payload.length() <= maximum {
    payload.length()
  } else if proposed <= maximum {
    proposed
  } else {
    minimum
  }
  let out = @buffer.Buffer()
  out.write_bytes(sqlite_varint(payload.length().to_uint64())[:])
  if key is Some(key) {
    out.write_bytes(sqlite_varint(key.reinterpret_as_uint64())[:])
  }
  out.write_bytes(payload[0:local_size])
  if local_size < payload.length() {
    let mut page = writer.allocate()
    sqlite_bytes_word(out, page.to_uint64(), 4)
    let mut position = local_size
    while position < payload.length() {
      let count = (payload.length() - position).min(writer.size - 4)
      let next = if position + count < payload.length() {
        writer.allocate()
      } else {
        0
      }
      sqlite_word(writer.pages[page - 1], 0, next.to_uint64(), 4)
      writer.pages[page - 1].blit_from_bytes(4, payload, position, count)
      position += count
      page = next
    }
  }
  out.to_bytes()
}

///|
fn PageWriter::fits(
  writer : PageWriter,
  cells : Array[Bytes],
  interior : Bool,
) -> Bool {
  let header = if interior { 12 } else { 8 }
  header +
  cells.fold(init=0, (total, cell) => {
    total + 2 + cell.length() + (if interior { 4 } else { 0 })
  }) <=
  writer.size
}

///|
fn PageWriter::page(
  writer : PageWriter,
  pgno : Int32,
  flag : Int32,
  cells : Array[Bytes],
  right : Int32,
) -> Unit raise SqlError {
  let interior = flag == 2 || flag == 5
  let header = if interior { 12 } else { 8 }
  let page = FixedArray::make(writer.size, b'\x00')
  page[0] = flag.to_byte()
  sqlite_word(page, 3, cells.length().to_uint64(), 2)
  if interior {
    sqlite_word(page, 8, right.to_uint64(), 4)
  }
  let mut position = writer.size
  for i, cell in cells {
    position -= cell.length()
    guard position >= header + cells.length() * 2 else {
      fail("SQLite B-tree page overflow")
    }
    sqlite_word(page, header + i * 2, position.to_uint64(), 2)
    page.blit_from_bytes(position, cell, 0, cell.length())
  }
  sqlite_word(page, 5, (position & 65535).to_uint64(), 2)
  writer.pages[pgno - 1] = page
}

///|
fn PageWriter::leaf_groups(
  writer : PageWriter,
  cells : Array[Bytes],
) -> Array[(Int32, Int32)] raise SqlError {
  let groups : Array[(Int32, Int32)] = []
  let mut start = 0
  let mut size = 8
  for i, cell in cells {
    guard cell.length() + 10 <= writer.size else {
      fail("SQLite cell cannot fit a leaf page")
    }
    if size + cell.length() + 2 > writer.size {
      groups.push((start, i))
      start = i
      size = 8
    }
    size += cell.length() + 2
  }
  groups.push((start, cells.length()))
  groups
}

///|
/// Each separator is owned by its parent for index trees. Group boundaries
/// promote that separator, rather than duplicating an index record in two pages.
fn PageWriter::branch_groups(
  writer : PageWriter,
  count : Int32,
  keys : Array[Bytes],
) -> Array[(Int32, Int32)] raise SqlError {
  let groups : Array[(Int32, Int32)] = []
  let mut start = 0
  while start < count {
    let mut end = start + 1
    let mut size = 12
    while end < count && size + keys[end - 1].length() + 6 <= writer.size {
      size += keys[end - 1].length() + 6
      end += 1
    }
    guard end > start + 1 || end == count else {
      fail("SQLite branch key cannot fit")
    }
    groups.push((start, end))
    start = end
  }
  if groups.length() > 1 {
    let last = groups.length() - 1
    let (a, b) = groups[last]
    if b - a == 1 {
      let (before, boundary) = groups[last - 1]
      guard boundary - before >= 3 else {
        fail("SQLite branch cannot be balanced")
      }
      groups[last - 1] = (before, boundary - 1)
      groups[last] = (a - 1, b)
    }
  }
  groups
}

///|
fn sqlite_branch_cells(
  children : Array[Int32],
  keys : Array[Bytes],
  start : Int32,
  end : Int32,
) -> Array[Bytes] {
  let cells : Array[Bytes] = []
  for i in start..<(end - 1) {
    let out = @buffer.Buffer(size_hint=4 + keys[i].length())
    sqlite_bytes_word(out, children[i].to_uint64(), 4)
    out.write_bytes(keys[i][:])
    cells.push(out.to_bytes())
  }
  cells
}

///|
fn PageWriter::table(
  writer : PageWriter,
  root : Int32,
  records : Array[(Int64, Bytes)],
) -> Unit raise SqlError {
  let cells = records.map(record => writer.cell(record.1, Some(record.0), false))
  if writer.fits(cells, false) {
    writer.page(root, 13, cells, 0)
    return
  }
  let mut nodes : Array[(Int32, Int64)] = []
  for (start, end) in writer.leaf_groups(cells) {
    let page = writer.allocate()
    writer.page(page, 13, cells[start:end].to_owned(), 0)
    nodes.push((page, records[end - 1].0))
  }
  while true {
    let keys = nodes[0:nodes.length() - 1]
      .to_owned()
      .map(node => sqlite_varint(node.1.reinterpret_as_uint64()))
    let children = nodes.map(node => node.0)
    if writer.fits(keys, true) {
      writer.page(
        root,
        5,
        sqlite_branch_cells(children, keys, 0, nodes.length()),
        children[children.length() - 1],
      )
      break
    }
    let parents : Array[(Int32, Int64)] = []
    for (start, end) in writer.branch_groups(nodes.length(), keys) {
      let page = writer.allocate()
      writer.page(
        page,
        5,
        sqlite_branch_cells(children, keys, start, end),
        children[end - 1],
      )
      parents.push((page, nodes[end - 1].1))
    }
    nodes = parents
  }
}

///|
fn PageWriter::index(
  writer : PageWriter,
  root : Int32,
  records : Array[Bytes],
) -> Unit raise SqlError {
  let cells = records.map(payload => writer.cell(payload, None, true))
  if writer.fits(cells, false) {
    writer.page(root, 10, cells, 0)
    return
  }
  let groups = writer.leaf_groups(cells)
  let mut children : Array[Int32] = []
  let mut keys : Array[Bytes] = []
  for i, (start, end) in groups {
    let stop = if i + 1 < groups.length() { end - 1 } else { end }
    guard stop > start else { fail("SQLite index leaf cannot be balanced") }
    let page = writer.allocate()
    writer.page(page, 10, cells[start:stop].to_owned(), 0)
    children.push(page)
    if stop != end {
      keys.push(cells[stop])
    }
  }
  while true {
    if writer.fits(keys, true) {
      writer.page(
        root,
        2,
        sqlite_branch_cells(children, keys, 0, children.length()),
        children[children.length() - 1],
      )
      break
    }
    let parents : Array[Int32] = []
    let promoted : Array[Bytes] = []
    let groups = writer.branch_groups(children.length(), keys)
    for i, (start, end) in groups {
      let page = writer.allocate()
      writer.page(
        page,
        2,
        sqlite_branch_cells(children, keys, start, end),
        children[end - 1],
      )
      parents.push(page)
      if i + 1 < groups.length() {
        promoted.push(keys[end - 1])
      }
    }
    children = parents
    keys = promoted
  }
}

///|
fn sqlite_storage_rows(
  store : Store,
  tree : StorageTree,
) -> Array[StoredRow] raise SqlError {
  if tree.kind == "sequence" {
    let tables = store.tables.filter(t => {
      t.autoincrement &&
      t.sequence_present.unwrap_or(t.sequence > 0L || !t.rows.is_empty())
    })
    return tables.mapi((i, table) => {
      id: (i + 1).to_int64(),
      values: [Text(table.name), Integer(table.sequence)],
    })
  }
  get_table(store, tree.table).rows.copy()
}

///|
fn sqlite_export(
  store : Store,
  serial : Int32,
  plan : StoragePlan,
) -> Bytes raise {
  guard plan.format == "sqlite-template@1" && store.encoding.unwrap_or(1) == 1 else {
    fail("unsupported SQLite storage plan")
  }
  let template = @base64.decode(plan.image)
  let header = sqlite_header(template)
  guard header.page_size == plan.page_size &&
    header.usable == header.page_size &&
    header.encoding == 1 &&
    disk_cursor(template, 32, 40).word() == 0L &&
    disk_cursor(template, 36, 40).word() == 0L &&
    disk_cursor(template, 52, 56).word() == 0L else {
    fail(
      "SQLite template must be UTF-8 with no freelist, reserve or auto-vacuum",
    )
  }
  let writer : PageWriter = {
    size: header.page_size,
    pages: Array::makei(header.pages, page => {
      FixedArray::makei(header.page_size, i => {
        template[page * header.page_size + i]
      })
    }),
  }
  let roots : Map[Int32, Bool] = Map([])
  for tree in plan.trees {
    guard tree.root > 1 &&
      tree.root <= header.pages &&
      !roots.contains(tree.root) else {
      fail("invalid SQLite template root")
    }
    roots[tree.root] = true
    let rows = sqlite_storage_rows(store, tree)
    let rows = if tree.predicate is Some(predicate) {
      let table = get_table(store, tree.table)
      rows.filter(row => {
        truth(
          evaluate(
            predicate,
            evaluation(store, [], row_environment(table, row, table.name)),
          ),
        ) ==
        1
      })
    } else {
      rows
    }
    if tree.kind == "table" || tree.kind == "sequence" {
      rows.sort_by((a, b) => a.id.compare(b.id))
      let ipk = if tree.kind == "sequence" {
        -1
      } else {
        integer_primary(get_table(store, tree.table))
      }
      let records = rows.map(row => {
        let values = row.values.copy()
        if ipk >= 0 {
          values[ipk] = Null
        }
        let physical = if tree.kind == "table" {
          insert_columns(get_table(store, tree.table)).map(i => values[i])
        } else {
          values
        }
        (row.id, sqlite_record(physical))
      })
      writer.table(tree.root, records)
    } else if tree.kind == "index" || tree.kind == "without-rowid" {
      let table = get_table(store, tree.table)
      guard !tree.fields.is_empty() &&
        tree.fields.all(f => {
          f.column >= -2 &&
          f.column < table.columns.length() &&
          (f.column != -2 || f.expression is Some(_)) &&
          ["binary", "nocase", "rtrim"].contains(f.collation)
        }) else {
        fail("invalid SQLite index layout")
      }
      let values = rows.map(row => {
        tree.fields.map(field => {
          if field.column == -2 {
            guard field.expression is Some(e) else {
              fail("missing SQLite index expression")
            }
            evaluate(
              e,
              evaluation(store, [], row_environment(table, row, table.name)),
            )
          } else if field.column < 0 {
            Integer(row.id)
          } else {
            row.values[field.column]
          }
        })
      })
      values.sort_by((a, b) => {
        for i, field in tree.fields {
          let compare = compare_stored(store, a[i], b[i], field.collation)
          if compare != 0 {
            return if field.descending { -compare } else { compare }
          }
        }
        0
      })
      writer.index(tree.root, values.map(sqlite_record))
    } else {
      fail("unsupported SQLite storage tree")
    }
  }
  let first = writer.pages[0]
  let change = disk_cursor(template, 24, 28).word().reinterpret_as_uint64() +
    serial.to_uint64()
  sqlite_word(first, 24, change & 0xffffffffUL, 4)
  sqlite_word(first, 28, writer.pages.length().to_uint64(), 4)
  sqlite_word(first, 92, change & 0xffffffffUL, 4)
  // A non-native writer does not claim a SQLite library version identity.
  sqlite_word(first, 96, 0UL, 4)
  let output = @buffer.Buffer(size_hint=writer.pages.length() * writer.size)
  for page in writer.pages {
    output.write_bytes(Bytes::from_array(page[:])[:])
  }
  output.to_bytes()
}

///|
struct SqliteResult {
  data : Bytes
  info : String
}

///|
fn Connection::export_sqlite(
  connection : Connection,
) -> Bytes raise SqliteError {
  connection.healthy()
  guard connection.program is Some(program) && program.storage is Some(storage) else {
    raise sqlite_misuse("program has no prebuilt SQLite storage template")
  }
  sqlite_export(connection.database.store, connection.database.serial, storage) catch {
    error => raise interface_error(public_error(error))
  }
}

///|
fn aot_export_sqlite(db : AotDatabase) -> SqliteResult {
  try {
    let (connection, _) = db.ready()
    let bytes = connection.export_sqlite()
    {
      data: bytes,
      info: (
        { "bytes": bytes.length(), "serial": connection.database.serial } : Json).stringify(),
    }
  } catch {
    error =>
      {
        data: b"",
        info: ({ "error": public_error(error) } : Json).stringify(),
      }
  }
}

///|
fn sqlite_data(result : SqliteResult) -> Bytes {
  result.data
}

///|
fn sqlite_info(result : SqliteResult) -> String {
  result.info
}

///|
fn sqlite_data_base64(result : SqliteResult) -> String {
  @base64.encode(result.data)
}

// Source: storage_plan.mbt

///|
/// Generated at application build time from an empty native SQLite schema.
/// The runtime writes data pages without parsing DDL or deriving auto-index names.
#derive(Eq, ToJson)
priv struct IndexField {
  column : Int32
  collation : String
  descending : Bool
}

///|
priv struct StorageTree {
  name : String
  table : String
  root : Int32
  kind : String
  fields : Array[StorageField]
  predicate : Expr?
}

///|
priv struct StorageField {
  column : Int32
  collation : String
  descending : Bool
  expression : Expr?
}

///|
impl @json.ToJson for StorageField with fn to_json(self) {
  let json = @json.to_json(
    (
      {
        column: self.column,
        collation: self.collation,
        descending: self.descending,
      } : IndexField),
  )
  if self.expression is Some(e) && json is Object(fields) {
    fields["expression"] = @json.to_json(e)
  }
  json
}

///|
#derive(ToJson)
priv struct LegacyStorageTree {
  name : String
  table : String
  root : Int32
  kind : String
  fields : Array[StorageField]
}

///|
impl @json.ToJson for StorageTree with fn to_json(self) {
  let json = @json.to_json(
    (
      {
        name: self.name,
        table: self.table,
        root: self.root,
        kind: self.kind,
        fields: self.fields,
      } : LegacyStorageTree),
  )
  if self.predicate is Some(e) && json is Object(fields) {
    fields["predicate"] = @json.to_json(e)
  }
  json
}

///|
#derive(ToJson, FromJson)
priv struct StoragePlan {
  format : String
  page_size : Int32
  image : String
  trees : Array[StorageTree]
}

// Source: store_image.mbt

///|
/// Stable logical image. Execution caches are deliberately outside this contract.
#derive(ToJson, FromJson)
priv struct StoreImage {
  encoding : Int32?
  tables : Array[Table]
  objects : Array[SchemaObject]
  cookie : Int32
  changes : Int32
  last_rowid : Int64
  foreign_keys : Bool
  deferred : Bool
}

///|
impl @json.ToJson for Store with fn to_json(self) {
  let image : StoreImage = {
    encoding: self.encoding,
    tables: self.tables,
    objects: self.objects,
    cookie: self.cookie,
    changes: self.changes,
    last_rowid: self.last_rowid,
    foreign_keys: self.foreign_keys,
    deferred: self.deferred,
  }
  @json.to_json(image)
}

///|
impl @json.FromJson for Store with fn from_json(json, path) {
  let image : StoreImage = @json.from_json(json, path~)
  {
    encoding: image.encoding,
    tables: image.tables,
    objects: image.objects,
    cookie: image.cookie,
    changes: image.changes,
    last_rowid: image.last_rowid,
    foreign_keys: image.foreign_keys,
    deferred: image.deferred,
    indexes: Map([]),
    primary_indexes: Map([]),
    declaration_sources: Map([]),
    generated_plans: Map([]),
    dirty: dirty_state(),
    transactions: transaction_runtime(),
    triggers: trigger_runtime(),
  }
}

// Source: strict.mbt

///|
#derive(ToJson)
priv struct LegacyTable {
  name : String
  sql : String
  columns : Array[ColumnDef]
  unique_keys : Array[Array[Int32]]
  checks : Array[Expr]
  foreign_keys : Array[ForeignKey]
  without_rowid : Bool
  autoincrement : Bool
  sequence : Int64
  sequence_present : Bool?
  rows : RowPages
}

///|
impl @json.ToJson for Table with fn to_json(self) {
  let legacy : LegacyTable = {
    name: self.name,
    sql: self.sql,
    columns: self.columns,
    unique_keys: self.unique_keys,
    checks: self.checks,
    foreign_keys: self.foreign_keys,
    without_rowid: self.without_rowid,
    autoincrement: self.autoincrement,
    sequence: self.sequence,
    sequence_present: self.sequence_present,
    rows: if has_generated_columns(self) {
      row_pages(self.rows.map(row => persistent_generated_row(self, row)))
    } else {
      self.rows
    },
  }
  let json = @json.to_json(legacy)
  if self.strict is Some(value) && json is Object(fields) {
    fields["strict"] = @json.to_json(value)
  }
  json
}

///|
#derive(ToJson)
priv struct LegacySource {
  name : String
  qualifier : String
  left : Bool
  on : Expr
}

///|
impl @json.ToJson for Source with fn to_json(self) {
  let legacy : LegacySource = {
    name: self.name,
    qualifier: self.qualifier,
    left: self.left,
    on: self.on,
  }
  let json = @json.to_json(legacy)
  if self.right is Some(value) && json is Object(fields) {
    fields["right"] = @json.to_json(value)
  }
  if self.using_columns is Some(value) && json is Object(fields) {
    fields["using_columns"] = @json.to_json(value)
  }
  if self.natural is Some(value) && json is Object(fields) {
    fields["natural"] = @json.to_json(value)
  }
  json
}

///|
fn validate_strict_columns(columns : Array[ColumnDef]) -> Unit raise SqlError {
  guard FEATURE_STRICT else { fail("feature disabled: strictTables") }
  for col in columns {
    guard ["INT", "INTEGER", "REAL", "TEXT", "BLOB", "ANY"].contains(
      col.declared,
    ) else {
      fail("unknown datatype for STRICT column: " + col.name)
    }
  }
}

///|
fn column_affinity(table : Table, col : ColumnDef) -> String {
  if FEATURE_STRICT && table.strict == Some(true) && col.declared == "ANY" {
    "blob"
  } else {
    affinity_name(col.declared)
  }
}

///|
fn check_strict_values(
  table : Table,
  values : Array[Value],
) -> Unit raise SqlError {
  guard FEATURE_STRICT else { fail("feature disabled: strictTables") }
  for i, col in table.columns {
    let valid = match values[i] {
      Null => true
      Integer(_) => ["INT", "INTEGER", "REAL", "ANY"].contains(col.declared)
      Real(_) => ["REAL", "ANY"].contains(col.declared)
      Text(_) => ["TEXT", "ANY"].contains(col.declared)
      Blob(_) => ["BLOB", "ANY"].contains(col.declared)
    }
    guard valid else {
      fail("datatype constraint failed: " + table.name + "." + col.name)
    }
  }
}

///|
#derive(ToJson)
priv struct LegacyColumnDef {
  name : String
  declared : String
  not_null : Bool
  primary : Int32
  default_value : Expr
  collation : String
}

///|
impl @json.ToJson for ColumnDef with fn to_json(self) {
  let legacy : LegacyColumnDef = {
    name: self.name,
    declared: self.declared,
    not_null: self.not_null,
    primary: self.primary,
    default_value: self.default_value,
    collation: self.collation,
  }
  let json = @json.to_json(legacy)
  if self.default_source is Some(value) && json is Object(fields) {
    fields["default_source"] = @json.to_json(value)
  }
  if self.primary_desc is Some(value) && json is Object(fields) {
    fields["primary_desc"] = @json.to_json(value)
  }
  json
}

// Source: transaction.mbt

///|
priv struct TransactionFrame {
  name : String
  store : Store
}

///|
priv struct TransactionRuntime {
  frames : Array[TransactionFrame]
  mut explicit : Bool
}

///|
fn transaction_runtime() -> TransactionRuntime {
  { frames: [], explicit: false, }
}

///|
pub fn database_autocommit(db : Database) -> Bool {
  db.store.transactions.frames.is_empty()
}

///|
/// Rollback restores schema/data/dirty edits, retaining connection-local counters.
fn restore_transaction(store : Store, state : Store) -> Unit {
  let copy = copy_store(state)
  store.tables.clear()
  for table in copy.tables {
    store.tables.push(table)
  }
  store.objects.clear()
  for object in copy.objects {
    store.objects.push(object)
  }
  store.cookie = copy.cookie
  store.encoding = copy.encoding
  store.dirty = copy.dirty
  store.indexes.clear()
  store.primary_indexes.clear()
}

///|
fn execute_transaction(
  store : Store,
  op : String,
  name : String,
) -> Array[Environment] raise SqlError {
  guard store.triggers.active.is_empty() else {
    fail("transaction control inside trigger")
  }
  let tx = store.transactions
  if op == "begin" || op == "savepoint" {
    if op == "begin" {
      guard tx.frames.is_empty() else {
        fail("cannot start a transaction within a transaction")
      }
    }
    guard tx.frames.length() < 1000 else { fail("savepoint resource limit") }
    let saved = copy_store(store)
    if tx.frames.is_empty() {
      tx.explicit = op == "begin"
    }
    tx.frames.push({
      name: if op == "begin" {
        ""
      } else {
        identifier(name)
      },
      store: saved,
    })
  } else if op == "commit" || op == "rollback" {
    guard !tx.frames.is_empty() else {
      fail("cannot " + op + " - no transaction is active")
    }
    if op == "commit" {
      validate_foreign_keys(store)
    } else {
      restore_transaction(store, tx.frames[0].store)
    }
    tx.frames.clear()
    tx.explicit = false
    store.deferred = false
  } else {
    let mut index = tx.frames.length() - 1
    while index >= 0 && tx.frames[index].name != identifier(name) {
      index -= 1
    }
    guard index >= 0 else { fail("no such savepoint: " + name) }
    if op == "rollback to" {
      restore_transaction(store, tx.frames[index].store)
      while tx.frames.length() > index + 1 {
        ignore(tx.frames.pop())
      }
    } else {
      if index == 0 && !tx.explicit {
        validate_foreign_keys(store)
      }
      while tx.frames.length() > index {
        ignore(tx.frames.pop())
      }
      if tx.frames.is_empty() {
        store.deferred = false
        tx.explicit = false
      }
    }
  }
  []
}

// Source: trigger.mbt

///|
#derive(ToJson)
priv struct TriggerDefinition {
  timing : String
  event : String
  columns : Array[String]
  condition : Expr
  body : Array[DataStatement]
}

///|
/// Connection-local execution frames, never serialized or shared with a clone.
priv struct TriggerRuntime {
  mut clock : Int64?
  mut row : Environment
  active : Array[String]
  mut recursive : Bool
  mut prior_changes : Int32
  mut data_depth : Int32
  mut failed_statement : Bool
  mut conflict_override : String?
}

///|
fn trigger_runtime() -> TriggerRuntime {
  {
    clock: None,
    row: [],
    active: [],
    recursive: false,
    prior_changes: 0,
    data_depth: 0,
    failed_statement: false,
    conflict_override: None,
  }
}

///|
fn connection_changes(store : Store) -> Int32 {
  if store.triggers.failed_statement {
    0
  } else {
    store.changes
  }
}

///|
fn trigger_raise_action(args : Array[Expr]) -> String raise SqlError {
  guard !args.is_empty() && args[0] is Column("", name) else {
    fail("unsupported RAISE() action")
  }
  let name = identifier(name)
  guard (name == "ignore" && args.length() == 1) ||
    (name == "abort" && args.length() == 2) else {
    fail("unsupported RAISE() action")
  }
  name
}

///|
fn trigger_environment(
  table : Table,
  event : String,
  before : StoredRow?,
  after : StoredRow?,
) -> Environment {
  let mut env : Environment = []
  if event != "insert" && before is Some(row) {
    env = env + row_environment(table, row, "old")
  }
  if event != "delete" && after is Some(row) {
    env = env + row_environment(table, row, "new")
  }
  env
}

///|
fn trigger_applies(
  trigger : TriggerDefinition,
  event : String,
  columns : Array[String],
) -> Bool {
  trigger.event == event &&
  (
    trigger.columns.is_empty() ||
    trigger.columns.any(c => columns.any(n => identifier(c) == identifier(n)))
  )
}

///|
fn validate_trigger_metadata(
  table : Table,
  object : SchemaObject,
) -> Unit raise SqlError {
  guard FEATURE_TRIGGERS else { fail("feature disabled: triggers") }
  validate_optional_features(object)
  guard object.trigger is Some(t) &&
    ["before", "after"].contains(t.timing) &&
    ["insert", "update", "delete"].contains(t.event) &&
    !t.body.is_empty() &&
    t.body.length() <= 1000 &&
    (t.event == "update" || t.columns.is_empty()) &&
    (t.timing != "before" || t.body.all(data_readonly)) &&
    identifier(object.table) == identifier(table.name) else {
    fail("invalid or unsupported trigger definition")
  }
}

///|
fn prepare_trigger(
  store : Store,
  table : Table,
  object : SchemaObject,
) -> Unit raise SqlError {
  guard FEATURE_TRIGGERS else { fail("feature disabled: triggers") }
  validate_trigger_metadata(table, object)
  guard object.trigger is Some(t) else { fail("missing trigger definition") }
  let row = { id: 0L, values: Array::make(table.columns.length(), Null), }
  let old = store.triggers.row
  store.triggers.row = trigger_environment(table, t.event, Some(row), Some(row))
  store.triggers.active.push(identifier(object.name))
  defer {
    store.triggers.row = old
    ignore(store.triggers.active.pop())
  }
  prepare_expression(t.condition, evaluation(store, [], []), false, false)
  for statement in t.body {
    ignore(prepared_names(store, statement, 0))
  }
}

///|
fn prepare_trigger_event(
  store : Store,
  table : Table,
  event : String,
  columns : Array[String],
) -> Unit raise SqlError {
  if !FEATURE_TRIGGERS {
    return
  }
  for object in store.objects {
    if object.kind == "trigger" &&
      matches_identifier(object.table, identifier(table.name)) &&
      object.trigger is Some(t) &&
      trigger_applies(t, event, columns) {
      prepare_trigger(store, table, object)
    }
  }
}

///|
fn fire_trigger(
  store : Store,
  table : Table,
  object : SchemaObject,
  before : StoredRow?,
  after : StoredRow?,
) -> Bool raise SqlError {
  guard object.trigger is Some(t) else { fail("missing trigger definition") }
  guard store.triggers.active.length() < 32 else {
    fail("too many levels of trigger recursion")
  }
  let env = store.triggers.row
  let changes = store.changes
  let rowid = store.last_rowid
  store.triggers.row = trigger_environment(table, t.event, before, after)
  store.triggers.active.push(identifier(object.name))
  store.changes = store.triggers.prior_changes
  defer {
    store.triggers.row = env
    ignore(store.triggers.active.pop())
    store.changes = changes
    store.last_rowid = rowid
  }
  try {
    if truth(evaluate(t.condition, evaluation(store, [], []))) != 1 {
      return true
    }
    for statement in t.body {
      ignore(execute_data_statement(store, statement, []))
    }
    true
  } catch {
    TriggerIgnore => false
    TriggerAbort(message) => raise TriggerAbort(message)
    SqlError(message) => fail(message)
  }
}

///|
#derive(ToJson)
priv struct LegacyInsertion {
  table : String
  columns : Array[String]
  values : Array[Array[Expr]]
  conflict : String
  target : Array[String]
  updates : Array[(String, Expr)]
  predicate : Expr
  returning : Array[Projection]
}

///|
impl @json.ToJson for Insertion with fn to_json(self) {
  let json = @json.to_json(
    (
      {
        table: self.table,
        columns: self.columns,
        values: self.values,
        conflict: self.conflict,
        target: self.target,
        updates: self.updates,
        predicate: self.predicate,
        returning: self.returning,
      } : LegacyInsertion),
  )
  if json is Object(fields) {
    if self.conflict_override is Some(value) {
      fields["conflict_override"] = @json.to_json(value)
    }
    if self.selection is Some(value) {
      fields["selection"] = @json.to_json(value)
    }
    if self.target_predicate is Some(value) {
      fields["target_predicate"] = @json.to_json(value)
    }
  }
  json
}

///|
fn run_triggers(
  store : Store,
  table : Table,
  timing : String,
  event : String,
  columns : Array[String],
  before : StoredRow?,
  after : StoredRow?,
) -> Bool raise SqlError {
  if !FEATURE_TRIGGERS {
    return true
  }
  let triggers = store.objects.filter(o => {
    o.kind == "trigger" && matches_identifier(o.table, identifier(table.name))
  })
  for i in 0..<triggers.length() {
    let object = triggers[triggers.length() - 1 - i]
    if object.trigger is Some(t) &&
      t.timing == timing &&
      trigger_applies(t, event, columns) &&
      (
        store.triggers.recursive ||
        !store.triggers.active.contains(identifier(object.name))
      ) {
      if !fire_trigger(store, table, object, before, after) {
        return false
      }
    }
  }
  true
}

// Source: update.mbt

///|
fn execute_update(
  store : Store,
  name : String,
  setters : Array[(String, Expr)],
  predicate : Expr,
  returning : Array[Projection],
  params : Array[Value],
  prepared_update : PreparedUpdatePlan?,
) -> Array[Environment] raise SqlError {
  guard CAP_STATEMENT_UPDATE else {
    fail("catalog capability disabled: update")
  }
  let table = match prepared_update {
    Some(plan) => store.tables[plan.table_slot]
    None => get_table(store, name)
  }
  prepare_foreign_table(store, table)
  let columns = match prepared_update {
    Some(plan) => plan.columns
    None => setters.map(p => p.0)
  }
  prepare_trigger_event(store, table, "update", columns)
  let with_triggers = store.objects.any(o => {
    o.kind == "trigger" && matches_identifier(o.table, identifier(table.name))
  })
  let rows : Array[Environment] = []
  store.changes = 0
  let template = match prepared_update {
    Some(plan) => plan.layout
    None => {
      let template = row_environment(
        table,
        { id: 0L, values: Array::make(table.columns.length(), Null), },
        table.name,
      )
      let context = evaluation(store, params, template)
      prepare_expression(predicate, context, false, false)
      prepare_returning(returning, context)
      for (n, e) in setters {
        ignore(writable_column(table, n))
        prepare_expression(e, context, false, false)
      }
      template
    }
  }
  let candidates = match prepared_update {
    Some(plan) => bound_candidates(plan.access, store, table, params)
    None =>
      primary_candidates(store, table, predicate, params, name).unwrap_or_else(() => {
        candidate_rows(
          store,
          table,
          rowid_equality(table, predicate, params, name),
        )
      })
  }
  let in_lists = in_list_frames(
    match prepared_update {
      Some(plan) => plan.in_lists
      None =>
        statement_in_lists(
          [predicate] + setters.map(p => p.1) + returning.map(p => p.expression),
          evaluation(store, params, template),
        )
    },
  )
  for candidate in candidates {
    let row = if with_triggers {
      guard table_row_by_id(store, table, candidate.id) is Some(current) else {
        continue
      }
      current
    } else {
      candidate
    }
    let input : BoundInput = {
      store,
      params,
      row,
      layout: template,
      context: None,
      joined: None,
      in_lists,
    }
    let matches = match prepared_update {
      Some(plan) => evaluate_bound(plan.predicate, input)
      None => evaluate(predicate, input.environment())
    }
    if truth(matches) != 1 {
      continue
    }
    let next = match prepared_update {
      Some(plan) => updated_row_from_plan(plan, row, input)
      None =>
        updated_row(
          store,
          table,
          row,
          setters,
          [],
          params,
          generated=false,
          in_lists~,
        )
    }
    if apply_update_row(
        store,
        table,
        row,
        next,
        columns,
        params,
        returning,
        template,
        prepared_update.map(p => p.returning),
        with_triggers,
        in_lists~,
      )
      is Some(result) {
      rows.push(result)
    }
  }
  rows
}

// Source: update_from.mbt

///|
/// Derived fixed-schema metadata only. Bindings, joined rows and SET values are
/// owned by each execution, never retained by an AOT/SQL prepared statement.
priv struct PreparedUpdateFromPlan {
  source : Selection
  target_layout : Environment
  setters : Array[UpdateFromSetter]
  lookup : UpdateFromLookup?
  slots : UpdateFromSlots?
  in_lists : Array[PreparedInList]
}

///|
priv struct UpdateFromSlots {
  layout : Environment
  columns : Array[BoundRowSlot]
  target : BoundExpression
  predicate : BoundExpression
  setters : Array[BoundExpression]
}

///|
priv struct UpdateFromSetter {
  target_column : Int32
  target_affinity : String
  expression : Expr
}

///|
priv struct UpdateFromLookup {
  table_slot : Int32
  qualifier : String
  target : Expr
}

///|
priv struct PendingFromUpdate {
  target_id : Int64
  original_key : String?
  assignments : Array[Value]
}

///|
fn update_from_expression(e : Expr) -> Bool {
  e is Call("$update-from", _)
}

///|
fn prepare_update_from(
  store : Store,
  table : Table,
  layout : Environment,
  setters : Array[(String, Expr)],
  predicate : Expr,
  returning : Array[Projection],
  parameters : Int32,
) -> (PreparedUpdatePlan, Array[String]) raise SqlError {
  guard FEATURE_UPDATE_FROM else { fail("feature disabled: updateFrom") }
  guard store.triggers.active.is_empty() else {
    fail("unsupported UPDATE FROM in trigger body")
  }
  guard predicate
    is Call("$update-from", [Literal(Text(qualifier)), ScalarSelect(source)]) &&
    qualifier != "" &&
    source.projections.is_empty() &&
    source.groups.is_empty() &&
    source.having is Literal(Integer(1L)) &&
    source.orders.is_empty() &&
    source.limit is Literal(Integer(-1L)) &&
    source.offset is Literal(Integer(0L)) &&
    !source.distinct &&
    source.compound is None &&
    source.recursive is None &&
    source.cte_names is None else {
    fail("invalid UPDATE FROM metadata")
  }
  let scopes : Map[String, Bool] = Map([(identifier(qualifier), true)])
  for i, s in source.sources {
    let name = identifier(s.qualifier)
    guard !scopes.contains(name) else {
      fail("unsupported UPDATE FROM duplicate target/source alias")
    }
    scopes[name] = true
    if i == 0 {
      let condition = if FEATURE_JSON_TABLE && json_table_source(s) {
        let (_, _, _, condition) = json_table_parts(s)
        condition
      } else {
        s.on
      }
      guard !s.left &&
        s.right != Some(true) &&
        s.natural != Some(true) &&
        s.using_columns is None &&
        condition is Literal(Integer(1L)) else {
        fail("invalid leading UPDATE FROM source")
      }
    }
  }
  let params : Array[Value] = Array::make(parameters, Null)
  let source_layout = selection_template(
    source,
    evaluation(store, params, []),
    source_only=true,
  )
  let target_layout = layout.map(b => { ..b, qualifier, })
  let joined = evaluation(store, params, target_layout + source_layout)
  prepare_expression(source.predicate, joined, false, false)
  let resolved = setters.map(p => {
    let column = writable_column(table, p.0)
    prepare_expression(p.1, joined, false, false)
    {
      target_column: column,
      target_affinity: column_affinity(table, table.columns[column]),
      expression: p.1,
    }
  })
  for p in returning {
    guard !(p.expression is Star(q) && q != "") else {
      fail("RETURNING may not use TABLE.* wildcards")
    }
  }
  let target_context = evaluation(store, params, layout)
  prepare_returning(returning, target_context)
  let result = bind_projection(returning, target_context)
  let lookup = update_from_lookup(
    store,
    source,
    target_layout,
    source_layout,
    source.predicate,
  )
  let slots = if OPT_UPDATE_FROM_LOOKUP && lookup is Some(lookup) {
    Some(
      prepare_update_from_slots(
        lookup,
        store,
        params,
        target_layout,
        source_layout,
        source.predicate,
        setters,
      ),
    )
  } else {
    None
  }
  let in_lists = statement_in_lists(
    [source.predicate] + setters.map(p => p.1),
    joined,
  )
  let returning_in_lists = statement_in_lists(
    returning.map(p => p.expression),
    target_context,
  )
  let plan = {
    table_slot: prepared_table_slot(store, table),
    layout,
    columns: setters.map(p => p.0),
    setters: [],
    integer_primary: integer_primary(table),
    predicate: BoundLiteral(Integer(1L)),
    access: BoundScan,
    returning: result,
    in_lists: returning_in_lists,
    from_plan: Some({
      source,
      target_layout,
      setters: resolved,
      lookup,
      slots,
      in_lists,
    }),
  }
  (plan, result.output.map(b => b.name))
}

///|
/// A source physical rowid/IPK equality is unique and can use the existing ordered
/// rowid cache. Other joins retain a bounded snapshot scan and full predicate.
fn update_from_lookup(
  store : Store,
  source : Selection,
  target_layout : Environment,
  source_layout : Environment,
  predicate : Expr,
) -> UpdateFromLookup? raise SqlError {
  guard OPT_UPDATE_FROM_LOOKUP &&
    source.ctes.is_empty() &&
    source.sources.length() == 1 else {
    return None
  }
  let s = source.sources[0]
  let slot = store.tables.search_by(t => {
    matches_identifier(t.name, identifier(s.name))
  })
  guard slot is Some(slot) && !store.tables[slot].without_rowid else {
    return None
  }
  let table = store.tables[slot]
  if predicate is Binary("and", a, b) {
    if update_from_lookup(store, source, target_layout, source_layout, a)
      is Some(lookup) {
      return Some(lookup)
    }
    return update_from_lookup(store, source, target_layout, source_layout, b)
  }
  guard predicate is Binary(op, left, right) && (op == "=" || op == "==") else {
    return None
  }
  for (rhs, target) in [(left, right), (right, left)] {
    guard rhs is Column(rq, rn) && target is Column(tq, tn) else { continue }
    guard find_binding(source_layout, rq, rn) is Some(_) &&
      find_binding(target_layout, tq, tn) is Some(_) else {
      continue
    }
    guard index_column(table, rhs, s.qualifier) is Some(column) &&
      (
        column == -1 ||
        (integer_primary(table) >= 0 && column == integer_primary(table))
      ) else {
      continue
    }
    return Some({ table_slot: slot, qualifier: s.qualifier, target, })
  }
  None
}

///|
fn update_from_source_rows(
  store : Store,
  params : Array[Value],
  lookup : UpdateFromLookup,
  rows : IndexRows,
  target : Environment,
) -> Array[Environment] raise SqlError {
  guard bound_rowid(evaluate(lookup.target, evaluation(store, params, target)))
    is Some(id) else {
    return []
  }
  match update_from_source_row(store, rows, id) {
    Some(row) =>
      [row_environment(store.tables[lookup.table_slot], row, lookup.qualifier)]
    None => []
  }
}

///|
fn update_from_source_row(
  store : Store,
  rows : IndexRows,
  id : Int64,
) -> StoredRow? raise SqlError {
  let at = index_prefix_bound(
    store,
    rows,
    [{ column: -1, collation: "binary", descending: false, }],
    [Integer(id)],
    false,
  )
  guard at < rows.length() && rows[at].id == id else { return None }
  Some(rows[at])
}

///|
fn execute_update_from(
  store : Store,
  plan : PreparedUpdatePlan,
  params : Array[Value],
  returning : Array[Projection],
) -> Array[Environment] raise SqlError {
  guard FEATURE_UPDATE_FROM && plan.from_plan is Some(from) else {
    fail("invalid UPDATE FROM plan")
  }
  guard store.triggers.active.is_empty() else {
    fail("unsupported UPDATE FROM in trigger body")
  }
  let table = store.tables[plan.table_slot]
  prepare_foreign_table(store, table)
  prepare_trigger_event(store, table, "update", plan.columns)
  let with_triggers = store.objects.any(o => {
    o.kind == "trigger" && matches_identifier(o.table, identifier(table.name))
  })
  store.changes = 0
  let budget = in_cache_budget()
  let in_lists = in_list_frames(from.in_lists, budget~)
  let returning_in_lists = in_list_frames(plan.in_lists, budget~)
  let context = { ..evaluation(store, params, []), in_lists, }
  let lookup_rows = match from.lookup {
    Some(lookup) =>
      Some(ordered_rowid_rows(store, store.tables[lookup.table_slot]))
    None => None
  }
  let sources = if lookup_rows is None {
    select_relation_in(from.source, context, false, source_only=true).rows
  } else {
    []
  }
  let targets = table.rows.copy()
  if table.without_rowid {
    let fields = primary_key(table).map(i => {
      column: i,
      collation: table.columns[i].collation,
      descending: table.columns[i].primary_desc.unwrap_or(false),
    })
    targets.sort_by((a, b) => compare_index_rows(store, fields, a, b))
  } else {
    targets.sort_by((a, b) => a.id.compare(b.id))
  }
  let pending : Array[PendingFromUpdate] = []
  let mut visits = 0
  for previous in targets {
    if OPT_UPDATE_FROM_LOOKUP &&
      from.slots is Some(slots) &&
      from.lookup is Some(_) &&
      lookup_rows is Some(source_rows) {
      let target_input : BoundInput = {
        store,
        params,
        row: previous,
        layout: from.target_layout,
        context: None,
        in_lists,
        joined: None,
      }
      let id = bound_rowid(evaluate_bound(slots.target, target_input))
      if id is Some(id) {
        if update_from_source_row(store, source_rows, id) is Some(source) {
          let input : BoundInput = {
            store,
            params,
            row: previous,
            layout: slots.layout,
            context: None,
            in_lists,
            joined: Some({ source, slots: slots.columns, }),
          }
          if truth(evaluate_bound(slots.predicate, input)) == 1 {
            pending.push({
              target_id: previous.id,
              original_key: if table.without_rowid {
                primary_value_key(table, previous.values)
              } else {
                None
              },
              assignments: slots.setters.map(e => evaluate_bound(e, input)),
            })
          }
        }
      }
      continue
    }
    let target = row_environment_from(from.target_layout, previous)
    let source_rows = match (from.lookup, lookup_rows) {
      (Some(lookup), Some(rows)) =>
        update_from_source_rows(store, params, lookup, rows, target)
      _ => sources
    }
    let mut matched : Environment? = None
    for row in source_rows {
      visits += 1
      guard visits <= 1000000 else { fail("UPDATE FROM join resource limit") }
      let joined = target + row
      if truth(evaluate(from.source.predicate, { ..context, row: joined, })) !=
        1 {
        continue
      }
      guard matched is None else {
        fail("unsupported UPDATE FROM: multiple source rows match target row")
      }
      matched = Some(joined)
    }
    if matched is Some(row) {
      pending.push({
        target_id: previous.id,
        original_key: if table.without_rowid {
          primary_value_key(table, previous.values)
        } else {
          None
        },
        assignments: from.setters.map(s => {
          evaluate(s.expression, { ..context, row, })
        }),
      })
    }
  }
  let output : Array[Environment] = []
  for update in pending {
    // SQLite's temporary update table is keyed by the original physical key.
    // WITHOUT ROWID keys may move or be deleted/reinserted by an earlier trigger.
    let current = match update.original_key {
      Some(key) =>
        if FEATURE_PRIMARY_INDEX {
          primary_key_row(primary_index(store, table), table, key)
        } else {
          table.rows
          .iter()
          .find_first(row => primary_value_key(table, row.values) == Some(key))
        }
      None => table_row_by_id(store, table, update.target_id)
    }
    guard current is Some(previous) else { continue }
    let values = previous.values.copy()
    for i, setter in from.setters {
      values[setter.target_column] = apply_affinity(
        update.assignments[i],
        setter.target_affinity,
      )
    }
    let next = finish_updated_row(previous, values, plan.integer_primary)
    if apply_update_row(
        store,
        table,
        previous,
        next,
        plan.columns,
        params,
        returning,
        plan.layout,
        Some(plan.returning),
        with_triggers,
        in_lists=returning_in_lists,
      )
      is Some(row) {
      output.push(row)
    }
  }
  output
}

///|
fn prepare_update_from_slots(
  lookup : UpdateFromLookup,
  store : Store,
  params : Array[Value],
  target_layout : Environment,
  source_layout : Environment,
  predicate : Expr,
  setters : Array[(String, Expr)],
) -> UpdateFromSlots raise SqlError {
  let columns = target_layout.mapi((i, b) => {
      if b.hidden {
        TargetRowid
      } else {
        TargetSlot(i)
      }
    }) +
    source_layout.mapi((i, b) => {
      if b.hidden {
        SourceRowid
      } else {
        SourceSlot(i)
      }
    })
  let layout = (target_layout + source_layout).map(b => { ..b, hidden: false, })
  let context = evaluation(store, params, layout)
  {
    layout,
    columns,
    target: bind_expression(
      lookup.target,
      evaluation(store, params, target_layout),
    ),
    predicate: bind_expression(predicate, context),
    setters: setters.map(p => bind_expression(p.1, context)),
  }
}

// Source: update_row.mbt

///|
/// One write contract for ordinary UPDATE and materialized UPDATE FROM. The
/// caller owns matching/SET evaluation; triggers, constraints, FK and output stay
/// in their original order, under the statement's existing rollback boundary.
fn apply_update_row(
  store : Store,
  table : Table,
  previous : StoredRow,
  next : StoredRow,
  columns : Array[String],
  params : Array[Value],
  returning : Array[Projection],
  layout : Environment,
  prepared_returning : BoundProjection?,
  with_triggers : Bool,
  in_lists~ : Array[InListFrame] = [],
) -> Environment? raise SqlError {
  let next = generated_row(store, table, next)
  if with_triggers &&
    !run_triggers(
      store,
      table,
      "before",
      "update",
      columns,
      Some(previous),
      Some(next),
    ) {
    return None
  }
  if !check_updated_row(
      store,
      table,
      previous,
      next,
      params,
      policy=store.triggers.conflict_override,
    ) {
    return None
  }
  foreign_restrict(store, table, previous, Some(next))
  replace_table_row(store, table, previous, next)
  foreign_actions(store, table, previous, Some(next), 0)
  store.changes += 1
  let output = if returning.is_empty() {
    None
  } else {
    Some(
      match prepared_returning {
        Some(plan) =>
          project_bound(plan, {
            store,
            params,
            row: next,
            layout,
            context: None,
            joined: None,
            in_lists,
          })
        None =>
          project(returning, {
            ..evaluation(store, params, row_environment_from(layout, next)),
            in_lists,
          })
      },
    )
  }
  if with_triggers {
    ignore(
      run_triggers(
        store,
        table,
        "after",
        "update",
        columns,
        Some(previous),
        Some(next),
      ),
    )
  }
  output
}

// Source: value.mbt

///|
/// SQL decimal grammar only. Generic language parsers also accept hex, octal,
/// binary and separators, which are not numeric TEXT in SQLite.
fn decimal_end(bytes : Bytes, start : Int32) -> (Int32, Bool) {
  let mut i = start
  if i < bytes.length() && (bytes[i] == b'+' || bytes[i] == b'-') {
    i += 1
  }
  let first = i
  while i < bytes.length() && bytes[i] >= b'0' && bytes[i] <= b'9' {
    i += 1
  }
  let mut digits = i - first
  let mut real = false
  if i < bytes.length() && bytes[i] == b'.' {
    real = true
    i += 1
    let first = i
    while i < bytes.length() && bytes[i] >= b'0' && bytes[i] <= b'9' {
      i += 1
    }
    digits += i - first
  }
  if digits == 0 {
    return (start, false)
  }
  if i < bytes.length() && (bytes[i] == b'e' || bytes[i] == b'E') {
    let exponent = i
    i += 1
    if i < bytes.length() && (bytes[i] == b'+' || bytes[i] == b'-') {
      i += 1
    }
    let first = i
    while i < bytes.length() && bytes[i] >= b'0' && bytes[i] <= b'9' {
      i += 1
    }
    if first == i {
      i = exponent
    } else {
      real = true
    }
  }
  (i, real)
}

///|
fn parse_number(text : String) -> Value raise SqlError {
  let bytes = @utf8.encode(text)
  let (end, real) = decimal_end(bytes, 0)
  guard end > 0 && end == bytes.length() else {
    fail("invalid SQL number: " + text)
  }
  if !real {
    return Integer(@string.parse_int64(text)) catch {
      _ => Real(decimal_double(text))
    }
  }
  Real(decimal_double(text))
}

///|
fn numeric(value : Value, strict : Bool) -> Value {
  match value {
    Text(s) => {
      let s = s.trim(chars=" \t\n\r\u{b}\u{c}").to_owned()
      let bytes = @utf8.encode(s)
      let (end, _) = decimal_end(bytes, 0)
      if strict {
        if end == 0 || end != bytes.length() {
          return value
        }
        parse_number(s) catch {
          _ => value
        }
      } else {
        if end == 0 {
          return Integer(0L)
        }
        let parsed = parse_number(@utf8.decode_lossy(bytes[0:end])) catch {
          _ => Integer(0L)
        }
        // SQLite's integer fast parse rejects embedded NUL; atof still reads
        // its prefix, yielding REAL for this input rather than INTEGER.
        if parsed is Integer(n) && bytes.to_array().contains(b'\x00') {
          Real(n.to_double())
        } else {
          parsed
        }
      }
    }
    Blob(b) =>
      if strict {
        value
      } else {
        numeric(Text(@utf8.decode_lossy(b)), false)
      }
    _ => value
  }
}

///|
fn nocase_prefix(value : String) -> String {
  let chars : Array[Char] = []
  for c in value.iter() {
    if c == '\u{0}' {
      break
    }
    chars.push(c)
  }
  identifier(String::from_iter(chars.iter()))
}

///|
fn nocase_compare(a : String, b : String) -> Int32 {
  let x = @utf8.encode(identifier(a))
  let y = @utf8.encode(identifier(b))
  for i in 0..<x.length().min(y.length()) {
    let c = x[i].compare(y[i])
    if c != 0 {
      return c
    }
    if x[i] == b'\x00' {
      break
    }
  }
  x.length().compare(y.length())
}

///|
fn affinity_name(declared : String) -> String {
  let t = declared.to_upper()
  if t.contains("INT") {
    "integer"
  } else if t.contains("CHAR") || t.contains("CLOB") || t.contains("TEXT") {
    "text"
  } else if t.contains("BLOB") || t == "" {
    "blob"
  } else if t.contains("REAL") || t.contains("FLOA") || t.contains("DOUB") {
    "real"
  } else {
    "numeric"
  }
}

///|
fn text_value(value : Value) -> String {
  match value {
    Null => ""
    Integer(n) => n.to_string()
    Real(n) => sqlite_real_text(n)
    Text(s) => s
    Blob(b) => @utf8.decode_lossy(b)
  }
}

///|
fn apply_affinity(value : Value, affinity : String) -> Value {
  if affinity == "text" {
    match value {
      Integer(_) | Real(_) => Text(text_value(value))
      _ => value
    }
  } else if affinity == "integer" || affinity == "numeric" || affinity == "real" {
    let value = numeric(value, true)
    match value {
      Integer(n) => if affinity == "real" { Real(n.to_double()) } else { value }
      Real(n) =>
        // REAL column affinity uses SQLite's integer-backed zero storage. This
        // is distinct from CAST / untyped REAL values, which retain -0.
        if affinity == "real" && n == 0.0 {
          Real(0.0)
        } else if affinity != "real" &&
          n >= -9223372036854775808.0 &&
          n < 9223372036854775808.0 &&
          n.to_int64().to_double() == n {
          Integer(n.to_int64())
        } else {
          value
        }
      _ => value
    }
  } else {
    value
  }
}

///|
/// SQLite 3.53/3.54 IN SELECT compares with one common affinity on both
/// operands. Unlike a scalar expression-list IN, one REAL affinity is retained.
fn in_comparison_affinity(left : String, right : String) -> String {
  if left != "" && right != "" {
    if ["integer", "numeric", "real"].contains(left) ||
      ["integer", "numeric", "real"].contains(right) {
      "numeric"
    } else {
      ""
    }
  } else if left == "" {
    right
  } else {
    left
  }
}

///|
/// -1 = unknown, 0 = false, 1 = true.
fn truth(value : Value) -> Int32 {
  match numeric(value, false) {
    Null => -1
    Integer(n) => if n == 0L { 0 } else { 1 }
    Real(n) => if n == 0.0 { 0 } else { 1 }
    _ => 0
  }
}

///|
fn boolean(value : Bool) -> Value {
  Integer(if value { 1L } else { 0L })
}

///|
fn bytes_compare(a : Bytes, b : Bytes) -> Int32 {
  for i = 0; i < a.length().min(b.length()); i = i + 1 {
    if a[i] < b[i] {
      return -1
    }
    if a[i] > b[i] {
      return 1
    }
  }
  a.length().compare(b.length())
}

///|
/// Avoid rounding an Int64 to Double before comparison at the 2^53/2^63 edges.
fn integer_real_compare(i : Int64, r : Double) -> Int32 {
  if r >= 9223372036854775808.0 {
    -1
  } else if r < -9223372036854775808.0 {
    1
  } else {
    let truncated = r.to_int64()
    let c = i.compare(truncated)
    if c != 0 {
      c
    } else {
      i.to_double().compare(r)
    }
  }
}

///|
fn compare_value(a : Value, b : Value, collation : String) -> Int32 {
  fn rank(v : Value) -> Int32 {
    match v {
      Null => 0
      Integer(_) | Real(_) => 1
      Text(_) => 2
      Blob(_) => 3
    }
  }
  match (a, b) {
    (Integer(a), Integer(b)) => a.compare(b)
    (Real(a), Real(b)) => a.compare(b)
    (Integer(a), Real(b)) => integer_real_compare(a, b)
    (Real(a), Integer(b)) => -integer_real_compare(b, a)
    (Text(a), Text(b)) => {
      if collation == "nocase" {
        return nocase_compare(a, b)
      }
      let a = if collation == "rtrim" {
        a.trim_end(chars=" ").to_owned()
      } else {
        a
      }
      let b = if collation == "rtrim" {
        b.trim_end(chars=" ").to_owned()
      } else {
        b
      }
      bytes_compare(@utf8.encode(a), @utf8.encode(b))
    }
    (Blob(a), Blob(b)) => bytes_compare(a, b)
    _ => rank(a).compare(rank(b))
  }
}

///|
fn as_double(value : Value) -> Double {
  match numeric(value, false) {
    Integer(n) => n.to_double()
    Real(n) => n
    _ => 0.0
  }
}

///|
fn arithmetic(op : String, a : Value, b : Value) -> Value {
  if a is Null || b is Null {
    return Null
  }
  let a = numeric(a, false)
  let b = numeric(b, false)
  if op == "%" {
    let x = integer_value(a)
    let y = integer_value(b)
    if y == 0L {
      return Null
    }
    let remainder = if y == -1L { 0L } else { x % y }
    return if a is Real(_) || b is Real(_) {
      Real(remainder.to_double())
    } else {
      Integer(remainder)
    }
  }
  if a is Integer(x) && b is Integer(y) {
    if op == "+" {
      let z = x + y
      if (y >= 0L && z >= x) || (y < 0L && z < x) {
        return Integer(z)
      }
    } else if op == "-" {
      let z = x - y
      if (y >= 0L && z <= x) || (y < 0L && z > x) {
        return Integer(z)
      }
    } else if op == "*" {
      let z = x * y
      if y == 0L || (!(x == -9223372036854775808L && y == -1L) && z / y == x) {
        return Integer(z)
      }
    } else if op == "/" {
      if y == 0L {
        return Null
      }
      if !(x == -9223372036854775808L && y == -1L) {
        return Integer(x / y)
      }
    } else if op == "%" {
      return if y == 0L {
        Null
      } else if y == -1L {
        Integer(0L)
      } else {
        Integer(x % y)
      }
    }
  }
  let x = as_double(a)
  let y = as_double(b)
  match op {
    "+" => sql_real(x + y)
    "-" => sql_real(x - y)
    "*" => sql_real(x * y)
    "/" => if y == 0 { Null } else { sql_real(x / y) }
    "%" =>
      if y.to_int64() == 0L {
        Null
      } else if y.to_int64() == -1L {
        Real(0)
      } else {
        Real((x.to_int64() % y.to_int64()).to_double())
      }
    _ => Null
  }
}

///|
/// SQLite's UTF-8 reader maps these two BMP noncharacters to U+FFFD while
/// retaining their original bytes in stored TEXT and char() results.
fn sqlite_utf8_char(c : Char) -> Char {
  if c == '\u{fffe}' || c == '\u{ffff}' {
    '\u{fffd}'
  } else {
    c
  }
}

///|
fn pattern_chars(text : String) -> Array[Char] {
  let chars : Array[Char] = []
  for c in text.iter() {
    if c == '\u{0}' {
      break
    }
    chars.push(sqlite_utf8_char(c))
  }
  chars
}

///|
/// Iterative wildcard matching avoids recursive blowups on hostile LIKE input.
fn like(text : String, pattern : String, escape : Char?) -> Bool {
  let text = pattern_chars(nocase_prefix(text))
  let original = pattern_chars(pattern)
  let pattern = pattern_chars(nocase_prefix(pattern))
  let escape = escape.map(sqlite_utf8_char)
  let mut previous = Array::make(text.length() + 1, false)
  previous[0] = true
  let mut index = 0
  while index < pattern.length() {
    let escaped = escape == Some(original[index])
    if escaped {
      index += 1
      if index == pattern.length() {
        return false
      }
    }
    let c = pattern[index]
    index += 1
    let many = !escaped && c == '%'
    let one = !escaped && c == '_'
    let next = Array::make(text.length() + 1, false)
    if many {
      next[0] = previous[0]
    }
    for i = 1; i <= text.length(); i = i + 1 {
      next[i] = if many {
        previous[i] || next[i - 1]
      } else {
        previous[i - 1] && (one || c == text[i - 1])
      }
    }
    previous = next
  }
  previous[text.length()]
}

///|
/// SQLite BINARY compares bytes in the database encoding; NOCASE/RTRIM use
/// their UTF-8 collators. Newly created logical databases default to UTF-8.
fn compare_stored(
  store : Store,
  a : Value,
  b : Value,
  collation : String,
) -> Int32 {
  let encoding = store.encoding.unwrap_or(1)
  if collation == "binary" && encoding != 1 && a is Text(a) && b is Text(b) {
    let order : @utf16.Endian = if encoding == 2 { Little } else { Big }
    bytes_compare(
      @utf16.encode(a, endianness=order),
      @utf16.encode(b, endianness=order),
    )
  } else {
    compare_value(a, b, collation)
  }
}

///|
/// Remainder and integer casts do not round an existing INTEGER through Double.
fn integer_value(value : Value) -> Int64 {
  if value is Text(text) {
    let bytes = @utf8.encode(text)
    let mut index = 0
    while index < bytes.length() &&
          [9, 10, 11, 12, 13, 32].contains(bytes[index].to_int()) {
      index += 1
    }
    let negative = index < bytes.length() && bytes[index] == b'-'
    if index < bytes.length() && (bytes[index] == b'-' || bytes[index] == b'+') {
      index += 1
    }
    let limit = if negative {
      9223372036854775808UL
    } else {
      9223372036854775807UL
    }
    let mut number = 0UL
    while index < bytes.length() && bytes[index] >= b'0' && bytes[index] <= b'9' {
      let digit = (bytes[index].to_int() - 48).to_uint64()
      if number > (limit - digit) / 10UL {
        return if negative {
          -9223372036854775808L
        } else {
          9223372036854775807L
        }
      }
      number = number * 10UL + digit
      index += 1
    }
    return if negative {
      (0UL - number).reinterpret_as_int64()
    } else {
      number.reinterpret_as_int64()
    }
  }
  if value is Blob(bytes) {
    return integer_value(Text(@utf8.decode_lossy(bytes)))
  }
  match numeric(value, false) {
    Integer(n) => n
    Real(n) =>
      if n >= 9223372036854775808.0 {
        9223372036854775807L
      } else if n <= -9223372036854775808.0 {
        -9223372036854775808L
      } else {
        n.to_int64()
      }
    _ => 0L
  }
}

///|
fn shift_value(op : String, a : Value, b : Value) -> Value {
  if a is Null || b is Null {
    return Null
  }
  let a = integer_value(a)
  let b = integer_value(b)
  let left = (op == "<<") != (b < 0L)
  if b >= 64L || b <= -64L {
    return Integer(if !left && a < 0L { -1L } else { 0L })
  }
  let n = b.abs().to_int()
  Integer(if left { a << n } else { a >> n })
}

///|
/// Grammar has already been checked. The core parser rejects overflow whereas
/// SQLite represents it as IEEE infinity; underflow remains signed zero.
fn decimal_double(text : String) -> Double {
  @string.parse_double(text) catch {
    _ => {
      let lower = identifier(text)
      let parts = lower.split("e").to_array()
      let zero = parts[0]
        .to_owned()
        .iter()
        .all(c => c == '0' || c == '.' || c == '+' || c == '-')
      let underflow = parts.length() > 1 && parts[1].has_prefix("-")
      let value = if zero || underflow {
        0.0
      } else {
        0x7ff0000000000000UL.reinterpret_as_double()
      }
      if text.has_prefix("-") {
        -value
      } else {
        value
      }
    }
  }
}

///|
fn sql_real(n : Double) -> Value {
  if n.is_nan() {
    Null
  } else {
    Real(n)
  }
}

// Source: window.mbt

///|
#derive(ToJson, FromJson)
priv enum WindowBound {
  UnboundedPreceding
  Preceding(Expr)
  Current
  Following(Expr)
  UnboundedFollowing
}

///|
#derive(ToJson, FromJson)
priv struct WindowFrame {
  kind : String
  start : WindowBound
  end : WindowBound
}

///|
fn Parser::window_bound(p : Parser) -> WindowBound raise SqlError {
  if p.take("unbounded") {
    if p.take("preceding") {
      UnboundedPreceding
    } else {
      p.expect("following")
      UnboundedFollowing
    }
  } else if p.take("current") {
    p.expect("row")
    Current
  } else {
    let e = p.expression(1)
    if p.take("preceding") {
      Preceding(e)
    } else {
      p.expect("following")
      Following(e)
    }
  }
}

///|
fn Parser::window_frame(p : Parser) -> WindowFrame raise SqlError {
  let kind = p.peek()
  if !["rows", "range", "groups"].contains(kind) {
    return { kind: "range", start: UnboundedPreceding, end: Current, }
  }
  p.position += 1
  if p.take("between") {
    let start = p.window_bound()
    p.expect("and")
    { kind, start, end: p.window_bound(), }
  } else {
    { kind, start: p.window_bound(), end: Current, }
  }
}

///|
fn aggregate_name(name : String, arity : Int32) -> Bool {
  if (name == "min" || name == "max") && arity >= 2 {
    return false
  }
  [
    "count", "sum", "total", "avg", "min", "max", "group_concat", "string_agg", "json_group_array",
    "json_group_object",
  ].contains(name)
}

///|
fn window_arity(name : String, n : Int32) -> Bool {
  match name {
    "json_group_array" | "json_group_object" => false
    "lag" | "lead" => n >= 1 && n <= 3
    "row_number" | "rank" | "dense_rank" | "percent_rank" | "cume_dist" =>
      n == 0
    "ntile" | "first_value" | "last_value" => n == 1
    "nth_value" => n == 2
    "group_concat" => n == 1 || n == 2
    "string_agg" => n == 2
    _ => aggregate_name(name, n) && n == 1
  }
}

///|
fn group_concat(args : Array[Expr], ctx : Evaluation) -> Value raise SqlError {
  let input = filter_input(args[0])
  let predicate = aggregate_predicate(args[0])
  let distinct = input is Call("$distinct", _)
  let arg = match input {
    Call("$distinct", [e]) => e
    _ => input
  }
  let seen : Array[Value] = []
  let out = @buffer.Buffer()
  for row in ctx.group.unwrap_or([ctx.row]) {
    let here = { ..ctx, row, group: None, }
    if predicate is Some(p) && truth(evaluate(p, here)) != 1 {
      continue
    }
    let value = evaluate(arg, here)
    if value is Null ||
      (
        distinct &&
        seen.any(v => {
          compare_stored(ctx.store, v, value, expression_collation(arg, ctx)) ==
          0
        })
      ) {
      continue
    }
    if !seen.is_empty() {
      out.write_bytes(
        @utf8.encode(
          if args.length() == 2 {
            checked_text_value(evaluate(args[1], here))
          } else {
            ","
          },
        ),
      )
    }
    out.write_bytes(@utf8.encode(checked_text_value(value)))
    seen.push(value)
  }
  if seen.is_empty() {
    Null
  } else {
    Text(@utf8.decode_lossy(out.to_bytes()))
  }
}

///|
fn collect_windows(e : Expr, out : Array[Expr]) -> Unit {
  match e {
    Window(_, _, _, _, _) =>
      if !out.any(previous => @json.to_json(previous) == @json.to_json(e)) {
        out.push(e)
      }
    Unary(_, e) | Cast(e, _) | Collate(e, _) => collect_windows(e, out)
    Binary(_, a, b) => {
      collect_windows(a, out)
      collect_windows(b, out)
    }
    Call(_, args) =>
      for e in args {
        collect_windows(e, out)
      }
    Between(a, b, c) => {
      collect_windows(a, out)
      collect_windows(b, out)
      collect_windows(c, out)
    }
    Case(base, arms, other) => {
      if base is Some(e) {
        collect_windows(e, out)
      }
      for (a, b) in arms {
        collect_windows(a, out)
        collect_windows(b, out)
      }
      collect_windows(other, out)
    }
    _ => ()
  }
}

///|
fn window_offset(e : Expr, ctx : Evaluation) -> Int32 raise SqlError {
  let v = evaluate(e, ctx)
  let n = cast_integer(v)
  guard !(v is Null) &&
    n >= 0L &&
    n <= 1000000000L &&
    compare_stored(ctx.store, numeric(v, false), Integer(n), "binary") == 0 else {
    fail("frame offset must be a non-negative integer")
  }
  n.to_int()
}

///|
fn compute_windows(
  expressions : Array[Expr],
  contexts : Array[Evaluation],
  base : Evaluation,
) -> Unit raise SqlError {
  for expression in expressions {
    guard expression is Window(name, args, partitions, orders, frame) else {
      continue
    }
    let groups : Array[Array[Evaluation]] = []
    let keys : Array[Array[Value]] = []
    for ctx in contexts {
      let key = partitions.map(e => evaluate(e, ctx))
      let mut found = -1
      for i, previous in keys {
        if previous
          .mapi((j, v) => {
            compare_stored(
              base.store,
              v,
              key[j],
              expression_collation(partitions[j], base),
            ) ==
            0
          })
          .all(v => v) {
          found = i
          break
        }
      }
      if found < 0 {
        keys.push(key)
        groups.push([ctx])
      } else {
        groups[found].push(ctx)
      }
    }
    let identity = @json.to_json(expression).stringify()
    for group in groups {
      let ranked = group.map(ctx => {
        output: [],
        context: ctx,
        keys: orders.map(o => evaluate(ordering_expression(o.expression), ctx)),
      })
      let collations = orders.map(o => {
        expression_collation(ordering_expression(o.expression), base)
      })
      sort_query_rows(ranked, orders, collations)
      fn peer(a : Int32, b : Int32) -> Bool {
        ranked[a].keys
        .mapi((i, v) => {
          compare_stored(base.store, v, ranked[b].keys[i], collations[i]) == 0
        })
        .all(v => v)
      }
      let mut dense = 0
      let mut rank = 0
      for index, row in ranked {
        if index == 0 || !peer(index, index - 1) {
          dense += 1
          rank = index
        }
        let mut peer_end = index + 1
        while peer_end < ranked.length() && peer(index, peer_end) {
          peer_end += 1
        }
        let here = row.context
        let n = ranked.length()
        let value = if name == "row_number" {
          Value::Integer((index + 1).to_int64())
        } else if name == "rank" {
          Integer((rank + 1).to_int64())
        } else if name == "dense_rank" {
          Integer(dense.to_int64())
        } else if name == "percent_rank" {
          Real(
            if n <= 1 {
              0.0
            } else {
              rank.to_double() / (n - 1).to_double()
            },
          )
        } else if name == "cume_dist" {
          Real(peer_end.to_double() / n.to_double())
        } else if name == "ntile" {
          let buckets = window_offset(args[0], here)
          guard buckets > 0 else {
            fail("argument of ntile must be a positive integer")
          }
          let size = n / buckets
          let extra = n % buckets
          Integer(
            (if index < (size + 1) * extra {
              index / (size + 1) + 1
            } else {
              extra + (index - (size + 1) * extra) / size + 1
            }).to_int64(),
          )
        } else if name == "lag" || name == "lead" {
          let offset = if args.length() >= 2 {
            window_offset(args[1], here)
          } else {
            1
          }
          let target = index + (if name == "lag" { -offset } else { offset })
          if target >= 0 && target < n {
            evaluate(args[0], ranked[target].context)
          } else if args.length() == 3 {
            evaluate(args[2], here)
          } else {
            Null
          }
        } else {
          fn boundary(
            bound : WindowBound,
            finish : Bool,
          ) -> Int32 raise SqlError {
            match bound {
              UnboundedPreceding => 0
              UnboundedFollowing => n
              Current =>
                if frame.kind == "rows" {
                  index + (if finish { 1 } else { 0 })
                } else if finish {
                  peer_end
                } else {
                  rank
                }
              Preceding(e) | Following(e) => {
                let amount = window_offset(e, base)
                let sign = if bound is Preceding(_) { -1 } else { 1 }
                if frame.kind == "rows" {
                  (index + sign * amount + (if finish { 1 } else { 0 }))
                  .max(0)
                  .min(n)
                } else if frame.kind == "groups" {
                  let starts : Array[Int32] = [0]
                  for j in 1..<n {
                    if !peer(j, j - 1) {
                      starts.push(j)
                    }
                  }
                  let target = dense -
                    1 +
                    sign * amount +
                    (if finish { 1 } else { 0 })
                  if target < 0 {
                    0
                  } else if target >= starts.length() {
                    n
                  } else {
                    starts[target]
                  }
                } else {
                  guard orders.length() == 1 else {
                    fail("RANGE offset requires one ORDER BY expression")
                  }
                  let key = row.keys[0]
                  if !(key is Integer(_) || key is Real(_)) {
                    return if finish { peer_end } else { rank }
                  }
                  let target = arithmetic(
                    "+",
                    key,
                    Integer(
                      (sign *
                      (if orders[0].descending { -1 } else { 1 }) *
                      amount).to_int64(),
                    ),
                  )
                  let mut position = 0
                  while position < n {
                    let cmp = ordering_compare(
                      base.store,
                      orders[0],
                      ranked[position].keys[0],
                      target,
                      collations[0],
                    )
                    if cmp > 0 || (cmp == 0 && !finish) {
                      break
                    }
                    position += 1
                  }
                  position
                }
              }
            }
          }
          let start = boundary(frame.start, false)
          let end = if orders.is_empty() &&
            frame.kind == "range" &&
            frame.end is Current {
            n
          } else {
            boundary(frame.end, true)
          }
          let members = if end > start {
            ranked[start:end].to_owned()
          } else {
            []
          }
          let members = if aggregate_predicate(args[0]) is Some(predicate) {
            members.filter(entry => {
              truth(evaluate(predicate, entry.context)) == 1
            })
          } else {
            members
          }
          if name == "first_value" ||
            name == "last_value" ||
            name == "nth_value" {
            let pos = if name == "first_value" {
              0
            } else if name == "last_value" {
              members.length() - 1
            } else {
              let n = window_offset(args[1], here)
              guard n > 0 else { fail("nth_value requires a positive integer") }
              n - 1
            }
            if pos < 0 || pos >= members.length() {
              Null
            } else {
              evaluate(args[0], members[pos].context)
            }
          } else {
            let values = members.map(entry => {
              args.mapi((i, e) => {
                let e = filter_input(e)
                {
                  ..binding(
                    "$window" + i.to_string(),
                    if e is Star(_) {
                      Integer(1L)
                    } else {
                      evaluate(e, entry.context)
                    },
                  ),
                  collation: if e is Star(_) {
                    "binary"
                  } else {
                    expression_collation(e, entry.context)
                  },
                }
              })
            })
            evaluate_call(
              name,
              args.mapi((i, _) => Column("", "$window" + i.to_string())),
              {
                ..here,
                row: if values.is_empty() {
                  args.mapi((i, _) => binding("$window" + i.to_string(), Null))
                } else {
                  values[0]
                },
                group: Some(values),
              },
            )
          }
        }
        here.window_values[identity] = value
      }
    }
  }
}
