///|
priv struct IndexConstraint {
  column : Int32
  collation : String
  op : String
  value : Value
}

///|
priv struct IndexRange {
  rows : Array[StoredRow]
  start : Int32
  end : Int32
  reverse : Bool
  residual : Bool
}

///|
fn index_column(table : Table, expression : Expr, qualifier : String) -> Int32? {
  if expression is Collate(e, _) {
    return index_column(table, e, qualifier)
  }
  guard expression is Column(q, name) &&
    (q == "" || matches_identifier(q, identifier(qualifier))) else {
    return None
  }
  let key = identifier(name)
  for i, column in table.columns {
    if matches_identifier(column.name, key) {
      return Some(i)
    }
  }
  if !table.without_rowid && ["rowid", "_rowid_", "oid"].contains(key) {
    Some(-1)
  } else {
    None
  }
}

///|
fn same_index_column(table : Table, a : Int32, b : Int32) -> Bool {
  a == b ||
  (
    integer_primary(table) >= 0 &&
    (
      (a == -1 && b == integer_primary(table)) ||
      (b == -1 && a == integer_primary(table))
    )
  )
}

///|
fn index_collation(table : Table, expression : Expr, column : Int32) -> String {
  if expression is Collate(_, name) {
    identifier(name)
  } else if column < 0 {
    "binary"
  } else {
    table.columns[column].collation
  }
}

///|
/// ORDER BY resolves output aliases, preserving * expansion priority.
fn index_order_term(
  select : Selection,
  table : Table,
  qualifier : String,
  order : Ordering,
) -> IndexField? {
  let mut expression = order.expression
  let explicit = if expression is Collate(inner, name) {
    expression = inner
    Some(name)
  } else {
    None
  }
  if expression is Column("", name) {
    let key = identifier(name)
    for projection in select.projections {
      if projection.expression is Star(_) {
        let found = table.columns.filter(c => matches_identifier(c.name, key))
        if !found.is_empty() {
          expression = Column(qualifier, found[0].name)
          break
        }
      }
      if matches_identifier(projection.label, key) {
        expression = projection.expression
        break
      }
    }
  }
  guard index_column(table, expression, qualifier) is Some(column) else {
    return None
  }
  Some({
    column,
    collation: explicit
    .map(identifier)
    .unwrap_or(index_collation(table, expression, column)),
    descending: order.descending,
  })
}

///|
fn index_value(expression : Expr, params : Array[Value]) -> Value? {
  match expression {
    Literal(value) => Some(value)
    Parameter(i) =>
      if i >= 0 && i < params.length() {
        Some(params[i])
      } else {
        None
      }
    _ => None
  }
}

///|
/// Only simple AND comparisons are extracted. Other predicates use the evaluator.
fn index_constraints(
  expression : Expr,
  table : Table,
  qualifier : String,
  params : Array[Value],
  constraints : Array[IndexConstraint],
) -> Bool {
  if expression is Literal(Integer(1L)) {
    return true
  }
  guard expression is Binary(op, left, right) else { return false }
  if op == "and" {
    return index_constraints(left, table, qualifier, params, constraints) &&
      index_constraints(right, table, qualifier, params, constraints)
  }
  guard ["=", "==", ">", ">=", "<", "<="].contains(op) else { return false }
  let (column, collation, operator, bound) = if index_column(
      table, left, qualifier,
    )
    is Some(column) {
    (
      column,
      if right is Collate(_, name) {
        identifier(name)
      } else {
        index_collation(table, left, column)
      },
      op,
      index_value(right, params),
    )
  } else if index_column(table, right, qualifier) is Some(column) {
    (
      column,
      if left is Collate(_, name) {
        identifier(name)
      } else {
        index_collation(table, right, column)
      },
      match op {
        ">" => "<"
        ">=" => "<="
        "<" => ">"
        "<=" => ">="
        _ => op
      },
      index_value(left, params),
    )
  } else {
    return false
  }
  guard bound is Some(value) else { return false }
  let affinity = if column < 0 {
    "integer"
  } else {
    affinity_name(table.columns[column].declared)
  }
  let value = if ["integer", "numeric", "real"].contains(affinity) {
    apply_affinity(value, "numeric")
  } else if affinity == "text" {
    apply_affinity(value, "text")
  } else {
    value
  }
  constraints.push({ column, collation, op: operator, value, })
  true
}

///|
fn field_constraints(
  table : Table,
  field : IndexField,
  constraints : Array[IndexConstraint],
) -> Array[IndexConstraint] {
  constraints.filter(c => {
    same_index_column(table, field.column, c.column) &&
    field.collation == c.collation
  })
}

