///|
/// A row carries source/affinity metadata independently of its stored values.
priv enum JoinColumn {
  SuppressedJoinColumn
  MergedJoinColumn(Value, String, String)
}

///|
priv struct Binding {
  qualifier : String
  name : String
  display_name : String
  value : Value
  affinity : String
  collation : String
  hidden : Bool
  join_column : JoinColumn?
}

///|
type Environment = Array[Binding]

///|
priv struct Evaluation {
  store : Store
  params : Array[Value]
  row : Environment
  group : Array[Environment]?
  position : Int32
  outer : Array[Environment]
  ctes : Map[String, Relation]
  depth : Int32
  window_values : Map[String, Value]
}

///|
priv struct QueryRow {
  output : Environment
  context : Evaluation
  keys : Array[Value]
}

///|
fn binding(name : String, value : Value) -> Binding {
  {
    qualifier: "",
    name,
    display_name: name,
    value,
    affinity: "",
    collation: "binary",
    hidden: false,
    join_column: None,
  }
}

///|
fn find_binding(
  row : Environment,
  qualifier : String,
  name : String,
) -> Binding? raise SqlError {
  let key = identifier(name)
  let scope = identifier(qualifier)
  let mut found : Binding? = None
  let mut ambiguous = false
  for original in row {
    let b = if scope == "" {
      guard unqualified_binding(original) is Some(value) else { continue }
      value
    } else {
      original
    }
    if !matches_identifier(b.name, key) {
      continue
    }
    if scope == "" {
      if matches_identifier(b.qualifier, "excluded") {
        continue
      }
      // Projected columns take precedence; retain the first duplicate label.
      if b.qualifier == "" {
        return Some(b)
      }
    } else if !matches_identifier(b.qualifier, scope) {
      continue
    }
    if found is Some(_) {
      ambiguous = true
    } else {
      found = Some(b)
    }
  }
  guard !ambiguous else { fail("ambiguous column name: " + name) }
  found
}

///|
fn find_context(
  ctx : Evaluation,
  qualifier : String,
  name : String,
) -> Binding? raise SqlError {
  if find_binding(ctx.row, qualifier, name) is Some(b) {
    return Some(b)
  }
  for row in ctx.outer {
    if find_binding(row, qualifier, name) is Some(b) {
      return Some(b)
    }
  }
  None
}

///|
fn resolve_context(
  ctx : Evaluation,
  qualifier : String,
  name : String,
) -> Binding raise SqlError {
  match find_context(ctx, qualifier, name) {
    Some(b) => b
    None =>
      fail(
        "no such column: " +
        (if qualifier == "" { "" } else { qualifier + "." }) +
        name,
      )
  }
}

///|
fn Evaluation::nested(ctx : Evaluation) -> Evaluation {
  {
    ..ctx,
    row: [],
    window_values: Map([]),
    outer: [ctx.row] + ctx.outer,
    group: None,
    position: 0,
    depth: ctx.depth + 1,
  }
}

///|
fn expression_affinity(
  expression : Expr,
  context : Evaluation,
) -> String raise SqlError {
  match expression {
    Column(q, n) => resolve_context(context, q, n).affinity
    TruthLiteral(value) =>
      find_context(context, "", if value { "true" } else { "false" })
      .map(b => b.affinity)
      .unwrap_or("")
    Cast(_, name) => name
    Collate(e, _) => expression_affinity(e, context)
    ScalarSelect(select) =>
      selection_template(select, context.nested())[0].affinity
    _ => ""
  }
}

///|
fn expression_collation(
  expression : Expr,
  context : Evaluation,
) -> String raise SqlError {
  match expression {
    Cast(e, _) | Unary("+", e) => expression_collation(e, context)
    Collate(_, name) => name
    Column(q, n) => resolve_context(context, q, n).collation
    TruthLiteral(value) =>
      find_context(context, "", if value { "true" } else { "false" })
      .map(b => b.collation)
      .unwrap_or("binary")
    ScalarSelect(select) =>
      selection_template(select, context.nested())[0].collation
    _ => "binary"
  }
}

