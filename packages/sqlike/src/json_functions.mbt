///|
/// SQL JSON preserves member order and duplicate labels. Lookup and edits use
/// the first matching member, as SQLite JSON1 does; storage JSON stays separate.
#derive(Eq)
priv enum SqlJson {
  Null
  True
  False
  Number(Double, String?)
  String(String, String?)
  Array(Array[SqlJson])
  Object(Array[(SqlJsonKey, SqlJson)])
}

///|
#derive(Eq)
priv struct SqlJsonKey {
  text : String
  source : String?
}

///|
fn SqlJson::null() -> SqlJson {
  Null
}

///|
fn SqlJson::string(s : String) -> SqlJson {
  String(s, None)
}

///|
fn SqlJson::array(a : Array[SqlJson]) -> SqlJson {
  Array(a)
}

///|
fn SqlJson::object(a : Array[(String, SqlJson)]) -> SqlJson {
  Object(a.map(p => ({ text: p.0, source: None, }, p.1)))
}

///|
fn json_string_source(text : String, source : String?) -> String {
  match source {
    Some(raw) => raw
    None => @json.to_json(text).stringify()
  }
}

///|
fn SqlJson::stringify(self : SqlJson) -> String {
  match self {
    Null => "null"
    True => "true"
    False => "false"
    Number(n, repr) => repr.unwrap_or(n.to_string())
    String(s, source) => json_string_source(s, source)
    Array(a) => "[" + a.map(v => v.stringify()).join(",") + "]"
    Object(a) =>
      "{" +
      a
      .map(p => json_string_source(p.0.text, p.0.source) + ":" + p.1.stringify())
      .join(",") +
      "}"
  }
}

///|
fn json_key(a : Array[(SqlJsonKey, SqlJson)], key : String) -> Int32 {
  for i, pair in a {
    if pair.0.text == key {
      return i
    }
  }
  -1
}

///|
fn json_get(a : Array[(SqlJsonKey, SqlJson)], key : String) -> SqlJson? {
  let i = json_key(a, key)
  if i < 0 {
    None
  } else {
    Some(a[i].1)
  }
}

///|
fn json_put(
  a : Array[(SqlJsonKey, SqlJson)],
  key : SqlJsonKey,
  v : SqlJson,
) -> Unit {
  let i = json_key(a, key.text)
  if i < 0 {
    a.push((key, v))
  } else {
    a[i] = (a[i].0, v)
  }
}

///|
priv struct SqlJsonParser {
  bytes : Bytes
  mut position : Int32
}

///|
fn SqlJsonParser::space(p : SqlJsonParser) -> Unit {
  while p.position < p.bytes.length() &&
        [b' ', b'\t', b'\r', b'\n'].contains(p.bytes[p.position]) {
    p.position += 1
  }
}

///|
fn SqlJsonParser::take(p : SqlJsonParser, c : Byte) -> Bool {
  p.space()
  if p.position < p.bytes.length() && p.bytes[p.position] == c {
    p.position += 1
    true
  } else {
    false
  }
}

///|
fn SqlJsonParser::value(
  p : SqlJsonParser,
  depth : Int32,
) -> SqlJson raise SqlError {
  guard depth <= 1000 else { fail("JSON depth resource limit") }
  p.space()
  if p.take(b'{') {
    let fields = []
    if !p.take(b'}') {
      while true {
        p.space()
        guard p.position < p.bytes.length() && p.bytes[p.position] == b'"' else {
          fail("malformed JSON")
        }
        guard p.value(depth + 1) is String(key, source) else {
          fail("malformed JSON")
        }
        guard p.take(b':') else { fail("malformed JSON") }
        fields.push(({ text: key, source, }, p.value(depth + 1)))
        if p.take(b'}') {
          break
        }
        guard p.take(b',') else { fail("malformed JSON") }
      }
    }
    return Object(fields)
  }
  if p.take(b'[') {
    let items = []
    if !p.take(b']') {
      while true {
        items.push(p.value(depth + 1))
        if p.take(b']') {
          break
        }
        guard p.take(b',') else { fail("malformed JSON") }
      }
    }
    return Array(items)
  }
  let start = p.position
  guard start < p.bytes.length() else { fail("malformed JSON") }
  if p.bytes[start] == b'"' {
    p.position += 1
    while p.position < p.bytes.length() {
      let c = p.bytes[p.position]
      p.position += 1
      if c == b'"' {
        break
      }
      if c == b'\\' {
        p.position += 1
      }
    }
  } else {
    while p.position < p.bytes.length() &&
          ![b' ', b'\t', b'\r', b'\n', b',', b']', b'}'].contains(
            p.bytes[p.position],
          ) {
      p.position += 1
    }
  }
  guard p.position <= p.bytes.length() && p.position > start else {
    fail("malformed JSON")
  }
  let atom = @json.parse(
    @utf8.decode_lossy(p.bytes[start:p.position]),
    preserve_number_repr=true,
  ) catch {
    _ => fail("malformed JSON")
  }
  match atom {
    Null => SqlJson::Null
    True => SqlJson::True
    False => SqlJson::False
    Number(n, repr~) => SqlJson::Number(n, repr)
    String(s) =>
      SqlJson::String(s, Some(@utf8.decode_lossy(p.bytes[start:p.position])))
    _ => fail("malformed JSON")
  }
}

