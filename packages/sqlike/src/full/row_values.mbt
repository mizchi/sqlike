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
