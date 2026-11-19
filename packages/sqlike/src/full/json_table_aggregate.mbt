///|
/// A narrow streaming alternative to relation materialization. Metadata and JSON
/// trees belong to this execution only, never a prepared query.
priv struct JsonTableAggregation {
  names : Array[String]
  columns : Array[RowProjection]
  states : Array[SumState]
  input : String
  root : String
  mut rows : Int32
}

///|
fn json_table_aggregate(
  select : Selection,
  context : Evaluation,
  output : Environment,
) -> Relation? raise SqlError {
  guard OPT_JSON_TABLE_AGGREGATE &&
    context.store.encoding.unwrap_or(1) == 1 &&
    select.sources.length() == 1 &&
    select.ctes.is_empty() &&
    context.ctes.is_empty() &&
    !select.distinct &&
    select.groups.is_empty() &&
    select.having is Literal(Integer(1L)) &&
    select.predicate is Literal(Integer(1L)) &&
    select.orders.is_empty() else {
    return None
  }
  let source = select.sources[0]
  guard json_table_source(source) else { return None }
  let (_, _, _, condition) = json_table_parts(source)
  guard condition is Literal(Integer(1L)) &&
    !source.left &&
    source.right != Some(true) &&
    source.natural != Some(true) &&
    source.using_columns.unwrap_or([]).is_empty() else {
    return None
  }
  let names : Array[String] = []
  let columns : Array[RowProjection] = []
  let layout = json_table_template(source)
  for p in select.projections {
    guard p.expression is Call(name, [arg]) &&
      ["count", "sum", "total", "avg"].contains(name) else {
      return None
    }
    let field = match arg {
      Star(_) => {
        guard name == "count" else { return None }
        Constant(Integer(1L))
      }
      Literal(v) => Constant(v)
      Column(q, n) => {
        guard find_binding(layout, q, n) is Some(found) else { return None }
        let index = layout.search_by(b => b.name == found.name).unwrap()
        // IDs and paths need the JSONB layout; retain the general visitor.
        guard [0, 1, 2, 3, 8, 9, 10, 11, 12].contains(index) else {
          return None
        }
        Stored(index)
      }
      _ => return None
    }
    names.push(name)
    columns.push(field)
  }
  guard !names.is_empty() &&
    rowid_value(select.limit, context.params) is Some(limit) &&
    rowid_value(select.offset, context.params) is Some(offset) else {
    return None
  }
  if limit == 0L {
    return Some({ rows: [], template: output, })
  }
  prepare_json_table(source, context)
  let (name, input_expr, root_expr, _) = json_table_parts(source)
  let input = evaluate(input_expr, context)
  let root = evaluate(root_expr, context)
  let states = names.map(_ => sum_state())
  if !(input is Null) {
    guard !(input is Blob(_)) else {
      fail("unsupported JSON table BLOB/JSONB input")
    }
    let input = checked_text_value(input)
    let budget : JsonTableBudget = {
      bytes: @utf8.encode(input).length(),
      nodes: 0,
      paths: 0,
    }
    guard budget.bytes <= 16777216 else {
      fail("JSON table input resource limit")
    }
    let json = parse_sql_json(input)
    json_table_check_nodes(json, budget, 0)
    if !(root is Null) {
      let root = checked_text_value(root)
      let parts = json_table_root(root)
      let selected = if parts.is_empty() {
        Some(json)
      } else {
        match (json, parts[0]) {
          (Object(fields), Key(k)) => json_get(fields, k)
          (Array(items), Index(i)) =>
            if i < items.length() {
              Some(items[i])
            } else {
              None
            }
          (Array(items), FromEnd(n)) =>
            if n > 0 && n <= items.length() {
              Some(items[items.length() - n])
            } else {
              None
            }
          _ => None
        }
      }
      if selected is Some(selected) {
        let recursive = name == "json_tree"
        let container = selected is Array(_) || selected is Object(_)
        let key : Value = if recursive && !parts.is_empty() {
          match parts[0] {
            Key(k) => Text(k)
            Index(n) => Integer(n.to_int64())
            FromEnd(_) => Integer(0L)
          }
        } else {
          Null
        }
        let root_bytes = @utf8.encode(root).length()
        json_table_accumulate(
          selected,
          key,
          root_bytes,
          if recursive && !parts.is_empty() {
            1
          } else {
            root_bytes
          },
          recursive,
          recursive || !container,
          { names, columns, states, input, root, rows: 0, },
          budget,
        )
      }
    }
  }
  let values : Array[Value] = names.mapi((i, name) => {
    if name == "count" {
      Integer(states[i].count)
    } else {
      states[i].finish(name)
    }
  })
  Some({
    template: output,
    rows: if offset > 0L {
      []
    } else {
      [output.mapi((i, b) => { ..b, value: values[i], })]
    },
  })
}

///|
/// Preserve the general visitor's input-wide node/depth guard, even for missing
/// roots. No parallel JSONB node tree is needed by this aggregate path.
fn json_table_check_nodes(
  json : SqlJson,
  budget : JsonTableBudget,
  depth : Int32,
) -> Unit raise SqlError {
  budget.nodes += 1
  guard budget.nodes <= 200000 && depth <= 128 else {
    fail("JSON table node/depth resource limit")
  }
  match json {
    Array(items) =>
      for v in items {
        json_table_check_nodes(v, budget, depth + 1)
      }
    Object(fields) =>
      for (_, v) in fields {
        json_table_check_nodes(v, budget, depth + 1)
      }
    _ => ()
  }
}

///|
fn json_table_accumulate(
  json : SqlJson,
  key : Value,
  fullkey_bytes : Int32,
  path_bytes : Int32,
  recursive : Bool,
  emit : Bool,
  plan : JsonTableAggregation,
  budget : JsonTableBudget,
) -> Unit raise SqlError {
  if emit {
    guard plan.rows < 100000 else { fail("JSON table row resource limit") }
    budget.paths += fullkey_bytes + path_bytes
    guard budget.paths <= 16777216 else {
      fail("JSON table path resource limit")
    }
    let container = json is Array(_) || json is Object(_)
    let needs_value = plan.columns.any(c => {
      c is Stored(1) || (c is Stored(3) && !container)
    })
    let scalar = if needs_value { json_sql_value(json) } else { Value::Null }
    for i, column in plan.columns {
      let value : Value = match column {
        Constant(v) => v
        Stored(0) => key
        Stored(1) => scalar
        Stored(2) => Text(json_table_type(json))
        Stored(3) => if container { Null } else { scalar }
        Stored(8) => Text(plan.input)
        Stored(9) => Text(plan.root)
        _ => Integer(plan.rows.to_int64())
      }
      if plan.names[i] == "count" {
        if !(value is Null) {
          plan.states[i].count += 1L
        }
      } else {
        plan.states[i].add(value)
      }
    }
    plan.rows += 1
  }
  if emit && !recursive {
    return
  }
  match json {
    Array(items) =>
      for i, value in items {
        json_table_accumulate(
          value,
          Integer(i.to_int64()),
          fullkey_bytes + i.to_string().length() + 2,
          fullkey_bytes,
          recursive,
          true,
          plan,
          budget,
        )
      }
    Object(fields) =>
      for (key, value) in fields {
        let append = @utf8.encode(json_table_label(key)).length()
        json_table_accumulate(
          value,
          Text(key.text),
          fullkey_bytes + append,
          fullkey_bytes,
          recursive,
          true,
          plan,
          budget,
        )
      }
    _ => ()
  }
}