///|
fn parse_sql_json(text : String) -> SqlJson raise SqlError {
  let bytes = @utf8.encode(text)
  guard bytes.length() <= 1048576 else { fail("JSON resource limit") }
  let p = { bytes, position: 0, }
  let result = p.value(0)
  p.space()
  guard p.position == bytes.length() else { fail("malformed JSON") }
  result
}

///|
priv enum JsonSegment {
  Key(String)
  Index(Int32)
  FromEnd(Int32)
}

///|
fn json_path(path : String) -> Array[JsonSegment] raise SqlError {
  let b = @utf8.encode(path)
  guard b.length() > 0 && b[0] == b'$' else { fail("bad JSON path") }
  let result : Array[JsonSegment] = []
  let mut i = 1
  while i < b.length() {
    if b[i] == b'.' {
      i += 1
      let start = i
      if i < b.length() && b[i] == b'"' {
        i += 1
        while i < b.length() && b[i] != b'"' {
          if b[i] == b'\\' {
            i += 1
          }
          i += 1
        }
        guard i < b.length() else { fail("bad JSON path") }
        i += 1
        let key = @json.parse(@utf8.decode_lossy(b[start:i])) catch {
          _ => fail("bad JSON path")
        }
        guard key is String(key) else { fail("bad JSON path") }
        result.push(Key(key))
      } else {
        while i < b.length() && b[i] != b'.' && b[i] != b'[' {
          i += 1
        }
        guard i > start else { fail("bad JSON path") }
        result.push(Key(@utf8.decode_lossy(b[start:i])))
      }
    } else if b[i] == b'[' {
      i += 1
      let start = i
      while i < b.length() && b[i] != b']' {
        i += 1
      }
      guard i < b.length() && i > start else { fail("bad JSON path") }
      let part = @utf8.decode_lossy(b[start:i])
      if part == "#" {
        result.push(FromEnd(0))
      } else if part.has_prefix("#-") {
        let n = @string.parse_int(part[2:].to_owned()) catch {
          _ => fail("bad JSON path")
        }
        guard n >= 0 else { fail("bad JSON path") }
        result.push(FromEnd(n))
      } else {
        let n = @string.parse_int(part) catch { _ => fail("bad JSON path") }
        guard n >= 0 else { fail("bad JSON path") }
        result.push(Index(n))
      }
      i += 1
    } else {
      fail("bad JSON path")
    }
    guard result.length() <= 64 else { fail("JSON path resource limit") }
  }
  result
}

///|
fn json_lookup(json : SqlJson, path : Array[JsonSegment]) -> SqlJson? {
  let mut current = json
  for part in path {
    match (current, part) {
      (Object(fields), Key(key)) => {
        guard json_get(fields, key) is Some(v) else { return None }
        current = v
      }
      (Array(items), Index(n)) => {
        guard n < items.length() else { return None }
        current = items[n]
      }
      (Array(items), FromEnd(n)) => {
        let n = items.length() - n
        guard n >= 0 && n < items.length() else { return None }
        current = items[n]
      }
      _ => return None
    }
  }
  Some(current)
}