///|
fn field_fixed(
  table : Table,
  field : IndexField,
  constraints : Array[IndexConstraint],
) -> Bool {
  field_constraints(table, field, constraints).any(c => {
    c.op == "=" || c.op == "=="
  })
}

///|
fn index_order_matches(
  table : Table,
  fields : Array[IndexField],
  orders : Array[IndexField],
  constraints : Array[IndexConstraint],
  reverse : Bool,
) -> Bool {
  let keys = fields + [{ column: -1, collation: "binary", descending: false, }]
  let mut position = 0
  for order in orders {
    // An equality-constrained column is constant in the filtered result.
    if field_fixed(table, order, constraints) {
      continue
    }
    while position < keys.length() &&
          field_fixed(table, keys[position], constraints) {
      position += 1
    }
    guard position < keys.length() else { return false }
    let field = keys[position]
    guard same_index_column(table, field.column, order.column) &&
      field.collation == order.collation &&
      (field.descending != reverse) == order.descending else {
      return false
    }
    position += 1
  }
  true
}

///|
fn secondary_range(
  select : Selection,
  context : Evaluation,
  table : Table,
  qualifier : String,
) -> IndexRange? raise SqlError {
  guard !select.orders.is_empty() else { return None }
  let orders : Array[IndexField] = []
  for order in select.orders {
    guard index_order_term(select, table, qualifier, order) is Some(term) else {
      return None
    }
    orders.push(term)
  }
  let constraints : Array[IndexConstraint] = []
  guard index_constraints(
    select.predicate,
    table,
    qualifier,
    context.params,
    constraints,
  ) else {
    return None
  }
  for object in context.store.objects {
    if object.kind != "index" ||
      !matches_identifier(object.table, identifier(table.name)) ||
      object.columns.any(n => n == "") {
      continue
    }
    if object.index_predicate is Some(predicate) &&
      !index_predicate_implied(predicate, select.predicate) {
      continue
    }
    let fields = index_fields(table, object)
    let reverse = if index_order_matches(
        table, fields, orders, constraints, false,
      ) {
      false
    } else if index_order_matches(table, fields, orders, constraints, true) {
      true
    } else {
      continue
    }
    if constraints.any(c => c.value is Null) {
      return Some({ rows: [], start: 0, end: 0, reverse, residual: false, })
    }
    let rows = index_rows_for_fields(
      context.store,
      table,
      object.name,
      fields,
      object.index_predicate,
    )
    let prefix : Array[Value] = []
    let mut start = 0
    let mut end = rows.length()
    for field in fields {
      let bounds = field_constraints(table, field, constraints)
      if bounds.is_empty() {
        break
      }
      // NULL is sorted, but never satisfies an ordinary comparison.
      if field.descending {
        end = end.min(
          index_prefix_bound(
            context.store,
            rows,
            fields,
            prefix + [Null],
            false,
          ),
        )
      } else {
        start = start.max(
          index_prefix_bound(context.store, rows, fields, prefix + [Null], true),
        )
      }
      for c in bounds {
        let lower = c.op == ">" || c.op == ">=" || c.op == "=" || c.op == "=="
        let upper = c.op == "<" || c.op == "<=" || c.op == "=" || c.op == "=="
        if lower {
          let n = index_prefix_bound(
            context.store,
            rows,
            fields,
            prefix + [c.value],
            if field.descending {
              c.op != ">"
            } else {
              c.op == ">"
            },
          )
          if field.descending {
            end = end.min(n)
          } else {
            start = start.max(n)
          }
        }
        if upper {
          let n = index_prefix_bound(
            context.store,
            rows,
            fields,
            prefix + [c.value],
            if field.descending {
              c.op == "<"
            } else {
              c.op != "<"
            },
          )
          if field.descending {
            start = start.max(n)
          } else {
            end = end.min(n)
          }
        }
      }
      let equal = bounds.filter(c => c.op == "=" || c.op == "==")
      if equal.is_empty() {
        break
      }
      prefix.push(equal[0].value)
    }
    let residual = fields.length() != 1 ||
      constraints.any(c => {
        !same_index_column(table, c.column, fields[0].column) ||
        c.collation != fields[0].collation
      })
    return Some({ rows, start, end: end.max(start), reverse, residual, })
  }
  None
}

///|
/// Deliberately conservative implication: identical conjuncts only.
fn index_predicate_implied(required : Expr, predicate : Expr) -> Bool {
  if required is Binary("and", a, b) {
    return index_predicate_implied(a, predicate) &&
      index_predicate_implied(b, predicate)
  }
  if @json.to_json(required) == @json.to_json(predicate) {
    return true
  }
  if predicate is Binary("and", a, b) {
    return index_predicate_implied(required, a) ||
      index_predicate_implied(required, b)
  }
  false
}