///|
fn evaluate(expression : Expr, ctx : Evaluation) -> Value raise SqlError {
  match expression {
    Literal(value) => expression_value(value, ctx.store)
    CurrentTime(name) => {
      guard FEATURE_DATETIME else { fail("feature disabled: dateTime") }
      datetime_call(name, [Text("now")], ctx.store.triggers.clock)
    }
    TruthLiteral(value) =>
      match find_context(ctx, "", if value { "true" } else { "false" }) {
        Some(b) => b.value
        None => boolean(value)
      }
    Parameter(index) => {
      guard index < ctx.params.length() else { fail("missing SQL binding") }
      expression_value(ctx.params[index], ctx.store)
    }
    Column(qualifier, name) =>
      expression_value(resolve_context(ctx, qualifier, name).value, ctx.store)
    Star(_) => fail("SQL * outside result columns or COUNT")
    Cast(e, name) => {
      guard name != "blob" || ctx.store.encoding.unwrap_or(1) == 1 else {
        fail("unsupported SQL: TEXT to BLOB cast in UTF-16 database")
      }
      cast_value(evaluate(e, ctx), name)
    }
    Collate(e, _) => evaluate(e, ctx)
    Window(_, _, _, _, _) => {
      guard FEATURE_WINDOWS else { fail("feature disabled: windowFunctions") }
      ctx.window_values
      .get(@json.to_json(expression).stringify())
      .unwrap_or(Null)
    }
    RowNumber(_) => {
      guard FEATURE_WINDOWS else { fail("feature disabled: windowFunctions") }
      Integer((ctx.position + 1).to_int64())
    }
    Unary(op, e) => unary_value(op, evaluate(e, ctx))
    Binary(op, left, right) => {
      let a = evaluate(left, ctx)
      let b = evaluate(right, ctx)
      if comparison_operator(op) {
        compare_expression(op, left, a, right, b, ctx)
      } else {
        binary_value(op, a, b)
      }
    }
    Between(e, low, high) => {
      let value = evaluate(e, ctx)
      let a = compare_expression(">=", e, value, low, evaluate(low, ctx), ctx)
      let b = compare_expression("<=", e, value, high, evaluate(high, ctx), ctx)
      if truth(a) == 0 || truth(b) == 0 {
        Integer(0L)
      } else if a is Null || b is Null {
        Null
      } else {
        Integer(1L)
      }
    }
    Case(base, arms, otherwise) => {
      let value = base.map(e => evaluate(e, ctx))
      for (condition, result) in arms {
        let matches = if base is Some(e) && value is Some(value) {
          truth(
            compare_expression(
              "=",
              e,
              value,
              condition,
              evaluate(condition, ctx),
              ctx,
            ),
          ) ==
          1
        } else {
          truth(evaluate(condition, ctx)) == 1
        }
        if matches {
          return evaluate(result, ctx)
        }
      }
      evaluate(otherwise, ctx)
    }
    InSelect(value, select) => {
      let left = evaluate(value, ctx)
      let relation = select_relation_in(select, ctx.nested(), false)
      let mut unknown = false
      for row in relation.rows {
        let result = compare_expression(
          "=",
          value,
          left,
          ScalarSelect(select),
          row[0].value,
          ctx,
        )
        if truth(result) == 1 {
          return Integer(1L)
        }
        if result is Null {
          unknown = true
        }
      }
      if unknown {
        Null
      } else {
        Integer(0L)
      }
    }
    ScalarSelect(select) => {
      let relation = select_relation_in(select, ctx.nested(), false)
      if relation.rows.is_empty() {
        Null
      } else {
        relation.rows[0][0].value
      }
    }
    Exists(select) =>
      boolean(!select_relation_in(select, ctx.nested(), true).rows.is_empty())
    Call(name, args) => evaluate_call(name, args, ctx)
  }
}

