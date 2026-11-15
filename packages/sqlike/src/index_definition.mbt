///|
/// Preserve byte-for-byte legacy images when no extended index metadata exists.
#derive(ToJson)
priv struct LegacySchemaObject {
  kind : String
  name : String
  table : String
  sql : String
  unique : Bool
  columns : Array[String]
  query : String
  selection : Selection?
}

///|
impl @json.ToJson for SchemaObject with fn to_json(self) {
  let legacy : LegacySchemaObject = {
    kind: self.kind,
    name: self.name,
    table: self.table,
    sql: self.sql,
    unique: self.unique,
    columns: self.columns,
    query: self.query,
    selection: self.selection,
  }
  let json = @json.to_json(legacy)
  if self.index_terms is Some(terms) && json is Object(fields) {
    fields["index_terms"] = @json.to_json(terms)
  }
  if self.index_predicate is Some(predicate) && json is Object(fields) {
    fields["index_predicate"] = @json.to_json(predicate)
  }
  if self.trigger is Some(trigger) && json is Object(fields) {
    fields["trigger"] = @json.to_json(trigger)
  }
  json
}

///|
fn index_fields(
  table : Table,
  object : SchemaObject,
) -> Array[IndexField] raise SqlError {
  index_keys(table, object).map(k => {
    guard k.column >= 0 else {
      fail("expression index has no column-only plan")
    }
    { column: k.column, collation: k.collation, descending: k.descending, }
  })
}

///|
priv struct IndexKey {
  column : Int32
  expression : Expr
  collation : String
  descending : Bool
}

///|
priv struct UniqueIndex {
  parts : Array[IndexKey]
  predicate : Expr?
}

///|
fn deterministic_index_expression(table : Table, e : Expr) -> Bool {
  match e {
    Literal(_) | TruthLiteral(_) => true
    Column("", name) =>
      table.columns.any(c => matches_identifier(c.name, identifier(name)))
    Unary(_, e) | Cast(e, _) => deterministic_index_expression(table, e)
    Collate(e, name) =>
      ["binary", "nocase", "rtrim"].contains(identifier(name)) &&
      deterministic_index_expression(table, e)
    Binary(_, a, b) =>
      deterministic_index_expression(table, a) &&
      deterministic_index_expression(table, b)
    Between(e, a, b) =>
      deterministic_index_expression(table, e) &&
      deterministic_index_expression(table, a) &&
      deterministic_index_expression(table, b)
    Case(base, arms, other) =>
      base.map(e => deterministic_index_expression(table, e)).unwrap_or(true) &&
      arms.all(p => {
        deterministic_index_expression(table, p.0) &&
        deterministic_index_expression(table, p.1)
      }) &&
      deterministic_index_expression(table, other)
    Call(name, args) =>
      [
        "abs", "typeof", "hex", "length", "lower", "upper", "ifnull", "coalesce",
        "json_extract", "substr", "substring", "instr", "replace", "trim", "ltrim",
        "rtrim", "concat", "concat_ws", "octet_length", "nullif", "iif", "if", "unicode",
        "char", "unhex", "sign", "round", "quote", "zeroblob", "in",
      ].contains(name) &&
      args.all(e => deterministic_index_expression(table, e))
    _ => false
  }
}

///|
fn index_keys(
  table : Table,
  object : SchemaObject,
) -> Array[IndexKey] raise SqlError {
  let terms = object.index_terms.unwrap_or_else(() => {
    object.columns.map(name => {
      expression: Column("", name),
      descending: false,
    })
  })
  guard !terms.is_empty() && terms.length() == object.columns.length() else {
    fail("invalid index terms")
  }
  terms.mapi((i, term) => {
    let (expression, collation) = if term.expression is Collate(e, name) {
      (e, Some(identifier(name)))
    } else {
      (term.expression, None)
    }
    guard deterministic_index_expression(table, term.expression) else {
      fail("non-deterministic or unsupported index expression")
    }
    let column = if expression is Column("", name) {
      guard identifier(name) == identifier(object.columns[i]) else {
        fail("invalid index column metadata")
      }
      column_index(table, name)
    } else {
      guard object.columns[i] == "" else {
        fail("invalid index expression metadata")
      }
      -2
    }
    let collation = collation.unwrap_or(
      if column >= 0 {
        table.columns[column].collation
      } else {
        "binary"
      },
    )
    guard ["binary", "nocase", "rtrim"].contains(collation) else {
      fail("unsupported index collation")
    }
    {
      column,
      expression: term.expression,
      collation,
      descending: term.descending,
    }
  })
}

