///|
/// Per-SELECT limits. No parsed trees, rows or bindings survive an execution.
priv struct JsonTableBudget {
  mut bytes : Int32
  mut nodes : Int32
  mut paths : Int32
}

///|
priv struct JsonTableNode {
  json : SqlJson
  payload : Int32
  children : Array[JsonTableNode]
}

///|
fn json_table_source(source : Source) -> Bool {
  source.name.has_prefix("\u{0}json:")
}

///|
fn json_table_root(path : String) -> Array[JsonSegment] raise SqlError {
  guard !path.contains("\u{0}") && !path.contains("\\") else {
    fail("unsupported JSON table root path")
  }
  let parts = json_path(path)
  guard parts.length() <= 1 else {
    fail("unsupported multi-segment JSON table root")
  }
  if !parts.is_empty() && !(parts[0] is Key(_)) {
    let bytes = @utf8.encode(path)
    let start = if path.has_prefix("$[#-") { 4 } else { 2 }
    if path != "$[#]" {
      guard bytes[start:bytes.length() - 1]
        .iter()
        .all(c => c >= b'0' && c <= b'9') else {
        fail("bad JSON path")
      }
    }
  }

  parts
}

///|
/// TVF subtype can survive native query flattening. Across a materialization
/// boundary the current evaluator rejects implicit propagation; json(x) is explicit.
fn json_table_origin(e : Expr, ctx : Evaluation) -> Bool raise SqlError {
  match e {
    Column(q, n) => resolve_context(ctx, q, n).json_value > 0
    TruthLiteral(v) =>
      find_context(ctx, "", if v { "true" } else { "false" })
      .map(b => b.json_value > 0)
      .unwrap_or(false)
    Window(_, args, _, _, _) => args.any(e => json_table_origin(e, ctx))
    Unary(_, e) | Cast(e, _) | Collate(e, _) => json_table_origin(e, ctx)
    // RAISE's action is an internal identifier, not a column expression.
    Call("raise", args) => args.length() > 1 && json_table_origin(args[1], ctx)
    Call(_, args) => args.any(e => json_table_origin(e, ctx))
    Binary(_, a, b) => json_table_origin(a, ctx) || json_table_origin(b, ctx)
    Between(e, a, b) =>
      json_table_origin(e, ctx) ||
      json_table_origin(a, ctx) ||
      json_table_origin(b, ctx)
    Case(base, arms, other) =>
      base.map(e => json_table_origin(e, ctx)).unwrap_or(false) ||
      arms.any(p => json_table_origin(p.0, ctx) || json_table_origin(p.1, ctx)) ||
      json_table_origin(other, ctx)
    ScalarSelect(select) | Exists(select) =>
      selection_template(select, ctx.nested()).any(b => b.json_value > 0)
    InSelect(e, select) =>
      json_table_origin(e, ctx) ||
      selection_template(select, ctx.nested()).any(b => b.json_value > 0)
    _ => false
  }
}

///|
fn json_table_ambiguous(e : Expr, ctx : Evaluation) -> Bool raise SqlError {
  match e {
    Column(q, n) => resolve_context(ctx, q, n).json_value == 2
    TruthLiteral(v) =>
      find_context(ctx, "", if v { "true" } else { "false" })
      .map(b => b.json_value == 2)
      .unwrap_or(false)
    Window(_, args, _, _, _) => args.any(e => json_table_origin(e, ctx))
    Unary(_, e) | Cast(e, _) | Collate(e, _) => json_table_ambiguous(e, ctx)
    Call("min", _) | Call("max", _) => json_table_origin(e, ctx)
    Call("coalesce", args)
    | Call("ifnull", args)
    | Call("nullif", args)
    | Call("if", args)
    | Call("iif", args) => args.any(e => json_table_ambiguous(e, ctx))
    Case(_, arms, other) =>
      arms.any(p => json_table_ambiguous(p.1, ctx)) ||
      json_table_ambiguous(other, ctx)
    ScalarSelect(select) =>
      selection_template(select, ctx.nested()).any(b => b.json_value > 0)
    _ => false
  }
}

