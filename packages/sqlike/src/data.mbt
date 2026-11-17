///|
/// Parser-free data execution shared by SQL and precompiled entry points.
fn execute_data_statement(
  store : Store,
  statement : DataStatement,
  params : Array[Value],
  prepared_selection~ : PreparedSelection? = None,
  prepared_update~ : PreparedUpdatePlan? = None,
) -> Array[Environment] raise SqlError {
  let previous = store.triggers.prior_changes
  store.triggers.prior_changes = connection_changes(store)
  store.triggers.data_depth += 1
  if !data_readonly(statement) {
    store.triggers.failed_statement = false
  }
  defer {
    store.triggers.prior_changes = previous
    store.triggers.data_depth -= 1
  }
  let result = match statement {
    PreparedTransaction(op, name) => {
      guard CAP_STATEMENT_TRANSACTION else {
        fail("catalog capability disabled: transaction")
      }
      return execute_transaction(store, op, name)
    }
    PreparedSelect(select) => {
      guard CAP_STATEMENT_SELECT else {
        fail("catalog capability disabled: select")
      }
      if prepared_selection is Some(metadata) &&
        metadata.point is Some(plan) &&
        execute_bound_point(plan, store, params) is Some(rows) {
        return rows
      }
      return select_rows(store, select, params, 0, prepared=prepared_selection)
    }
    PreparedPragma(name, table) => {
      guard CAP_STATEMENT_PRAGMA else {
        fail("catalog capability disabled: pragma")
      }
      return execute_pragma(store, name, table, None, params)
    }
    PreparedInsert(insertion) => {
      guard CAP_STATEMENT_INSERT else {
        fail("catalog capability disabled: insert")
      }
      insert_rows(store, insertion, params)
    }
    PreparedUpdate(name, setters, predicate, returning) => {
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
        o.kind == "trigger" &&
        matches_identifier(o.table, identifier(table.name))
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
            ignore(column_index(table, n))
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
            },
          )
      }
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
          None => updated_row(store, table, row, setters, [], params)
        }
        if !run_triggers(
            store,
            table,
            "before",
            "update",
            columns,
            Some(row),
            Some(next),
          ) {
          continue
        }
        if !check_updated_row(
            store,
            table,
            row,
            next,
            params,
            policy=store.triggers.conflict_override,
          ) {
          continue
        }
        foreign_restrict(store, table, row, Some(next))
        replace_table_row(store, table, row, next)
        foreign_actions(store, table, row, Some(next), 0)
        store.changes += 1
        if !returning.is_empty() {
          rows.push(
            match prepared_update {
              Some(plan) =>
                project_bound(plan.returning, {
                  store,
                  params,
                  row: next,
                  layout: template,
                  context: None,
                })
              None =>
                project(
                  returning,
                  evaluation(
                    store,
                    params,
                    row_environment_from(template, next),
                  ),
                )
            },
          )
        }
        ignore(
          run_triggers(
            store,
            table,
            "after",
            "update",
            columns,
            Some(row),
            Some(next),
          ),
        )
      }
      rows
    }
    PreparedDelete(name, predicate, returning) => {
      guard CAP_STATEMENT_DELETE else {
        fail("catalog capability disabled: delete")
      }
      let table = get_table(store, name)
      prepare_foreign_table(store, table)
      prepare_trigger_event(store, table, "delete", [])
      let with_triggers = store.objects.any(o => {
        o.kind == "trigger" &&
        matches_identifier(o.table, identifier(table.name))
      })
      let rows : Array[Environment] = []
      store.changes = 0
      let template = row_environment(
        table,
        { id: 0L, values: Array::make(table.columns.length(), Null), },
        table.name,
      )
      prepare_expression(
        predicate,
        evaluation(store, params, template),
        false,
        false,
      )
      prepare_returning(returning, evaluation(store, params, template))
      for
        candidate in primary_candidates(store, table, predicate, params, name).unwrap_or_else(() => {
            candidate_rows(
              store,
              table,
              rowid_equality(table, predicate, params, name),
            )
          },
        ) {
        let row = if with_triggers {
          guard table_row_by_id(store, table, candidate.id) is Some(current) else {
            continue
          }
          current
        } else {
          candidate
        }
        let ctx = evaluation(store, params, row_environment_from(template, row))
        if truth(evaluate(predicate, ctx)) != 1 {
          continue
        }
        if delete_row(store, table, row, 0, true) {
          if !returning.is_empty() {
            rows.push(project(returning, ctx))
          }
          store.changes += 1
        }
      }
      rows
    }
  }
  if !store.deferred && store.triggers.active.is_empty() {
    validate_foreign_keys(store, immediate=true)
  }
  result
}

///|
fn updated_row_from_plan(
  plan : PreparedUpdatePlan,
  previous : StoredRow,
  input : BoundInput,
) -> StoredRow raise SqlError {
  let values = previous.values.copy()
  for setter in plan.setters {
    values[setter.column] = apply_affinity(
      evaluate_bound(setter.expression, input),
      setter.affinity,
    )
  }
  finish_updated_row(previous, values, plan.integer_primary)
}
