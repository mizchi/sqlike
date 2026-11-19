///|
priv struct PreparedPoint {
  table_slot : Int32
  layout : Environment
  columns : Array[RowProjection]?
  projection : BoundProjection
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
  layout : Environment,
  columns : Array[RowProjection]?,
  parameters : Int32,
) -> PreparedPoint? raise SqlError {
  let source = select.sources[0]
  guard OPT_POINT_PROJECTION &&
    select.compound is None &&
    select.ctes.is_empty() &&
    !select.distinct &&
    select.groups.is_empty() &&
    select.projections.all(p => point_scalar(p.expression)) &&
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
  let access = bind_access(table, select.predicate, layout)
  guard !(access is BoundScan) else { return None }
  let context = evaluation(store, Array::make(parameters, Null), layout)
  Some({
    table_slot: slot,
    layout,
    columns,
    projection: bind_projection(select.projections, context),
    predicate: bind_expression(select.predicate, context),
    access,
    limit,
    offset,
  })
}

///|
/// Expressions needing relation/group/window scopes retain the general plan.
fn point_scalar(e : Expr) -> Bool {
  match e {
    ScalarSelect(_)
    | Exists(_)
    | InSelect(_, _)
    | Window(_, _, _, _, _)
    | RowNumber(_) => false
    Call(name, args) =>
      !aggregate_name(name, args.length()) && args.all(point_scalar)
    Binary(_, a, b) => point_scalar(a) && point_scalar(b)
    Unary(_, e) | Cast(e, _) | Collate(e, _) => point_scalar(e)
    Between(e, a, b) => point_scalar(e) && point_scalar(a) && point_scalar(b)
    Case(base, arms, other) =>
      base.map(point_scalar).unwrap_or(true) &&
      arms.all(p => point_scalar(p.0) && point_scalar(p.1)) &&
      point_scalar(other)
    _ => true
  }
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
      joined: None,
      in_lists: [],
    }
    if truth(evaluate_bound(plan.predicate, input)) == 1 && offset <= 0L {
      return Some([
        match plan.columns {
          Some(columns) =>
            project_stored_row(columns, plan.projection.output, row)
          None => project_bound(plan.projection, input)
        },
      ])
    }
  }
  Some([])
}
