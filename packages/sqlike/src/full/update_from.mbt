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
