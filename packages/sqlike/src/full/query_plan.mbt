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
