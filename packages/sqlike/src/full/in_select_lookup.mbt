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
