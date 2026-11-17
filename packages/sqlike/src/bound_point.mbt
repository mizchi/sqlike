///|
priv struct PreparedPoint {
  table_slot : Int32
  layout : Environment
  columns : Array[RowProjection]
  output : Environment
  predicate : BoundExpression
  access : BoundAccess
  limit : BoundValue
  offset : BoundValue
}

///|
fn prepare_point(
  store : Store,
  select : Selection,
  table : Table,
  slot : Int32,
  projection : PreparedProjection,
  output : Environment,
  parameters : Int32,
) -> PreparedPoint? raise SqlError {
  let source = select.sources[0]
  guard select.compound is None &&
    select.ctes.is_empty() &&
    !select.distinct &&
    select.groups.is_empty() &&
    select.having is Literal(Integer(1L)) &&
    !source.left &&
    source.right != Some(true) &&
    source.natural != Some(true) &&
    source.using_columns.unwrap_or([]).is_empty() &&
    source.on is Literal(Integer(1L)) &&
    select.orders.all(o => {
      match o.expression {
        Column(_, _) | Literal(Integer(_)) => true
        _ => false
      }
    }) &&
    bind_key_value(select.limit) is Some(limit) &&
    bind_key_value(select.offset) is Some(offset) else {
    return None
  }
  let access = bind_access(table, select.predicate, projection.layout)
  guard !(access is BoundScan) else { return None }
  Some({
    table_slot: slot,
    layout: projection.layout,
    columns: projection.columns,
    output,
    predicate: bind_expression(
      select.predicate,
      evaluation(store, Array::make(parameters, Null), projection.layout),
    ),
    access,
    limit,
    offset,
  })
}

///|
fn execute_bound_point(
  plan : PreparedPoint,
  store : Store,
  params : Array[Value],
) -> Array[Environment]? raise SqlError {
  // Unsupported LIMIT binding classes retain the existing general validator.
  guard read_key_value(plan.limit, params) is Integer(limit) &&
    read_key_value(plan.offset, params) is Integer(offset) else {
    return None
  }
  if limit == 0L {
    return Some([])
  }
  let table = store.tables[plan.table_slot]
  for row in bound_candidates(plan.access, store, table, params) {
    let input : BoundInput = {
      store,
      params,
      row,
      layout: plan.layout,
      context: None,
    }
    if truth(evaluate_bound(plan.predicate, input)) == 1 && offset <= 0L {
      return Some([project_stored_row(plan.columns, plan.output, row)])
    }
  }
  Some([])
}
