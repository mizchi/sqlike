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