///|
fn json_table_parts(
  source : Source,
) -> (String, Expr, Expr, Expr) raise SqlError {
  guard FEATURE_JSON_TABLE else { fail("feature disabled: jsonTableFunctions") }
  guard source.on
    is Call("$json-table", [Literal(Text(name)), input, root, condition]) &&
    ["json_each", "json_tree"].contains(name) &&
    source.name == "\u{0}json:" + name else {
    fail("invalid JSON table metadata")
  }
  (name, input, root, condition)
}

///|
fn json_table_template(source : Source) -> Environment {
  [
    "key", "value", "type", "atom", "id", "parent", "fullkey", "path", "json", "root",
    "rowid", "_rowid_", "oid",
  ].mapi((i, name) => {
    ..binding(name, Null),
    qualifier: source.qualifier,
    hidden: i >= 8,
    json_value: if i == 1 {
      1
    } else {
      0
    },
    affinity: if ["rowid", "_rowid_", "oid"].contains(name) {
      "integer"
    } else if ["type", "fullkey", "path", "root"].contains(name) {
      "text"
    } else {
      ""
    },
  })
}

///|
fn prepare_json_table(
  source : Source,
  context : Evaluation,
) -> Unit raise SqlError {
  let (name, input, root, _) = json_table_parts(source)
  guard !context.store.tables.any(t => matches_identifier(t.name, name)) &&
    !context.store.objects.any(o => {
      o.kind == "view" && matches_identifier(o.name, name)
    }) &&
    !context.ctes.contains(name) else {
    fail("JSON table function is shadowed: " + name)
  }
  prepare_expression(
    input,
    { ..context, forbid_json_inputs: false, },
    false,
    false,
  )
  if root is Literal(Text(path)) {
    ignore(json_table_root(path))
  }
  prepare_expression(
    root,
    { ..context, forbid_json_inputs: false, },
    false,
    false,
  )
}

///|
fn json_table_joins(sources : Array[Source]) -> Unit raise SqlError {
  if sources.any(json_table_source) && sources.any(s => s.right == Some(true)) {
    fail("unsupported RIGHT/FULL JOIN with JSON tables")
  }
}

///|
fn json_table_header(payload : Int32) -> Int32 {
  if payload <= 11 {
    1
  } else if payload <= 255 {
    2
  } else if payload <= 65535 {
    3
  } else {
    5
  }
}

///|
fn JsonTableNode::size(node : JsonTableNode) -> Int32 {
  json_table_header(node.payload) + node.payload
}

///|
fn json_table_string_size(text : String, source : String?) -> Int32 {
  let length = @utf8.encode(json_string_source(text, source)).length() - 2
  json_table_header(length) + length
}

///|
fn json_table_node(
  json : SqlJson,
  budget : JsonTableBudget,
  depth : Int32,
) -> JsonTableNode raise SqlError {
  budget.nodes += 1
  guard budget.nodes <= 200000 && depth <= 128 else {
    fail("JSON table node/depth resource limit")
  }
  let children : Array[JsonTableNode] = []
  let payload = match json {
    Array(items) => {
      for item in items {
        children.push(json_table_node(item, budget, depth + 1))
      }
      children.fold(init=0, (n, c) => n + c.size())
    }
    Object(fields) => {
      let mut size = 0
      for (key, value) in fields {
        let child = json_table_node(value, budget, depth + 1)
        children.push(child)
        size += json_table_string_size(key.text, key.source) + child.size()
      }
      size
    }
    String(text, source) =>
      @utf8.encode(json_string_source(text, source)).length() - 2
    Number(_, _) => @utf8.encode(json.stringify()).length()
    _ => 0
  }
  { json, payload, children, }
}

