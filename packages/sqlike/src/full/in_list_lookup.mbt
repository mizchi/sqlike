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
