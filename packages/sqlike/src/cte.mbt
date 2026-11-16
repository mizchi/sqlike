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
  if recursive_cte(owner, name, query) {
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
  if !recursive_cte(owner, name, query) {
    return cte_names(
      owner,
      name,
      select_relation_in(query, { ..ctx, depth: ctx.depth + 1, }, false),
    )
  }
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