///|
fn evaluate_call(
  name : String,
  args : Array[Expr],
  ctx : Evaluation,
) -> Value raise SqlError {
  if CAP_FUNCTION_RAISE && name == "raise" {
    guard !ctx.store.triggers.active.is_empty() else {
      fail("RAISE() may only be used within a trigger-program")
    }
    if trigger_raise_action(args) == "ignore" {
      raise TriggerIgnore
    }
    raise TriggerAbort(text_value(evaluate(args[1], ctx)))
  }
  if FEATURE_SQL_JSON &&
    CAP_FUNCTION_JSON_AGGREGATE &&
    (name == "json_group_array" || name == "json_group_object") {
    return json_aggregate(name, args, ctx)
  }
  if CAP_FUNCTION_GROUP_CONCAT &&
    (name == "group_concat" || name == "string_agg") {
    return group_concat(args, ctx)
  }
  if CAP_FUNCTION_AGGREGATES &&
    ["count", "sum", "total", "avg", "max", "min"].contains(name) &&
    args.length() == 1 {
    let group = ctx.group.unwrap_or([ctx.row])
    let values : Array[Value] = []
    let input = filter_input(args[0])
    let distinct = input is Call("$distinct", _)
    let arg = match input {
      Call("$distinct", [e]) => e
      _ => input
    }
    let predicate = aggregate_predicate(args[0])
    for row in group {
      let here = if arg is Star(_) && predicate is None {
        ctx
      } else {
        { ..ctx, row, group: None, }
      }
      if predicate is Some(p) && truth(evaluate(p, here)) != 1 {
        continue
      }
      let value : Value = if arg is Star(_) {
        Integer(1L)
      } else {
        evaluate(arg, here)
      }
      if !(value is Null) &&
        (
          !distinct ||
          !values.any(v => {
            compare_stored(ctx.store, v, value, expression_collation(arg, ctx)) ==
            0
          })
        ) {
        values.push(value)
      }
    }
    if name == "count" {
      return Integer(values.length().to_int64())
    }
    if values.is_empty() {
      return if name == "total" { Real(0) } else { Null }
    }
    if name == "max" || name == "min" {
      let mut result = values[0]
      for v in values {
        let c = compare_stored(
          ctx.store,
          v,
          result,
          expression_collation(arg, ctx),
        )
        if (name == "max" && c > 0) || (name == "min" && c < 0) {
          result = v
        }
      }
      return result
    }
    let sum = sum_state()
    for value in values {
      sum.add(value)
    }
    return sum.finish(name)
  }

  if CAP_FUNCTION_COALESCE && (name == "coalesce" || name == "ifnull") {
    for e in args {
      let value = evaluate(e, ctx)
      if !(value is Null) {
        return value
      }
    }
    return Null
  }
  if CAP_FUNCTION_CONDITIONAL && (name == "iif" || name == "if") {
    let mut index = 0
    while index + 1 < args.length() {
      if truth(evaluate(args[index], ctx)) == 1 {
        return evaluate(args[index + 1], ctx)
      }
      index += 2
    }
    return if index < args.length() { evaluate(args[index], ctx) } else { Null }
  }
  let values = args.map(e => evaluate(e, ctx))
  match name {
    "like" => {
      guard CAP_FUNCTION_LIKE else { fail("catalog capability disabled: like") }
      like_value(values)
    }
    "min" | "max" => {
      guard CAP_FUNCTION_EXTREMA else {
        fail("catalog capability disabled: extrema")
      }
      if values.any(v => v is Null) {
        return Null
      }
      let collation = function_collation(args, ctx, false).unwrap_or("binary")
      let mut best = values[0]
      for v in values[1:] {
        let order = compare_stored(ctx.store, v, best, collation)
        if (name == "min" && order <= 0) || (name == "max" && order > 0) {
          best = v
        }
      }
      best
    }
    "nullif" => {
      guard CAP_FUNCTION_NULLIF else {
        fail("catalog capability disabled: nullif")
      }
      let mut collation = "binary"
      for arg in args {
        if arg is Column(_, _) || arg is Collate(_, _) {
          collation = expression_collation(arg, ctx)
          break
        }
      }
      if values[0] is Null ||
        (
          !(values[1] is Null) &&
          compare_stored(ctx.store, values[0], values[1], collation) == 0
        ) {
        Null
      } else {
        values[0]
      }
    }
    "changes" => {
      guard CAP_FUNCTION_CONNECTION_COUNTERS else {
        fail("catalog capability disabled: changes")
      }
      guard values.is_empty() else {
        fail("wrong number of arguments: changes")
      }
      Integer(
        (if ctx.store.triggers.data_depth > 0 {
          ctx.store.triggers.prior_changes
        } else {
          connection_changes(ctx.store)
        }).to_int64(),
      )
    }
    "last_insert_rowid" => {
      guard CAP_FUNCTION_CONNECTION_COUNTERS else {
        fail("catalog capability disabled: last_insert_rowid")
      }
      guard values.is_empty() else {
        fail("wrong number of arguments: last_insert_rowid")
      }
      Integer(ctx.store.last_rowid)
    }
    "coalesce" | "ifnull" => {
      guard CAP_FUNCTION_COALESCE else {
        fail("catalog capability disabled: coalesce")
      }
      guard values.length() >= 2 && (name != "ifnull" || values.length() == 2) else {
        fail("wrong number of arguments: coalesce")
      }
      for value in values {
        if !(value is Null) {
          return value
        }
      }
      Null
    }
    "typeof" => {
      guard CAP_FUNCTION_TYPEOF else {
        fail("catalog capability disabled: typeof")
      }
      guard values.length() == 1 else {
        fail("wrong number of arguments: typeof")
      }
      Text(
        match values[0] {
          Null => "null"
          Integer(_) => "integer"
          Real(_) => "real"
          Text(_) => "text"
          Blob(_) => "blob"
        },
      )
    }
    "hex" => {
      guard CAP_FUNCTION_HEX else { fail("catalog capability disabled: hex") }
      guard values.length() == 1 else { fail("wrong number of arguments: hex") }
      let bytes = match values[0] {
        Blob(b) => b
        Text(s) =>
          if ctx.store.encoding.unwrap_or(1) == 1 {
            @utf8.encode(s)
          } else {
            @utf16.encode(
              s,
              endianness=if ctx.store.encoding == Some(2) {
                Little
              } else {
                Big
              },
            )
          }
        other => @utf8.encode(text_value(other))
      }
      let hex = @buffer.Buffer()
      let digits = b"0123456789ABCDEF"
      for b in bytes {
        hex.write_byte(digits[b.to_int() / 16])
        hex.write_byte(digits[b.to_int() % 16])
      }
      Text(@utf8.decode_lossy(hex.to_bytes()))
    }
    "length" => {
      guard CAP_FUNCTION_LENGTH else {
        fail("catalog capability disabled: length")
      }
      guard values.length() == 1 else {
        fail("wrong number of arguments: length")
      }
      match values[0] {
        Null => Null
        Blob(b) => Integer(b.length().to_int64())
        v => {
          let mut count = 0L
          for c in text_value(v).iter() {
            if c == '\u{0}' {
              break
            }
            count += 1L
          }
          Integer(count)
        }
      }
    }
    "lower" | "upper" => {
      guard CAP_FUNCTION_CASE_CONVERSION else {
        fail("catalog capability disabled: case conversion")
      }
      guard values.length() == 1 else {
        fail("wrong number of arguments: case")
      }
      if values[0] is Null {
        Null
      } else {
        let lower = identifier(checked_text_value(values[0]))
        if name == "lower" {
          Text(lower)
        } else {
          let b = @utf8.encode(lower)
            .to_array()
            .map(c => {
              if c >= b'a' && c <= b'z' {
                (c.to_int() - 32).to_byte()
              } else {
                c
              }
            })
          Text(@utf8.decode_lossy(Bytes::from_array(b)))
        }
      }
    }
    "abs" => {
      guard CAP_FUNCTION_ABS else { fail("catalog capability disabled: abs") }
      guard values.length() == 1 else { fail("wrong number of arguments: abs") }
      match numeric(values[0], false) {
        Null => Null
        Integer(n) => {
          guard n != -9223372036854775808L else { fail("integer overflow") }
          Integer(n.abs())
        }
        Real(n) => Real(n.abs())
        _ => Real(0)
      }
    }
    "in" => {
      guard CAP_FUNCTION_IN_LIST else {
        fail("catalog capability disabled: in")
      }
      guard values.length() > 0 else { fail("invalid IN") }
      if values.length() == 1 {
        return Integer(0L)
      }
      if values[0] is Null {
        return Null
      }
      let a = expression_affinity(args[0], ctx)
      let mut unknown = false
      for i = 1; i < values.length(); i = i + 1 {
        if values[i] is Null {
          unknown = true
        } else if compare_stored(
            ctx.store,
            values[0],
            apply_affinity(values[i], a),
            expression_collation(args[0], ctx),
          ) ==
          0 {
          return Integer(1L)
        }
      }
      if unknown {
        Null
      } else {
        Integer(0L)
      }
    }
    _ =>
      if FEATURE_SQL_JSON && json_arity(name, values.length()) {
        json_call(name, args, values, ctx)
      } else if FEATURE_DATETIME && datetime_arity(name, values.length()) {
        datetime_call(name, values, ctx.store.triggers.clock)
      } else {
        scalar_call(name, values, ctx.store.encoding.unwrap_or(1))
      }
  }
}