///|
fn validate_index_definition(
  store : Store,
  table : Table,
  object : SchemaObject,
) -> Unit raise SqlError {
  let context = evaluation(
    store,
    [],
    row_environment(
      table,
      { id: 0L, values: Array::make(table.columns.length(), Null), },
      table.name,
    ),
  )
  for key in index_keys(table, object) {
    prepare_expression(key.expression, context, false, false)
  }
  if object.index_predicate is Some(e) {
    guard deterministic_index_expression(table, e) else {
      fail("non-deterministic or unsupported partial index predicate")
    }
    prepare_expression(e, context, false, false)
  }
}

///|
fn index_values(
  store : Store,
  table : Table,
  index : UniqueIndex,
  values : Array[Value],
) -> Array[Value]? raise SqlError {
  let needs_context = index.predicate is Some(_) ||
    index.parts.any(k => k.column < 0)
  let ctx = if needs_context {
    evaluation(
      store,
      [],
      row_environment(table, { id: 0L, values, }, table.name),
    )
  } else {
    evaluation(store, [], [])
  }
  if index.predicate is Some(e) && truth(evaluate(e, ctx)) != 1 {
    return None
  }
  Some(
    index.parts.map(k => {
      if k.column >= 0 {
        values[k.column]
      } else {
        evaluate(k.expression, ctx)
      }
    }),
  )
}

///|
fn object_index(
  object : SchemaObject,
  table : Table,
) -> UniqueIndex raise SqlError {
  { parts: index_keys(table, object), predicate: object.index_predicate, }
}

///|
fn find_index_conflict(
  store : Store,
  table : Table,
  index : UniqueIndex,
  values : Array[Value],
  excluded : Int64?,
) -> StoredRow? raise SqlError {
  if FEATURE_PRIMARY_INDEX &&
    index.predicate is None &&
    index.parts.length() == 1 {
    let ipk = integer_primary(table)
    if ipk >= 0 &&
      index.parts[0].column == ipk &&
      index.parts[0].collation == table.columns[ipk].collation &&
      values[ipk] is Integer(id) {
      return primary_row(primary_index(store, table), table, id).filter(row => {
        excluded != Some(row.id)
      })
    }
  }
  guard index_values(store, table, index, values) is Some(key) &&
    !key.any(v => v is Null) else {
    return None
  }
  if FEATURE_PRIMARY_INDEX &&
    index.predicate is None &&
    index.parts.map(p => p.column) == primary_key(table) &&
    index.parts.all(p => {
      p.column >= 0 && p.collation == table.columns[p.column].collation
    }) {
    if primary_value_key(table, values) is Some(key) {
      return primary_key_row(primary_index(store, table), table, key).filter(row => {
        excluded != Some(row.id)
      })
    }
  }
  for row in table.rows {
    if excluded == Some(row.id) {
      continue
    }
    if index_values(store, table, index, row.values) is Some(other) &&
      index.parts
      .mapi((i, part) => {
        compare_stored(store, key[i], other[i], part.collation) == 0
      })
      .all(v => v) {
      return Some(row)
    }
  }
  None
}

///|
fn index_field_value(row : StoredRow, field : IndexField) -> Value {
  if field.column < 0 {
    Integer(row.id)
  } else {
    row.values[field.column]
  }
}