///|
fn json_sql_value(json : SqlJson) -> Value {
  match json {
    Null => Null
    True => Integer(1L)
    False => Integer(0L)
    Number(n, repr) =>
      if repr is Some(s) {
        parse_number(s) catch {
          _ => Real(n)
        }
      } else {
        Real(n)
      }
    String(s, _) => Text(s)
    other => Text(other.stringify())
  }
}

///|
fn json_input(value : Value) -> SqlJson raise SqlError {
  parse_sql_json(checked_text_value(value))
}

///|
fn json_argument(
  value : Value,
  expr : Expr,
  ctx : Evaluation,
) -> SqlJson raise SqlError {
  if CAP_QUERY_JSON_SUBTYPE && value is Text(_) && json_subtype(expr, ctx) {
    return json_input(value)
  }
  match value {
    Null => SqlJson::null()
    Integer(n) => SqlJson::Number(n.to_double(), Some(n.to_string()))
    Real(n) =>
      if n.is_inf() {
        SqlJson::Number(n, Some(if n < 0 { "-9.0e+999" } else { "9.0e+999" }))
      } else if n.is_nan() {
        SqlJson::null()
      } else {
        SqlJson::Number(n, Some(sqlite_real_text(n)))
      }
    Text(s) => SqlJson::string(s)
    Blob(_) => fail("JSON cannot hold BLOB values")
  }
}

///|
/// Return a fresh tree. Paths never mutate a parsed value shared with another call.
fn json_edit(
  json : SqlJson,
  path : Array[JsonSegment],
  position : Int32,
  value : SqlJson,
  mode : String,
) -> SqlJson {
  if position == path.length() {
    return value
  }
  let last = position + 1 == path.length()
  match (json, path[position]) {
    (Object(fields), Key(key)) => {
      let copy = fields.copy()
      let index = json_key(copy, key)
      let exists = index >= 0
      if last {
        if mode == "remove" {
          ignore(copy.remove(index))
        } else if (mode != "insert" || !exists) && (mode != "replace" || exists) {
          json_put(copy, { text: key, source: None, }, value)
        }
      } else if exists || mode == "set" || mode == "insert" {
        let empty = match path[position + 1] {
          Key(_) => SqlJson::object([])
          _ => SqlJson::array([])
        }
        let child = if exists { copy[index].1 } else { empty }
        let next = json_edit(child, path, position + 1, value, mode)
        if exists || next != empty {
          json_put(copy, { text: key, source: None, }, next)
        }
      }
      SqlJson::Object(copy)
    }
    (Array(items), part) => {
      let n = match part {
        Index(n) => n
        FromEnd(n) => items.length() - n
        _ => -1
      }
      if n < 0 || n > items.length() {
        return json
      }
      let copy = items.copy()
      let exists = n < copy.length()
      if last {
        if mode == "remove" {
          if exists {
            ignore(copy.remove(n))
          }
        } else if (mode != "insert" || !exists) && (mode != "replace" || exists) {
          if exists {
            copy[n] = value
          } else {
            copy.push(value)
          }
        }
      } else if exists || mode == "set" || mode == "insert" {
        let empty = match path[position + 1] {
          Key(_) => SqlJson::object([])
          _ => SqlJson::array([])
        }
        let next = json_edit(
          if exists {
            copy[n]
          } else {
            empty
          },
          path,
          position + 1,
          value,
          mode,
        )
        if exists {
          copy[n] = next
        } else if next != empty {
          copy.push(next)
        }
      }
      SqlJson::array(copy)
    }
    _ => json
  }
}

///|
fn json_merge(target : SqlJson, patch : SqlJson) -> SqlJson {
  guard patch is Object(patch) else { return patch }
  let copy = match target {
    Object(fields) => fields.copy()
    _ => []
  }
  for (key, value) in patch {
    let index = json_key(copy, key.text)
    if value is Null {
      if index >= 0 {
        ignore(copy.remove(index))
      }
    } else {
      json_put(
        copy,
        key,
        json_merge(
          if index >= 0 {
            copy[index].1
          } else {
            SqlJson::null()
          },
          value,
        ),
      )
    }
  }
  SqlJson::Object(copy)
}