///|
fn row_environment(
  table : Table,
  row : StoredRow,
  qualifier : String,
) -> Environment {
  let result = table.columns.mapi((i, c) => {
    qualifier,
    name: c.name,
    display_name: c.name,
    value: row.values[i],
    affinity: column_affinity(table, c),
    collation: c.collation,
    hidden: false,
    join_column: None,
  })
  if !table.without_rowid {
    let ipk = integer_primary(table)
    for name in ["rowid", "_rowid_", "oid"] {
      if !table.columns.any(c => identifier(c.name) == name) {
        result.push({
          qualifier,
          name,
          display_name: if ipk >= 0 {
            table.columns[ipk].name
          } else {
            "rowid"
          },
          value: Integer(row.id),
          affinity: "integer",
          collation: "binary",
          hidden: true,
          join_column: None,
        })
      }
    }
  }
  result
}

///|
/// Layout metadata is immutable within one statement; only values vary by row.
fn row_environment_from(layout : Environment, row : StoredRow) -> Environment {
  layout.mapi((i, b) => {
    ..b,
    value: if b.hidden {
      Integer(row.id)
    } else {
      row.values[i]
    },
  })
}

///|
fn aggregate(expression : Expr) -> Bool {
  match expression {
    Call(name, args) =>
      aggregate_name(name, args.length()) || args.any(aggregate)
    Binary(_, a, b) => aggregate(a) || aggregate(b)
    InSelect(e, _) => aggregate(e)
    Between(e, a, b) => aggregate(e) || aggregate(a) || aggregate(b)
    Case(base, arms, otherwise) =>
      base.map(aggregate).unwrap_or(false) ||
      arms.any(arm => aggregate(arm.0) || aggregate(arm.1)) ||
      aggregate(otherwise)
    Unary(_, e) | Collate(e, _) | Cast(e, _) => aggregate(e)
    Window(_, args, partitions, orders, _) =>
      args.any(aggregate) ||
      partitions.any(aggregate) ||
      orders.any(o => aggregate(o.expression))
    _ => false
  }
}

