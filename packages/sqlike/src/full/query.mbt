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
