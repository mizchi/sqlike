///|
/// One write contract for ordinary UPDATE and materialized UPDATE FROM. The
/// caller owns matching/SET evaluation; triggers, constraints, FK and output stay
/// in their original order, under the statement's existing rollback boundary.
fn apply_update_row(
  store : Store,
  table : Table,
  previous : StoredRow,
  next : StoredRow,
  columns : Array[String],
  params : Array[Value],
  returning : Array[Projection],
  layout : Environment,
  prepared_returning : BoundProjection?,
  with_triggers : Bool,
  in_lists~ : Array[InListFrame] = [],
) -> Environment? raise SqlError {
  let next = generated_row(store, table, next)
  if with_triggers &&
    !run_triggers(
      store,
      table,
      "before",
      "update",
      columns,
      Some(previous),
      Some(next),
    ) {
    return None
  }
  if !check_updated_row(
      store,
      table,
      previous,
      next,
      params,
      policy=store.triggers.conflict_override,
    ) {
    return None
  }
  foreign_restrict(store, table, previous, Some(next))
  replace_table_row(store, table, previous, next)
  foreign_actions(store, table, previous, Some(next), 0)
  store.changes += 1
  let output = if returning.is_empty() {
    None
  } else {
    Some(
      match prepared_returning {
        Some(plan) =>
          project_bound(plan, {
            store,
            params,
            row: next,
            layout,
            context: None,
            joined: None,
            in_lists,
          })
        None =>
          project(returning, {
            ..evaluation(store, params, row_environment_from(layout, next)),
            in_lists,
          })
      },
    )
  }
  if with_triggers {
    ignore(
      run_triggers(
        store,
        table,
        "after",
        "update",
        columns,
        Some(previous),
        Some(next),
      ),
    )
  }
  output
}