///|
fn json_arity(name : String, count : Int32) -> Bool {
  match name {
    "->" | "->>" => count == 2
    "json_valid" | "json" | "json_quote" => count == 1
    "json_type" | "json_array_length" => count == 1 || count == 2
    "json_extract" => count >= 2
    "json_set" | "json_insert" | "json_replace" => count >= 1 && count % 2 == 1
    "json_remove" => count >= 1
    "json_array" => true
    "json_object" => count % 2 == 0
    "json_patch" => count == 2
    _ => false
  }
}

///|
fn json_call(
  name : String,
  args : Array[Expr],
  values : Array[Value],
  ctx : Evaluation,
) -> Value raise SqlError {
  if CAP_FUNCTION_JSON_ARROW && (name == "->" || name == "->>") {
    if values[0] is Null {
      return Null
    }
    let json = json_input(values[0])
    if values[1] is Null {
      return Null
    }
    let path : Array[JsonSegment] = match values[1] {
      Integer(n) => {
        // A document cannot have an Int32-overflowing array index. Do not wrap.
        if n > 2147483647L || n < -2147483647L {
          return Null
        }
        [if n < 0L { FromEnd((-n).to_int()) } else { Index(n.to_int()) }]
      }
      value => {
        let text = checked_text_value(value)
        guard text != "" else { fail("bad JSON path") }
        guard !text.contains("\u{0}") else {
          fail("unsupported JSON path with NUL")
        }
        if text.has_prefix("$") {
          json_path(text)
        } else {
          json_path("$.\"" + text + "\"")
        }
      }
    }
    match json_lookup(json, path) {
      Some(value) =>
        if name == "->" {
          Text(value.stringify())
        } else {
          json_sql_value(value)
        }
      None => Null
    }
  } else {
    json_call_function(name, args, values, ctx)
  }
}

///|
fn json_call_function(
  name : String,
  args : Array[Expr],
  values : Array[Value],
  ctx : Evaluation,
) -> Value raise SqlError {
  if CAP_FUNCTION_JSON_NORMALIZE && name == "json_valid" {
    if values[0] is Null {
      return Null
    }
    return boolean(
      try {
        ignore(parse_sql_json(checked_text_value(values[0])))
        true
      } catch {
        _ => false
      },
    )
  }
  if CAP_FUNCTION_JSON_CONSTRUCT && name == "json_quote" {
    return Text(json_argument(values[0], args[0], ctx).stringify())
  }
  if CAP_FUNCTION_JSON_CONSTRUCT && name == "json_array" {
    return Text(
      SqlJson::array(values.mapi((i, v) => json_argument(v, args[i], ctx))).stringify(),
    )
  }
  if CAP_FUNCTION_JSON_CONSTRUCT && name == "json_object" {
    let fields : Array[(String, SqlJson)] = []
    for i = 0; i < values.length(); i = i + 2 {
      guard values[i] is Text(key) else {
        fail("json_object() labels must be TEXT")
      }
      fields.push((key, json_argument(values[i + 1], args[i + 1], ctx)))
    }
    return Text(SqlJson::object(fields).stringify())
  }
  if CAP_FUNCTION_JSON_NORMALIZE && name == "json" {
    return if values[0] is Null {
      Null
    } else {
      Text(json_input(values[0]).stringify())
    }
  }
  if CAP_FUNCTION_JSON_PATCH && name == "json_patch" {
    if values[0] is Null {
      return Null
    }
    let target = json_input(values[0])
    if values[1] is Null {
      return Null
    }
    return Text(json_merge(target, json_input(values[1])).stringify())
  }
  if CAP_FUNCTION_JSON_READ &&
    (
      name == "json_extract" ||
      name == "json_type" ||
      name == "json_array_length"
    ) {
    if values[0] is Null {
      return Null
    }
    let json = json_input(values[0])
    let paths : Array[Value] = if values.length() == 1 {
      [Text("$")]
    } else {
      values[1:].to_owned()
    }
    let results : Array[SqlJson?] = []
    for path in paths {
      if path is Null {
        if name == "json_extract" && paths.length() > 1 {
          results.push(None)
          continue
        }
        return Null
      }
      results.push(json_lookup(json, json_path(checked_text_value(path))))
    }
    if name == "json_extract" {
      if results.length() > 1 {
        return Text(
          SqlJson::array(results.map(v => v.unwrap_or(SqlJson::null()))).stringify(),
        )
      }
      return results[0].map(json_sql_value).unwrap_or(Null)
    }
    guard results[0] is Some(v) else { return Null }
    if name == "json_array_length" {
      return Integer(
        match v {
          Array(items) => items.length().to_int64()
          _ => 0L
        },
      )
    }
    return Text(
      match v {
        Null => "null"
        True => "true"
        False => "false"
        String(_, _) => "text"
        Array(_) => "array"
        Object(_) => "object"
        Number(_, repr) =>
          if repr is Some(s) &&
            !s.contains(".") &&
            !s.contains("e") &&
            !s.contains("E") {
            "integer"
          } else {
            "real"
          }
      },
    )
  }
  if CAP_FUNCTION_JSON_EDIT &&
    ["json_set", "json_insert", "json_replace", "json_remove"].contains(name) {
    return json_edit_call(name, args, values, ctx)
  }
  fail("catalog capability disabled: JSON function " + name)
}