///|
fn json_table_type(json : SqlJson) -> String {
  match json {
    Null => "null"
    True => "true"
    False => "false"
    String(_, _) => "text"
    Array(_) => "array"
    Object(_) => "object"
    Number(_, _) => {
      let raw = json.stringify()
      if raw.contains(".") || raw.contains("e") || raw.contains("E") {
        "real"
      } else {
        "integer"
      }
    }
  }
}

///|
fn json_table_label(key : SqlJsonKey) -> String {
  let raw = json_string_source(key.text, key.source)
  let bytes = @utf8.encode(raw)
  let text = bytes[1:bytes.length() - 1]
  let alpha = fn(c : Byte) {
    (c >= b'a' && c <= b'z') || (c >= b'A' && c <= b'Z')
  }
  if !text.is_empty() &&
    alpha(text[0]) &&
    text.iter().all(c => alpha(c) || (c >= b'0' && c <= b'9')) {
    "." + key.text
  } else {
    "." + raw
  }
}

///|
fn json_table_emit(
  node : JsonTableNode,
  id : Int32,
  key : Value,
  parent : Value,
  fullkey : String,
  path : String,
  input : String,
  root : String,
  layout : Environment,
  rows : Array[Environment],
  budget : JsonTableBudget,
) -> Unit raise SqlError {
  guard rows.length() < 100000 else { fail("JSON table row resource limit") }
  budget.paths += @utf8.encode(fullkey).length() + @utf8.encode(path).length()
  guard budget.paths <= 16777216 else { fail("JSON table path resource limit") }
  let container = node.json is Array(_) || node.json is Object(_)
  let value = json_sql_value(node.json)
  let rowid : Value = Integer(rows.length().to_int64())
  let values = [
    key,
    value,
    Text(json_table_type(node.json)),
    if container {
      Value::Null
    } else {
      value
    },
    Integer(id.to_int64()),
    parent,
    Text(fullkey),
    Text(path),
    Text(input),
    Text(root),
    rowid,
    rowid,
    rowid,
  ]
  rows.push(
    layout.mapi((i, b) => {
      ..b,
      value: values[i],
      json_value: if i == 1 && container {
        1
      } else {
        0
      },
    }),
  )
}

///|
fn json_table_walk(
  node : JsonTableNode,
  id : Int32,
  value_offset : Int32,
  key : Value,
  parent : Value,
  fullkey : String,
  path : String,
  input : String,
  root : String,
  layout : Environment,
  recursive : Bool,
  emit : Bool,
  rows : Array[Environment],
  budget : JsonTableBudget,
) -> Unit raise SqlError {
  if emit {
    json_table_emit(
      node, id, key, parent, fullkey, path, input, root, layout, rows, budget,
    )
  }
  if emit && !recursive {
    return
  }
  let mut offset = value_offset + json_table_header(node.payload)
  for i, child in node.children {
    let (key, append, label_size) = match node.json {
      Object(fields) => {
        let label = fields[i].0
        (
          Value::Text(label.text),
          json_table_label(label),
          json_table_string_size(label.text, label.source),
        )
      }
      _ => (Value::Integer(i.to_int64()), "[" + i.to_string() + "]", 0)
    }
    json_table_walk(
      child,
      offset,
      offset + label_size,
      key,
      if recursive {
        Integer(id.to_int64())
      } else {
        Null
      },
      fullkey + append,
      fullkey,
      input,
      root,
      layout,
      recursive,
      true,
      rows,
      budget,
    )
    offset += label_size + child.size()
  }
}