///|
fn project(
  projections : Array[Projection],
  ctx : Evaluation,
) -> Environment raise SqlError {
  let output : Environment = []
  for p in projections {
    if p.expression is Star(q) {
      for b in ctx.row {
        if !b.hidden &&
          (q != "" || !(b.join_column is Some(SuppressedJoinColumn))) &&
          (q == "" || identifier(b.qualifier) == identifier(q)) {
          output.push({
            ..(if b.join_column is Some(MergedJoinColumn(_, _, _)) {
              unqualified_binding(b).unwrap()
            } else {
              b
            }),
            qualifier: "",
            join_column: None,
          })
        }
      }
    } else {
      output.push({
        qualifier: "",
        name: projection_name(p, ctx),
        display_name: projection_name(p, ctx),
        value: match p.expression {
          Column(q, n) => resolve_context(ctx, q, n).value
          _ => evaluate(p.expression, ctx)
        },
        affinity: expression_affinity(p.expression, ctx),
        collation: expression_collation(p.expression, ctx),
        hidden: false,
        join_column: None,
      })
    }
  }
  output
}

///|
fn result_json(rows : Array[Environment]) -> Json {
  Json::array(
    rows.map(row => {
      let object : Map[String, Json] = Map([])
      for b in row {
        if !b.hidden {
          object[b.name] = value_json(b.value)
        }
      }
      Json::object(object)
    }),
  )
}

///|
/// INTEGER PRIMARY KEY aliases use the declared column name unless AS is given.
fn projection_name(p : Projection, ctx : Evaluation) -> String raise SqlError {
  if !p.explicit_label && p.expression is Column(q, n) {
    resolve_context(ctx, q, n).display_name
  } else {
    p.label
  }
}