///|
fn json_edit_call(
  name : String,
  args : Array[Expr],
  values : Array[Value],
  ctx : Evaluation,
) -> Value raise SqlError {
  if values[0] is Null {
    return Null
  }
  let mut json = json_input(values[0])
  let mode = match name {
    "json_insert" => "insert"
    "json_replace" => "replace"
    "json_remove" => "remove"
    _ => "set"
  }
  let mut i = 1
  while i < values.length() {
    if values[i] is Null {
      if mode == "remove" {
        return Null
      }
      i += 2
      continue
    }
    let path = json_path(checked_text_value(values[i]))
    if path.is_empty() && mode == "remove" {
      return Null
    }
    let value = if mode == "remove" {
      SqlJson::null()
    } else {
      json_argument(values[i + 1], args[i + 1], ctx)
    }
    if !path.is_empty() || mode != "insert" {
      json = json_edit(json, path, 0, value, mode)
    }
    i += if mode == "remove" { 1 } else { 2 }
  }
  Text(json.stringify())
}

///|
fn json_subtype(expr : Expr, ctx : Evaluation) -> Bool raise SqlError {
  match expr {
    Call("json_extract", args) => {
      guard CAP_FUNCTION_JSON_READ else { return false }
      if args.length() > 2 {
        return true
      }
      let source = evaluate(args[0], ctx)
      let path = evaluate(args[1], ctx)
      if source is Null || path is Null {
        return false
      }
      match
        json_lookup(json_input(source), json_path(checked_text_value(path))) {
        Some(Array(_)) | Some(Object(_)) => true
        _ => false
      }
    }
    Call("coalesce", args) | Call("ifnull", args) => {
      for arg in args {
        if !(evaluate(arg, ctx) is Null) {
          return json_subtype(arg, ctx)
        }
      }
      false
    }
    Call("nullif", args) => json_subtype(args[0], ctx)
    Call("iif", args) | Call("if", args) => {
      let mut index = 0
      while index + 1 < args.length() {
        if truth(evaluate(args[index], ctx)) == 1 {
          return json_subtype(args[index + 1], ctx)
        }
        index += 2
      }
      if index < args.length() {
        json_subtype(args[index], ctx)
      } else {
        false
      }
    }
    Call(name, _) =>
      [
        "json", "json_quote", "json_array", "json_object", "json_set", "json_insert",
        "json_replace", "json_remove", "json_patch", "->", "json_group_array", "json_group_object",
      ].contains(name)
    Case(base, arms, other) => {
      let selected = evaluate(
        Case(
          base,
          arms.mapi((i, p) => (p.0, Literal(Integer(i.to_int64())))),
          Literal(Integer(-1L)),
        ),
        ctx,
      )
      if selected is Integer(i) && i >= 0L {
        json_subtype(arms[i.to_int()].1, ctx)
      } else {
        json_subtype(other, ctx)
      }
    }
    Collate(e, _) | Unary("+", e) | Cast(e, "text") => json_subtype(e, ctx)
    _ => false
  }
}
