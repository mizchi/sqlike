///|
fn execute_update(
  store : Store,
  name : String,
  setters : Array[(String, Expr)],
  predicate : Expr,
  returning : Array[Projection],
  params : Array[Value],
  prepared_update : PreparedUpdatePlan?,
) -> Array[Environment] raise SqlError {
  guard CAP_STATEMENT_UPDATE else {
    fail("catalog capability disabled: update")
  }
  let table = match prepared_update {
    Some(plan) => store.tables[plan.table_slot]
    None => get_table(store, name)
  }
  prepare_foreign_table(store, table)
  let columns = match prepared_update {
    Some(plan) => plan.columns
    None => setters.map(p => p.0)
  }
  prepare_trigger_event(store, table, "update", columns)
  let with_triggers = store.objects.any(o => {
    o.kind == "trigger" && matches_identifier(o.table, identifier(table.name))
  })
  let rows : Array[Environment] = []
  store.changes = 0
  let template = match prepared_update {
    Some(plan) => plan.layout
    None => {
      let template = row_environment(
        table,
        { id: 0L, values: Array::make(table.columns.length(), Null), },
        table.name,
      )
      let context = evaluation(store, params, template)
      prepare_expression(predicate, context, false, false)
      prepare_returning(returning, context)
      for (n, e) in setters {
        ignore(writable_column(table, n))
        prepare_expression(e, context, false, false)
      }
      template
    }
  }
  let candidates = match prepared_update {
    Some(plan) => bound_candidates(plan.access, store, table, params)
    None =>
      primary_candidates(store, table, predicate, params, name).unwrap_or_else(() => {
        candidate_rows(
          store,
          table,
          rowid_equality(table, predicate, params, name),
        )
      })
  }
  let in_lists = in_list_frames(
    match prepared_update {
      Some(plan) => plan.in_lists
      None =>
        statement_in_lists(
          [predicate] + setters.map(p => p.1) + returning.map(p => p.expression),
          evaluation(store, params, template),
        )
    },
  )
  for candidate in candidates {
    let row = if with_triggers {
      guard table_row_by_id(store, table, candidate.id) is Some(current) else {
        continue
      }
      current
    } else {
      candidate
    }
    let input : BoundInput = {
      store,
      params,
      row,
      layout: template,
      context: None,
      joined: None,
      in_lists,
    }
    let matches = match prepared_update {
      Some(plan) => evaluate_bound(plan.predicate, input)
      None => evaluate(predicate, input.environment())
    }
    if truth(matches) != 1 {
      continue
    }
    let next = match prepared_update {
      Some(plan) => updated_row_from_plan(plan, row, input)
      None =>
        updated_row(
          store,
          table,
          row,
          setters,
          [],
          params,
          generated=false,
          in_lists~,
        )
    }
    if apply_update_row(
        store,
        table,
        row,
        next,
        columns,
        params,
        returning,
        template,
        prepared_update.map(p => p.returning),
        with_triggers,
        in_lists~,
      )
      is Some(result) {
      rows.push(result)
    }
  }
  rows
}
