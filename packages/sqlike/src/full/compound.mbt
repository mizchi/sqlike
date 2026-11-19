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