///|
/// Comparison keeps expression affinity while evaluating each operand once.
fn compare_expression(
  op : String,
  left : Expr,
  a : Value,
  right : Expr,
  b : Value,
  ctx : Evaluation,
) -> Value raise SqlError {
  if (op == "is" || op == "is not") &&
    right is TruthLiteral(expected) &&
    find_context(ctx, "", if expected { "true" } else { "false" }) is None {
    return boolean((truth(a) == (if expected { 1 } else { 0 })) == (op == "is"))
  }
  if a is Null || b is Null {
    if op == "is" || op == "is not" {
      boolean((a is Null && b is Null) == (op == "is"))
    } else {
      Null
    }
  } else {
    let la = expression_affinity(left, ctx)
    let ra = expression_affinity(right, ctx)
    let a = merged_comparison_value(left, a, la, ctx)
    let b = merged_comparison_value(right, b, ra, ctx)
    let collation = match left {
      Collate(_, name) => name
      _ =>
        match right {
          Collate(_, name) => name
          _ =>
            if column_collation_operand(left) {
              expression_collation(left, ctx)
            } else {
              expression_collation(right, ctx)
            }
        }
    }
    compare_nonnull(op, a, b, la, ra, collation, ctx.store)
  }
}

///|
fn column_collation_operand(e : Expr) -> Bool {
  match e {
    Column(_, _) => true
    Cast(e, _) | Unary("+", e) => column_collation_operand(e)
    _ => false
  }
}

///|
fn aggregate_number(value : Value) -> Value {
  let parsed = numeric(value, true)
  match parsed {
    Integer(_) | Real(_) => parsed
    _ => Real(as_double(value))
  }
}

///|
fn unary_value(op : String, value : Value) -> Value {
  if op == "not" {
    let t = truth(value)
    if t == -1 {
      Null
    } else {
      boolean(t == 0)
    }
  } else if op == "+" {
    value
  } else if op == "~" {
    if value is Null {
      Null
    } else {
      Integer(integer_value(value) ^ -1L)
    }
  } else {
    match numeric(value, false) {
      Null => Null
      Integer(n) =>
        if n == -9223372036854775808L {
          Real(9223372036854775808.0)
        } else {
          Integer(-n)
        }
      Real(n) => Real(-n)
      _ => Integer(0L)
    }
  }
}

///|
fn binary_value(op : String, a : Value, b : Value) -> Value raise SqlError {
  if op == "and" || op == "or" {
    let a = truth(a)
    let b = truth(b)
    if op == "and" {
      if a == 0 || b == 0 {
        Integer(0L)
      } else if a < 0 || b < 0 {
        Null
      } else {
        Integer(1L)
      }
    } else if a == 1 || b == 1 {
      Integer(1L)
    } else if a < 0 || b < 0 {
      Null
    } else {
      Integer(0L)
    }
  } else if ["+", "-", "*", "/", "%"].contains(op) {
    arithmetic(op, a, b)
  } else if op == "<<" || op == ">>" {
    shift_value(op, a, b)
  } else if op == "&" || op == "|" {
    if a is Null || b is Null {
      Null
    } else {
      let x = integer_value(a)
      let y = integer_value(b)
      Integer(if op == "&" { x & y } else { x | y })
    }
  } else if op == "||" {
    if a is Null || b is Null {
      Null
    } else {
      Text(checked_text_value(a) + checked_text_value(b))
    }
  } else if op == "like" {
    guard CAP_FUNCTION_LIKE else { fail("catalog capability disabled: like") }
    like_value([b, a])
  } else {
    fail("unsupported SQL operator: " + op)
  }
}

///|
fn comparison_operator(op : String) -> Bool {
  match op {
    "=" | "==" | "!=" | "<>" | "<" | ">" | "<=" | ">=" | "is" | "is not" => true
    _ => false
  }
}

///|
fn compare_nonnull(
  op : String,
  a : Value,
  b : Value,
  la : String,
  ra : String,
  collation : String,
  store : Store,
) -> Value raise SqlError {
  let a = if ["integer", "numeric", "real"].contains(ra) &&
    !["integer", "numeric", "real"].contains(la) {
    apply_affinity(a, "numeric")
  } else if ra == "text" && la == "" {
    apply_affinity(a, "text")
  } else {
    a
  }
  let b = if ["integer", "numeric", "real"].contains(la) &&
    !["integer", "numeric", "real"].contains(ra) {
    apply_affinity(b, "numeric")
  } else if la == "text" && ra == "" {
    apply_affinity(b, "text")
  } else {
    b
  }
  let comparison = compare_stored(store, a, b, collation)
  boolean(
    match op {
      "=" | "==" | "is" => comparison == 0
      "<>" | "!=" | "is not" => comparison != 0
      "<" => comparison < 0
      ">" => comparison > 0
      "<=" => comparison <= 0
      ">=" => comparison >= 0
      _ => fail("unsupported SQL operator: " + op)
    },
  )
}
