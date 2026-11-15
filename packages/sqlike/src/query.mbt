///|
/// Result columns survive even when a CTE/view produces no rows.
priv struct Relation {
  rows : Array[Environment]
  template : Environment
}

///|
/// Virtual schema rows use the same evaluator as user tables.
fn schema_rows(store : Store) -> Array[Environment] {
  let rows : Array[Environment] = []
  for table in store.tables {
    rows.push([
      binding("type", Text("table")),
      binding("name", Text(table.name)),
      binding("tbl_name", Text(table.name)),
      binding("rootpage", Integer(0L)),
      binding("sql", Text(table.sql)),
      {
        ..binding("rowid", Integer((rows.length() + 1).to_int64())),
        hidden: true,
      },
    ])
  }
  for object in store.objects {
    rows.push([
      binding("type", Text(object.kind)),
      binding("name", Text(object.name)),
      binding("tbl_name", Text(object.table)),
      binding("rootpage", Integer(0L)),
      binding("sql", Text(object.sql)),
      {
        ..binding("rowid", Integer((rows.length() + 1).to_int64())),
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
    return relation.rows
  }
  if identifier(name) == "sqlite_schema" || identifier(name) == "sqlite_master" {
    return schema_rows(store)
  }
  for object in store.objects {
    if identifier(object.name) == identifier(name) && object.kind == "view" {
      guard object.selection is Some(selection) else {
        fail("view has no compiled query")
      }
      return select_rows(store, selection, params, depth + 1)
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
fn empty_source(
  store : Store,
  source : Source,
  ctes : Map[String, Relation],
  params : Array[Value],
  depth : Int32,
) -> Environment raise SqlError {
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
      ..binding(n, Null),
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
      let c = compare_stored(
        a.context.store,
        a.keys[i],
        b.keys[i],
        collations[i],
      )
      if c != 0 {
        return if order.descending { -c } else { c }
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
) -> Relation raise SqlError {
  if select.compound is Some(_) {
    return compound_relation(select, context, existence)
  }
  let store = context.store
  let params = context.params
  let depth = context.depth
  guard depth <= 16 else { fail("SQL query recursion limit") }
  let output_template = match prepared {
    Some(plan) => plan.output
    None => selection_template(select, context)
  }
  if !existence &&
    simple_aggregate(select, context, output_template) is Some(result) {
    return result
  }
  if !existence &&
    simple_relation(
      select,
      context,
      output_template,
      prepared=match prepared {
        Some(plan) => plan.simple
        None => None
      },
    )
    is Some(result) {
    return result
  }
  let ctes : Map[String, Relation] = Map(context.ctes.to_array())
  for (name, selection) in select.ctes {
    ctes[identifier(name)] = execute_cte(select, name, selection, {
      ..context,
      ctes,
    })
  }
  let mut input : Array[Environment] = [[]]
  let mut template : Environment = []
  for source in select.sources {
    if source.right == Some(true) && !FEATURE_OUTER_JOIN {
      fail("feature disabled: rightFullJoin")
    }
    let right = source_rows(store, source.name, params, ctes, depth).map(row => {
      row.map(b => { ..b, qualifier: source.qualifier, })
    })
    let empty = empty_source(store, source, ctes, params, depth)
    prepare_expression(
      source.on,
      { ..context, ctes, row: template + empty, },
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
        if truth(evaluate(source.on, { ..context, ctes, row: joined, })) == 1 &&
          using_matches(left, row, pairs, context) {
          next.push(using_row(source, left, row, pairs))
          matched = true
          if track_right {
            matched_right[ri] = true
          }
        }
        guard next.length() <= 100000 else { fail("SQL result resource limit") }
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
        guard next.length() <= 100000 else { fail("SQL result resource limit") }
      }
    }
    input = next
  }
  let base : Evaluation = { ..context, ctes, row: template, }
  input = input.filter(row => {
    truth(evaluate(select.predicate, { ..base, row, })) == 1
  })
  let groups : Array[Array[Environment]] = []
  if !select.groups.is_empty() {
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
  let contexts : Array[Evaluation] = []
  for group in groups {
    let ctx = {
      ..base,
      row: if group.is_empty() {
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
    let limit = evaluate(select.limit, base)
    let offset = evaluate(select.offset, base)
    guard limit is Integer(count) && offset is Integer(start) else {
      fail("datatype mismatch: LIMIT/OFFSET")
    }
    let rows = contexts
      .mapi((i, _) => i)
      .filter(i => {
        i.to_int64() >= start.max(0L) &&
        (count < 0L || i.to_int64() - start.max(0L) < count)
      })
      .map(_ => ([] : Environment))
    return { rows, template: output_template, }
  }
  let numbered : Map[Int32, Array[Int32]] = Map([])
  if FEATURE_WINDOWS {
    let window_expressions : Array[Expr] = []
    for p in select.projections {
      collect_windows(p.expression, window_expressions)
    }
    for o in select.orders {
      collect_windows(o.expression, window_expressions)
    }
    compute_windows(window_expressions, contexts, base)
    // row_number has its own ORDER BY, independently of final result ordering.
    for pi, projection in select.projections {
      if projection.expression is RowNumber(orders) {
        let ranked = contexts.map(ctx => {
          output: [],
          context: ctx,
          keys: orders.map(o => evaluate(o.expression, ctx)),
        })
        let collations = orders.map(o => {
          expression_collation(o.expression, base)
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
    if select.distinct &&
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
    let ordering_ctx = {
      ..ctx,
      row: projected +
      ctx.row.filter(b => {
        b.qualifier != "" ||
        !projected.any(p => identifier(p.name) == identifier(b.name))
      }),
    }
    let keys = select.orders.map(o => {
      match o.expression {
        Literal(Integer(n)) => {
          guard n >= 1L && n <= projected.length().to_int64() else {
            fail("ORDER BY position out of range")
          }
          projected[n.to_int() - 1].value
        }
        _ => evaluate(o.expression, ordering_ctx)
      }
    })
    output.push({ output: projected, context: ctx, keys, })
  }
  let collations = select.orders.map(o => {
    match o.expression {
      Literal(Integer(n)) => output_template[n.to_int() - 1].collation
      Column("", name) => {
        let projection = select.projections.filter(p => {
          identifier(p.label) == identifier(name)
        })
        if projection.length() == 1 {
          expression_collation(projection[0].expression, base)
        } else {
          expression_collation(o.expression, base)
        }
      }
      _ => expression_collation(o.expression, base)
    }
  })
  sort_query_rows(output, select.orders, collations)
  let limit = evaluate(select.limit, base)
  let offset = evaluate(select.offset, base)
  guard limit is Integer(count) && offset is Integer(start) else {
    fail("datatype mismatch: LIMIT/OFFSET")
  }
  let rows = output
    .mapi((i, row) => (i, row))
    .filter(pair => {
      pair.0.to_int64() >= start.max(0L) &&
      (count < 0L || pair.0.to_int64() - start.max(0L) < count)
    })
    .map(pair => pair.1.output)
  { rows, template: output_template, }
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
/// Resolve SELECT output and correlated scopes without evaluating any values.
fn selection_template(
  select : Selection,
  context : Evaluation,
) -> Environment raise SqlError {
  guard context.depth <= 16 else { fail("SQL query recursion limit") }
  let ctes : Map[String, Relation] = Map(context.ctes.to_array())
  for (name, selection) in select.ctes {
    ctes[identifier(name)] = prepare_cte(select, name, selection, {
      ..context,
      ctes,
    })
  }
  let mut row : Environment = []
  for source in select.sources {
    if source.right == Some(true) && !FEATURE_OUTER_JOIN {
      fail("feature disabled: rightFullJoin")
    }
    let right = empty_source(
      context.store,
      source,
      ctes,
      context.params,
      context.depth,
    )
    prepare_expression(
      source.on,
      { ..context, ctes, row: row + right, },
      false,
      false,
    )
    row = using_row(source, row, right, using_pairs(source, row, right))
  }
  let base = { ..context, ctes, row, }
  validate_aggregate_output(select)
  prepare_expression(select.predicate, base, false, false)
  for e in select.groups {
    prepare_expression(e, base, false, false)
  }
  prepare_expression(select.having, base, true, false)
  let output = project_template(select.projections, base)
  if select.compound is Some(arms) {
    for (_, arm) in arms {
      guard selection_template(arm, { ..context, ctes, }).length() ==
        output.length() else {
        fail("SELECTs do not have the same number of result columns")
      }
    }
  }
  let ordering = { ..base, row: output + row, }
  for order in select.orders {
    if select.compound is Some(_) {
      ignore(compound_order_index(select, order.expression, output.length()))
    } else if order.expression is Literal(Integer(n)) {
      guard n >= 1L && n <= output.length().to_int64() else {
        fail("ORDER BY position out of range")
      }
    } else {
      prepare_expression(order.expression, ordering, true, true)
    }
  }
  prepare_expression(select.limit, context, false, false)
  prepare_expression(select.offset, context, false, false)
  output
}