///|
fn json_table_rows(
  source : Source,
  context : Evaluation,
  budget : JsonTableBudget,
) -> Array[Environment] raise SqlError {
  let (name, input_expr, root_expr, _) = json_table_parts(source)
  let input = evaluate(input_expr, context)
  let root = evaluate(root_expr, context)
  if input is Null {
    return []
  }
  guard !(input is Blob(_)) else {
    fail("unsupported JSON table BLOB/JSONB input")
  }
  let input = checked_text_value(input)
  budget.bytes += @utf8.encode(input).length()
  guard budget.bytes <= 16777216 else {
    fail("JSON table input resource limit")
  }
  let node = json_table_node(parse_sql_json(input), budget, 0)
  if root is Null {
    return []
  }
  let root = checked_text_value(root)
  let parts = json_table_root(root)
  let mut selected = node
  let mut id = 0
  let mut value_offset = 0
  let mut key : Value = Null
  if !parts.is_empty() {
    let mut offset = json_table_header(node.payload)
    let index = match (node.json, parts[0]) {
      (Object(fields), Key(k)) => fields.search_by(p => p.0.text == k)
      (Array(items), Index(n)) =>
        if n < items.length() {
          Some(n)
        } else {
          None
        }
      (Array(items), FromEnd(n)) =>
        if n > 0 && n <= items.length() {
          Some(items.length() - n)
        } else {
          None
        }
      _ => None
    }
    guard index is Some(index) else { return [] }
    for i, child in node.children {
      let label_size = match node.json {
        Object(fields) =>
          json_table_string_size(fields[i].0.text, fields[i].0.source)
        _ => 0
      }
      if i == index {
        selected = child
        id = offset
        value_offset = offset + label_size
        key = match parts[0] {
          Key(k) => Text(k)
          Index(n) => Integer(n.to_int64())
          FromEnd(_) => Integer(0L)
        }
        break
      }
      offset += label_size + child.size()
    }
  }
  let rows : Array[Environment] = []
  let recursive = name == "json_tree"
  let container = selected.json is Array(_) || selected.json is Object(_)
  json_table_walk(
    selected,
    id,
    value_offset,
    if recursive {
      key
    } else {
      Null
    },
    Null,
    root,
    if recursive && !parts.is_empty() {
      "$"
    } else {
      root
    },
    input,
    root,
    json_table_template(source),
    recursive,
    recursive || !container,
    rows,
    budget,
  )
  rows
}

///|
fn json_table_join(
  source : Source,
  input : Array[Environment],
  layout : Environment,
  context : Evaluation,
  budget : JsonTableBudget,
  predicate : Expr,
) -> Relation raise SqlError {
  prepare_json_table(source, { ..context, row: layout, })
  let (_, _, _, condition) = json_table_parts(source)
  let empty = json_table_template(source)
  prepare_expression(
    condition,
    { ..context, row: layout + empty, forbid_json_inputs: true, },
    false,
    false,
  )
  let pairs = using_pairs(source, layout, empty)
  let output : Array[Environment] = []
  for left in input {
    if !json_table_guard(predicate, source, { ..context, row: left, }) {
      continue
    }
    let mut matched = false
    for right in json_table_rows(source, { ..context, row: left, }, budget) {
      let joined = left + right
      if truth(evaluate(condition, { ..context, row: joined, })) == 1 &&
        using_matches(left, right, pairs, context) {
        output.push(using_row(source, left, right, pairs))
        matched = true
      }
      guard output.length() <= 100000 else { fail("SQL result resource limit") }
    }
    if source.left && !matched {
      output.push(using_row(source, left, empty, pairs))
    }
    guard output.length() <= 100000 else { fail("SQL result resource limit") }
  }
  { rows: output, template: using_row(source, layout, empty, pairs), }
}

///|
/// Only a qualified preceding-column guard is pushed. It cannot bind a column
/// from this/later TVF or accidentally resolve an unqualified correlated name.
fn json_table_guard(
  predicate : Expr,
  source : Source,
  ctx : Evaluation,
) -> Bool raise SqlError {
  match predicate {
    Binary("and", a, b) =>
      json_table_guard(a, source, ctx) && json_table_guard(b, source, ctx)
    Call("json_valid", [Column(q, n)]) =>
      if q != "" &&
        !matches_identifier(q, identifier(source.qualifier)) &&
        find_binding(ctx.row, q, n) is Some(_) {
        truth(evaluate(predicate, ctx)) == 1
      } else {
        true
      }
    _ => true
  }
}
