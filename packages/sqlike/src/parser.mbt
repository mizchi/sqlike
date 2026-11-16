///|
/// Tokens retain byte offsets so SQLite's unaliased result labels are preserved.
priv struct Token {
  word : String
  kind : Int32
  start : Int32
  end : Int32
}

///|
priv struct Parser {
  source : Bytes
  tokens : Array[Token]
  mut position : Int32
  mut parameter : Int32
  mut derived : Int32
  parameter_names : Map[String, Int32]
  mut depth : Int32
}

///|
fn sql_digit(c : Byte, hex : Bool) -> Int32 {
  if c >= b'0' && c <= b'9' {
    c.to_int() - 48
  } else if hex && c >= b'a' && c <= b'f' {
    c.to_int() - 87
  } else if hex && c >= b'A' && c <= b'F' {
    c.to_int() - 55
  } else {
    -1
  }
}

///|
/// Separators belong to SQL source only, never numeric TEXT conversion.
fn sql_digits(bytes : Bytes, start : Int32, hex : Bool) -> Int32 raise SqlError {
  let mut i = start
  while i < bytes.length() {
    if sql_digit(bytes[i], hex) >= 0 {
      i += 1
    } else if bytes[i] == b'_' {
      guard i > start &&
        i + 1 < bytes.length() &&
        sql_digit(bytes[i - 1], hex) >= 0 &&
        sql_digit(bytes[i + 1], hex) >= 0 else {
        fail("invalid SQL numeric separator")
      }
      i += 1
    } else {
      break
    }
  }
  i
}

///|
fn sql_number(text : String) -> Value raise SqlError {
  let bytes = @utf8.encode(text)
  if bytes.length() >= 2 &&
    bytes[0] == b'0' &&
    (bytes[1] == b'x' || bytes[1] == b'X') {
    let mut number = 0UL
    for i in 2..<bytes.length() {
      guard number <= 0x0FFFFFFFFFFFFFFFUL else { fail("hex literal too big") }
      number = (number << 4) | sql_digit(bytes[i], true).to_uint64()
    }
    Integer(number.reinterpret_as_int64())
  } else {
    parse_number(text)
  }
}

///|
fn sql_integer_min(e : Expr) -> Bool {
  match e {
    Literal(Integer(-9223372036854775808L)) => true
    Unary("+", e) => sql_integer_min(e)
    _ => false
  }
}

///|
fn lex(sql : String) -> Parser raise SqlError {
  let bytes = @utf8.encode(sql)
  guard !bytes.to_array().contains(b'\x00') else {
    fail("SQL source contains NUL")
  }
  guard bytes.length() <= 1048576 else { fail("SQL resource limit") }
  let tokens : Array[Token] = []
  let mut i = 0
  while i < bytes.length() {
    let start = i
    let c = bytes[i].to_int()
    if c <= 32 {
      i += 1
      continue
    }
    if c == 45 && i + 1 < bytes.length() && bytes[i + 1] == b'-' {
      while i < bytes.length() && bytes[i] != b'\n' {
        i += 1
      }
      continue
    }
    if c == 47 && i + 1 < bytes.length() && bytes[i + 1] == b'*' {
      i += 2
      while i + 1 < bytes.length() &&
            !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
        i += 1
      }
      guard i + 1 < bytes.length() else { fail("unterminated SQL comment") }
      i += 2
      continue
    }
    if c == 39 || c == 34 || c == 96 || c == 91 {
      let end = if c == 91 { 93 } else { c }
      i += 1
      let b = @buffer.Buffer()
      let mut closed = false
      while i < bytes.length() {
        let ch = bytes[i]
        i += 1
        if ch.to_int() == end {
          if end != 93 && i < bytes.length() && bytes[i].to_int() == end {
            b.write_byte(ch)
            i += 1
          } else {
            closed = true
            break
          }
        } else {
          b.write_byte(ch)
        }
      }
      guard closed else { fail("unterminated SQL quote") }
      tokens.push({
        word: @utf8.decode_lossy(b.to_bytes()),
        kind: if c == 39 {
          1
        } else {
          2
        },
        start,
        end: i,
      })
    } else if c == 58 || c == 64 || c == 36 {
      i += 1
      let mut count = 0
      while i < bytes.length() {
        let ch = bytes[i].to_int()
        if (ch >= 65 && ch <= 90) ||
          (ch >= 97 && ch <= 122) ||
          (ch >= 48 && ch <= 57) ||
          ch == 95 ||
          ch == 36 ||
          ch >= 128 {
          count += 1
          i += 1
        } else if ch == 58 && i + 1 < bytes.length() && bytes[i + 1] == b':' {
          i += 2
        } else if ch == 40 && count > 0 {
          i += 1
          while i < bytes.length() && bytes[i] != b')' && bytes[i].to_int() > 32 {
            i += 1
          }
          guard i < bytes.length() && bytes[i] == b')' else {
            fail("invalid SQL parameter")
          }
          i += 1
          break
        } else {
          break
        }
      }
      guard count > 0 else { fail("invalid SQL parameter") }
      tokens.push({
        word: @utf8.decode_lossy(bytes[start:i]),
        kind: 5,
        start,
        end: i,
      })
    } else if (c >= 48 && c <= 57) ||
      (
        c == 46 &&
        i + 1 < bytes.length() &&
        bytes[i + 1] >= b'0' &&
        bytes[i + 1] <= b'9'
      ) {
      // ?NNN uses decimal digits without separators or other literal syntax.
      let parameter = !tokens.is_empty() &&
        tokens[tokens.length() - 1].word == "?" &&
        tokens[tokens.length() - 1].end == start
      if parameter {
        while i < bytes.length() && bytes[i] >= b'0' && bytes[i] <= b'9' {
          i += 1
        }
      } else if c == 48 &&
        i + 1 < bytes.length() &&
        (bytes[i + 1] == b'x' || bytes[i + 1] == b'X') {
        i = sql_digits(bytes, i + 2, true)
        guard i > start + 2 else { fail("invalid SQL hex literal") }
      } else {
        i = sql_digits(bytes, i, false)
        if i < bytes.length() && bytes[i] == b'.' {
          i += 1
          i = sql_digits(bytes, i, false)
        }
        if i < bytes.length() && (bytes[i] == b'e' || bytes[i] == b'E') {
          i += 1
          if i < bytes.length() && (bytes[i] == b'+' || bytes[i] == b'-') {
            i += 1
          }
          let first = i
          i = sql_digits(bytes, i, false)
          guard i > first else { fail("invalid SQL numeric exponent") }
        }
      }
      if !parameter && i < bytes.length() {
        let n = bytes[i].to_int()
        guard !((n >= 65 && n <= 90) ||
          (n >= 97 && n <= 122) ||
          n == 95 ||
          n >= 128) else {
          fail("invalid SQL number")
        }
      }
      tokens.push({
        word: @utf8.decode_lossy(bytes[start:i]).replace_all(old="_", new=""),
        kind: 3,
        start,
        end: i,
      })
    } else if (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122) ||
      c == 95 ||
      c >= 128 {
      i += 1
      while i < bytes.length() {
        let n = bytes[i].to_int()
        if (n >= 65 && n <= 90) ||
          (n >= 97 && n <= 122) ||
          (n >= 48 && n <= 57) ||
          n == 95 ||
          n >= 128 {
          i += 1
        } else {
          break
        }
      }
      tokens.push({
        word: @utf8.decode_lossy(bytes[start:i]),
        kind: 0,
        start,
        end: i,
      })
    } else {
      i += 1
      if i < bytes.length() {
        let pair = @utf8.decode_lossy(bytes[start:i + 1])
        if ["<=", ">=", "!=", "<>", "==", "||", "<<", ">>", "->"].contains(pair) {
          i += 1
          if pair == "->" && i < bytes.length() && bytes[i] == b'>' {
            i += 1
          }
        }
      }
      tokens.push({
        word: @utf8.decode_lossy(bytes[start:i]),
        kind: 4,
        start,
        end: i,
      })
    }
    guard tokens.length() <= 10000 else { fail("SQL token resource limit") }
  }
  tokens.push({ word: "", kind: 4, start: i, end: i, })
  {
    source: bytes,
    tokens,
    position: 0,
    parameter: 0,
    derived: 0,
    parameter_names: Map([]),
    depth: 0,
  }
}

///|
fn Parser::peek(p : Parser) -> String {
  let t = p.tokens[p.position]
  if t.kind == 1 || t.kind == 2 {
    "quoted"
  } else {
    identifier(t.word)
  }
}

///|
fn Parser::take(p : Parser, word : String) -> Bool {
  if p.peek() == word {
    p.position += 1
    true
  } else {
    false
  }
}

///|
fn Parser::expect(p : Parser, word : String) -> Unit raise SqlError {
  guard p.take(word) else {
    fail(
      "SQL syntax: expected " + word + ", found " + p.tokens[p.position].word,
    )
  }
}

///|
fn Parser::name(p : Parser) -> String raise SqlError {
  let t = p.tokens[p.position]
  guard t.kind == 0 || t.kind == 2 else {
    fail("SQL syntax: expected identifier")
  }
  p.position += 1
  t.word
}

///|
fn Parser::names(
  p : Parser,
  ordered~ : Bool = false,
  qualifier~ : String = "",
) -> Array[String] raise SqlError {
  p.expect("(")
  let result = []
  while true {
    let first = p.name()
    let name = if qualifier != "" && p.take(".") {
      guard identifier(first) == identifier(qualifier) else {
        fail("unknown conflict target table")
      }
      p.name()
    } else {
      first
    }
    result.push(name)
    if ordered {
      ignore(p.take("asc") || p.take("desc"))
    }
    if !p.take(",") {
      break
    }
  }
  p.expect(")")
  result
}

///|
fn precedence(word : String) -> Int32 {
  match word {
    "or" => 1
    "and" => 2
    "="
    | "=="
    | "!="
    | "<>"
    | "is"
    | "like"
    | "glob"
    | "not"
    | "in"
    | "between" => 3
    "<" | ">" | "<=" | ">=" => 4
    "<<" | ">>" | "&" | "|" => 5
    "+" | "-" => 6
    "*" | "/" | "%" => 7
    "||" | "->" | "->>" => 8
    "collate" => 9
    _ => 0
  }
}

///|
fn Parser::expression(p : Parser, minimum : Int32) -> Expr raise SqlError {
  p.depth += 1
  guard p.depth <= 64 else { fail("SQL expression depth limit") }
  let token = p.tokens[p.position]
  let word = p.peek()
  p.position += 1
  let mut left : Expr = if token.kind == 1 {
    Literal(Text(token.word))
  } else if token.kind == 3 {
    Literal(sql_number(token.word))
  } else if word == "null" {
    Literal(Null)
  } else if word == "true" {
    TruthLiteral(true)
  } else if word == "false" {
    TruthLiteral(false)
  } else if ["current_timestamp", "current_date", "current_time"].contains(word) {
    CurrentTime(
      if word == "current_timestamp" {
        "datetime"
      } else if word == "current_date" {
        "date"
      } else {
        "time"
      },
    )
  } else if token.kind == 5 {
    let index = match p.parameter_names.get(token.word) {
      Some(index) => index
      None => {
        guard p.parameter < 32766 else { fail("SQL parameter limit") }
        let index = p.parameter
        p.parameter += 1
        p.parameter_names[token.word] = index
        index
      }
    }
    Parameter(index)
  } else if word == "?" {
    let mut index = p.parameter
    if p.tokens[p.position].kind == 3 && p.tokens[p.position].start == token.end {
      index = (@string.parse_int(p.tokens[p.position].word) catch {
          _ => fail("invalid SQL parameter")
        }) -
        1
      p.position += 1
    }
    guard index >= 0 && index < 32766 else { fail("SQL parameter limit") }
    p.parameter = (index + 1).max(p.parameter)
    Parameter(index)
  } else if word == "(" {
    let e = if p.peek() == "select" || p.peek() == "with" {
      ScalarSelect(p.selection())
    } else {
      p.expression(1)
    }
    p.expect(")")
    e
  } else if word == "cast" {
    p.expect("(")
    let value = p.expression(1)
    p.expect("as")
    let names : Array[String] = []
    while p.peek() != ")" && p.peek() != "" {
      names.push(p.name())
    }
    p.expect(")")
    guard !names.is_empty() else { fail("missing CAST type") }
    Cast(value, affinity_name(names.join(" ")))
  } else if word == "exists" {
    p.expect("(")
    let select = p.selection()
    p.expect(")")
    Exists(select)
  } else if word == "case" {
    let base = if p.peek() == "when" { None } else { Some(p.expression(1)) }
    let arms : Array[(Expr, Expr)] = []
    p.expect("when")
    while true {
      let condition = p.expression(1)
      p.expect("then")
      arms.push((condition, p.expression(1)))
      if !p.take("when") {
        break
      }
    }
    let otherwise = if p.take("else") { p.expression(1) } else { Literal(Null) }
    p.expect("end")
    Case(base, arms, otherwise)
  } else if word == "-" &&
    p.tokens[p.position].kind == 3 &&
    p.tokens[p.position].word == "9223372036854775808" {
    p.position += 1
    Literal(Integer(-9223372036854775808L))
  } else if word == "-" || word == "+" || word == "not" || word == "~" {
    let start = p.position
    let e = p.expression(if word == "not" { 3 } else { 10 })
    if word == "-" &&
      sql_integer_min(e) &&
      p.tokens[start:p.position].any(t => {
        t.kind == 3 && identifier(t.word).has_prefix("0x")
      }) {
      fail("hex literal too big")
    }
    Unary(word, e)
  } else if word == "*" {
    Star("")
  } else if word == "x" && p.tokens[p.position].kind == 1 {
    let hex = p.tokens[p.position].word
    p.position += 1
    let hex = @utf8.encode(hex)
    guard hex.length() % 2 == 0 else { fail("invalid blob literal") }
    let b = @buffer.Buffer()
    for i = 0; i < hex.length(); i = i + 2 {
      let n = @string.parse_int(@utf8.decode_lossy(hex[i:i + 2]), base=16) catch {
        _ => fail("invalid blob literal")
      }
      b.write_byte(n.to_byte())
    }
    Literal(Blob(b.to_bytes()))
  } else if token.kind == 0 || token.kind == 2 {
    if p.take("(") {
      guard !token.word.has_prefix("$") && identifier(token.word) != "in" else {
        fail("unsupported SQL reserved function name")
      }
      let arguments : Array[Expr] = []
      let distinct_argument = p.take("distinct")
      if !p.take(")") {
        arguments.push(p.expression(1))
        while p.take(",") {
          arguments.push(p.expression(1))
        }
        p.expect(")")
      }
      if distinct_argument {
        guard arguments.length() == 1 else {
          fail("DISTINCT aggregates require one argument")
        }
        arguments[0] = Call("$distinct", [arguments[0]])
      }
      if p.take("filter") {
        guard !arguments.is_empty() &&
          aggregate_name(identifier(token.word), arguments.length()) else {
          fail("FILTER may only be used with an aggregate function")
        }
        p.expect("(")
        p.expect("where")
        let predicate = p.expression(1)
        p.expect(")")
        arguments[0] = Call("$filter", [arguments[0], predicate])
      }
      if p.take("over") {
        p.expect("(")
        let partitions : Array[Expr] = []
        if p.take("partition") {
          p.expect("by")
          partitions.push(p.expression(1))
          while p.take(",") {
            partitions.push(p.expression(1))
          }
        }
        let orders = if p.take("order") {
          p.expect("by")
          p.orderings()
        } else {
          []
        }
        let frame = p.window_frame()
        p.expect(")")
        Window(identifier(token.word), arguments, partitions, orders, frame)
      } else {
        Call(identifier(token.word), arguments)
      }
    } else if p.take(".") {
      if p.take("*") {
        Star(token.word)
      } else {
        Column(token.word, p.name())
      }
    } else {
      Column("", token.word)
    }
  } else {
    fail("SQL syntax: unexpected " + token.word)
  }
  while precedence(p.peek()) >= minimum && precedence(p.peek()) > 0 {
    let op = p.peek()
    let prec = precedence(op)
    p.position += 1
    if op == "collate" {
      let name = identifier(p.name())
      guard name == "binary" || name == "nocase" || name == "rtrim" else {
        fail("unsupported SQL collation")
      }
      left = Collate(left, name)
    } else if op == "->" || op == "->>" {
      left = Call(op, [left, p.expression(prec + 1)])
    } else if op == "is" {
      let negate = p.take("not")
      let distinct = p.take("distinct")
      if distinct {
        p.expect("from")
      }
      let op = if negate != distinct { "is not" } else { "is" }
      left = Binary(op, left, p.expression(prec + 1))
    } else if op == "not" ||
      op == "between" ||
      op == "in" ||
      op == "like" ||
      op == "glob" {
      let negate = op == "not"
      let operator = if negate {
        let o = p.peek()
        p.position += 1
        o
      } else {
        op
      }
      let expression = if operator == "between" {
        let low = p.expression(prec + 1)
        p.expect("and")
        Between(left, low, p.expression(prec + 1))
      } else if operator == "in" {
        p.expect("(")
        if p.peek() == "select" || p.peek() == "with" {
          let select = p.selection()
          p.expect(")")
          InSelect(left, select)
        } else {
          let arguments = [left]
          if !p.take(")") {
            arguments.push(p.expression(1))
            while p.take(",") {
              arguments.push(p.expression(1))
            }
            p.expect(")")
          }
          Call("in", arguments)
        }
      } else if operator == "glob" {
        Call("glob", [p.expression(prec + 1), left])
      } else if operator == "like" {
        let pattern = p.expression(prec + 1)
        if p.take("escape") {
          Call("like", [pattern, left, p.expression(5)])
        } else {
          Binary("like", left, pattern)
        }
      } else {
        fail("unsupported SQL NOT operator: " + operator)
      }
      left = if negate { Unary("not", expression) } else { expression }
    } else {
      left = Binary(op, left, p.expression(prec + 1))
    }
  }
  p.depth -= 1
  left
}

///|
fn Parser::orderings(p : Parser) -> Array[Ordering] raise SqlError {
  let orders : Array[Ordering] = []
  while true {
    let expression = p.expression(1)
    let descending = p.take("desc")
    if !descending {
      ignore(p.take("asc"))
    }
    let expression = if p.take("nulls") {
      let first = if p.take("first") {
        true
      } else {
        p.expect("last")
        false
      }
      if first == !descending {
        expression
      } else {
        Call(if first { "$nulls-first" } else { "$nulls-last" }, [expression])
      }
    } else {
      expression
    }
    orders.push({ expression, descending, })
    if !p.take(",") {
      break
    }
  }
  orders
}

///|
fn Parser::projections(p : Parser) -> Array[Projection] raise SqlError {
  let result : Array[Projection] = []
  while true {
    let start = p.tokens[p.position].start
    let expression = p.expression(1)
    let end = p.tokens[p.position - 1].end
    let explicit_label = p.peek() == "as" || p.tokens[p.position].kind == 2
    let label = if p.take("as") {
      p.name()
    } else if p.tokens[p.position].kind == 2 {
      p.name()
    } else {
      match expression {
        Column(_, name) => name
        _ => @utf8.decode_lossy(p.source[start:end])
      }
    }
    result.push({ expression, explicit_label, label, })
    if !p.take(",") {
      break
    }
  }
  result
}

///|
fn Parser::selection(
  p : Parser,
  arm~ : Bool = false,
) -> Selection raise SqlError {
  p.depth += 1
  guard p.depth <= 16 else { fail("SQL SELECT nesting limit") }
  let ctes : Array[(String, Selection)] = []
  let mut recursive : Bool? = None
  let names : Array[(String, Array[String])] = []
  if !arm && p.take("with") {
    if p.take("recursive") {
      recursive = Some(true)
    }
    while true {
      let name = p.name()
      if p.peek() == "(" {
        names.push((name, p.names()))
      }
      p.expect("as")
      p.expect("(")
      let select = p.selection()
      p.expect(")")
      ctes.push((name, select))
      if !p.take(",") {
        break
      }
    }
  }
  let is_values = p.take("values")
  if !is_values {
    p.expect("select")
  }
  let distinct = if is_values { false } else { p.take("distinct") }
  let projections = if is_values {
    p.expect("(")
    let columns : Array[Projection] = []
    while true {
      columns.push({
        expression: p.expression(1),
        explicit_label: true,
        label: "column" + (columns.length() + 1).to_string(),
      })
      if !p.take(",") {
        break
      }
    }
    p.expect(")")
    columns
  } else {
    p.projections()
  }
  let sources : Array[Source] = []
  if p.take("from") {
    let mut left = false
    let mut right = false
    let mut natural = false
    while true {
      let name = if p.take("(") {
        // NUL cannot occur in user SQL identifiers. A parse-local ordinal stays
        // stable when declarations are normalized, renamed, or read back.
        let name = "\u{0}derived:" + p.derived.to_string()
        p.derived += 1
        let query = p.selection()
        p.expect(")")
        ctes.push((name, query))
        name
      } else {
        p.name()
      }
      let qualifier = if p.take("as") {
        p.name()
      } else if p.tokens[p.position].kind == 2 ||
        (
          p.tokens[p.position].kind == 0 &&
          ![
            "where", "order", "group", "having", "limit", "join", "left", "inner",
            "cross", "using", "natural", "right", "full", "outer", "on", "returning",
            "union", "intersect", "except",
          ].contains(p.peek())
        ) {
        p.name()
      } else {
        name
      }
      let has_on = p.take("on")
      let on = if has_on {
        guard !natural else { fail("NATURAL join cannot have ON") }
        p.expression(1)
      } else {
        yes()
      }
      let using_columns = if p.take("using") {
        guard !natural && !has_on else {
          fail("USING cannot be combined with ON/NATURAL")
        }
        p.expect("(")
        let names = [p.name()]
        while p.take(",") {
          names.push(p.name())
        }
        p.expect(")")
        Some(names)
      } else {
        None
      }

      sources.push({
        name,
        qualifier,
        left,
        right: if right {
          Some(true)
        } else {
          None
        },
        using_columns,
        natural: if natural {
          Some(true)
        } else {
          None
        },
        on,
      })
      left = false
      right = false
      natural = p.take("natural")
      if p.take(",") {
        guard !natural else { fail("NATURAL requires JOIN") }
        continue
      }
      if p.take("join") {
        continue
      }
      if p.take("right") || p.take("full") {
        right = true
        left = identifier(p.tokens[p.position - 1].word) == "full"
        ignore(p.take("outer"))
        p.expect("join")
        continue
      }
      if p.take("left") {
        left = true
        ignore(p.take("outer"))
        p.expect("join")
        continue
      }
      if p.take("inner") || p.take("cross") {
        p.expect("join")
        continue
      }
      guard !natural else { fail("NATURAL requires JOIN") }
      break
    }
  }
  let predicate = if p.take("where") { p.expression(1) } else { yes() }
  let groups : Array[Expr] = []
  if p.take("group") {
    p.expect("by")
    groups.push(p.expression(1))
    while p.take(",") {
      groups.push(p.expression(1))
    }
  }
  let having = if p.take("having") { p.expression(1) } else { yes() }
  let compound : Array[(String, Selection)] = []
  if is_values {
    while p.take(",") {
      p.expect("(")
      let cols : Array[Projection] = []
      while true {
        cols.push({
          expression: p.expression(1),
          explicit_label: true,
          label: "column" + (cols.length() + 1).to_string(),
        })
        if !p.take(",") {
          break
        }
      }
      p.expect(")")
      compound.push(
        (
          "union all",
          {
            ctes: [],
            projections: cols,
            sources: [],
            predicate: yes(),
            groups: [],
            having: yes(),
            orders: [],
            limit: Literal(Integer(-1L)),
            offset: Literal(Integer(0L)),
            distinct: false,
            compound: None,
            recursive: None,
            cte_names: None,
          },
        ),
      )
    }
  }
  if !arm {
    while ["union", "intersect", "except"].contains(p.peek()) {
      let operator = p.peek()
      p.position += 1
      let operator = if operator == "union" && p.take("all") {
        "union all"
      } else {
        operator
      }
      compound.push((operator, p.selection(arm=true)))
    }
  }
  let orders = if !arm && p.take("order") {
    p.expect("by")
    p.orderings()
  } else {
    []
  }
  let limit = if !arm && p.take("limit") {
    p.expression(1)
  } else {
    Literal(Integer(-1L))
  }
  let offset = if !arm && p.take("offset") {
    p.expression(1)
  } else {
    Literal(Integer(0L))
  }
  p.depth -= 1
  {
    ctes,
    projections,
    sources,
    predicate,
    groups,
    having,
    orders,
    limit,
    offset,
    distinct,
    compound: if compound.is_empty() {
      None
    } else {
      Some(compound)
    },
    recursive,
    cte_names: if names.is_empty() {
      None
    } else {
      Some(names)
    },
  }
}

///|
fn Parser::setters(p : Parser) -> Array[(String, Expr)] raise SqlError {
  let result : Array[(String, Expr)] = []
  while true {
    let name = p.name()
    p.expect("=")
    result.push((name, p.expression(1)))
    if !p.take(",") {
      break
    }
  }
  result
}

///|
fn Parser::column_def(
  p : Parser,
) -> (ColumnDef, Bool, Bool, Array[Expr], ForeignReference?) raise SqlError {
  let name = p.name()
  let types : Array[String] = []
  while p.tokens[p.position].kind == 0 &&
        ![
          "primary", "not", "null", "unique", "check", "default", "references", "collate",
          "constraint", "generated",
        ].contains(p.peek()) {
    types.push(p.name())
  }
  let declared = types.join(" ").to_upper()
  let mut not_null = false
  let mut primary = false
  let mut primary_desc = false
  let mut unique = false
  let mut auto = false
  let mut default_value : Expr = Literal(Null)
  let mut default_source : String? = Some("")
  let mut collation = "binary"
  let checks : Array[Expr] = []
  let mut foreign : ForeignReference? = None
  while ![",", ")", ";", ""].contains(p.peek()) {
    if p.take("constraint") {
      ignore(p.name())
    }
    if p.take("primary") {
      p.expect("key")
      primary = true
      primary_desc = p.take("desc")
      if !primary_desc {
        ignore(p.take("asc"))
      }
      auto = p.take("autoincrement")
    } else if p.take("not") {
      p.expect("null")
      not_null = true
    } else if p.take("null") {
      ()
    } else if p.take("unique") {
      unique = true
    } else if p.take("default") {
      let start = p.tokens[p.position].start
      default_value = p.expression(9)
      let end = p.tokens[p.position - 1].end
      let raw = @utf8.decode_lossy(p.source[start:end])
      default_source = Some(
        if raw.has_prefix("(") && raw.has_suffix(")") {
          raw[1:raw.length() - 1].trim().to_owned()
        } else {
          raw
        },
      )
    } else if p.take("check") {
      p.expect("(")
      checks.push(p.expression(1))
      p.expect(")")
    } else if p.take("collate") {
      collation = identifier(p.name())
      guard ["binary", "nocase", "rtrim"].contains(collation) else {
        fail("unsupported SQL collation")
      }
    } else if p.take("references") {
      foreign = Some(p.foreign_reference())
    } else {
      fail("unsupported SQL column constraint: " + p.peek())
    }
  }
  (
    {
      name,
      declared,
      not_null,
      primary: if primary {
        1
      } else {
        0
      },
      default_value,
      default_source,
      collation,
      primary_desc: if primary_desc {
        Some(true)
      } else {
        None
      },
    },
    unique,
    auto,
    checks,
    foreign,
  )
}

///|
fn Parser::if_exists(p : Parser, create : Bool) -> Bool raise SqlError {
  if p.take("if") {
    if create {
      p.expect("not")
    }
    p.expect("exists")
    true
  } else {
    false
  }
}

///|
fn parse_statement(
  p : Parser,
  nested~ : Bool = false,
) -> ParsedStatement raise SqlError {
  let word = p.peek()
  let stmt : ParsedStatement = if word == "select" ||
    word == "with" ||
    word == "values" {
    Select(p.selection())
  } else if ["begin", "commit", "end", "rollback", "savepoint", "release"].contains(
      word,
    ) {
    p.position += 1
    if word == "begin" {
      if ["deferred", "immediate", "exclusive"].contains(p.peek()) {
        p.position += 1
      }
      ignore(p.take("transaction"))
      Transaction("begin", "")
    } else if word == "savepoint" || word == "release" {
      if word == "release" {
        ignore(p.take("savepoint"))
      }
      Transaction(word, p.name())
    } else if word == "rollback" {
      ignore(p.take("transaction"))
      if p.take("to") {
        ignore(p.take("savepoint"))
        Transaction("rollback to", p.name())
      } else {
        Transaction("rollback", "")
      }
    } else {
      ignore(p.take("transaction"))
      Transaction("commit", "")
    }
  } else if p.take("create") {
    let unique_index = p.take("unique")
    if p.take("table") {
      guard !unique_index else { fail("unsupported SQL CREATE UNIQUE TABLE") }
      let optional = p.if_exists(true)
      let name_start = p.tokens[p.position].start
      let name = p.name()
      p.expect("(")
      let columns : Array[ColumnDef] = []
      let uniques : Array[Array[String]] = []
      let primary : Array[String] = []
      let checks : Array[Expr] = []
      let foreign_keys : Array[ForeignKey] = []
      let references : Array[(Array[String], ForeignReference)] = []
      let mut autoincrement = false
      while true {
        if p.take("constraint") {
          ignore(p.name())
        }
        if p.take("foreign") {
          p.expect("key")
          let names = p.names()
          p.expect("references")
          references.push((names, p.foreign_reference()))
        } else if p.take("primary") {
          p.expect("key")
          for n in p.names(ordered=true) {
            primary.push(n)
          }
        } else if p.take("unique") {
          uniques.push(p.names())
        } else if p.take("check") {
          p.expect("(")
          checks.push(p.expression(1))
          p.expect(")")
        } else {
          let (col, unique, auto, col_checks, fk) = p.column_def()
          guard !columns.any(c => identifier(c.name) == identifier(col.name)) else {
            fail("duplicate column name")
          }
          let index = columns.length()
          columns.push(col)
          if col.primary > 0 {
            primary.push(col.name)
          }
          if unique {
            uniques.push([col.name])
          }
          autoincrement = autoincrement || auto
          for e in col_checks {
            checks.push(e)
          }
          if fk is Some(reference) {
            foreign_keys.push(make_foreign_key([index], reference))
          }
        }
        if !p.take(",") {
          break
        }
      }
      p.expect(")")
      for (names, reference) in references {
        let indices = names.map(name => {
          let mut i = -1
          for pos, col in columns {
            if identifier(col.name) == identifier(name) {
              i = pos
              break
            }
          }
          guard i >= 0 else { fail("unknown foreign key column") }
          i
        })
        foreign_keys.push(make_foreign_key(indices, reference))
      }
      let mut without_rowid = false
      let mut strict = false
      while true {
        if p.take("without") {
          guard !without_rowid else { fail("duplicate WITHOUT ROWID") }
          p.expect("rowid")
          without_rowid = true
        } else if p.take("strict") {
          guard !strict else { fail("duplicate STRICT") }
          strict = true
        } else {
          break
        }
        if !p.take(",") {
          break
        }
      }
      if strict {
        validate_strict_columns(columns)
      }
      guard !without_rowid || !primary.is_empty() else {
        fail("PRIMARY KEY missing on WITHOUT ROWID table")
      }
      let end = p.tokens[p.position - 1].end
      let sql = "CREATE TABLE " + @utf8.decode_lossy(p.source[name_start:end])
      let table : Table = {
        name,
        sql,
        columns,
        unique_keys: [],
        checks,
        foreign_keys,
        without_rowid,
        strict: if strict {
          Some(true)
        } else {
          None
        },
        autoincrement,
        sequence: 0L,
        sequence_present: None,
        rows: row_pages([]),
      }
      for pos, name in primary {
        table.columns[column_index(table, name)].primary = pos + 1
      }
      if !primary.is_empty() {
        uniques.push(primary)
      }
      for names in uniques {
        table.unique_keys.push(names.map(n => column_index(table, n)))
      }
      guard !autoincrement ||
        (
          primary.length() == 1 &&
          table.columns[column_index(table, primary[0])].declared == "INTEGER" &&
          !without_rowid &&
          integer_primary(table) >= 0
        ) else {
        fail("AUTOINCREMENT requires INTEGER PRIMARY KEY")
      }
      CreateTable(table, optional)
    } else if p.take("index") {
      let optional = p.if_exists(true)
      let name_start = p.tokens[p.position].start
      let name = p.name()
      p.expect("on")
      let table = p.name()
      p.expect("(")
      let terms : Array[Ordering] = []
      let columns : Array[String] = []
      while true {
        let expression = p.expression(1)
        let column = match expression {
          Column("", n) | Collate(Column("", n), _) => n
          _ => ""
        }
        let descending = p.take("desc")
        if !descending {
          ignore(p.take("asc"))
        }
        terms.push({ expression, descending, })
        columns.push(column)
        if !p.take(",") {
          break
        }
      }
      p.expect(")")
      let index_predicate = if p.take("where") {
        Some(p.expression(1))
      } else {
        None
      }
      let end = p.tokens[p.position - 1].end
      CreateObject(
        {
          kind: "index",
          name,
          table,
          sql: "CREATE " +
          (if unique_index { "UNIQUE " } else { "" }) +
          "INDEX " +
          @utf8.decode_lossy(p.source[name_start:end]),
          unique: unique_index,
          columns,
          query: "",
          selection: None,
          index_terms: if terms.any(t => {
              t.descending || !(t.expression is Column("", _))
            }) {
            Some(terms)
          } else {
            None
          },
          index_predicate,
          trigger: None,
        },
        optional,
      )
    } else if p.take("view") {
      guard !unique_index else { fail("unsupported UNIQUE view") }
      let optional = p.if_exists(true)
      let start = p.tokens[p.position].start
      let name = p.name()
      p.expect("as")
      let query_start = p.tokens[p.position].start
      let selection = p.selection()
      let end = p.tokens[p.position - 1].end
      CreateObject(
        {
          kind: "view",
          name,
          table: name,
          sql: "CREATE VIEW " + @utf8.decode_lossy(p.source[start:end]),
          unique: false,
          columns: [],
          query: @utf8.decode_lossy(p.source[query_start:end]),
          selection: Some(selection),
          index_terms: None,
          index_predicate: None,
          trigger: None,
        },
        optional,
      )
    } else if p.take("trigger") {
      guard !unique_index else { fail("unsupported UNIQUE trigger") }
      let optional = p.if_exists(true)
      let start = p.tokens[p.position].start
      let name = p.name()
      let timing = if p.take("after") {
        "after"
      } else {
        ignore(p.take("before"))
        "before"
      }
      let event = p.peek()
      guard ["insert", "update", "delete"].contains(event) else {
        fail("unsupported trigger event")
      }
      p.position += 1
      let columns : Array[String] = []
      if event == "update" && p.take("of") {
        columns.push(p.name())
        while p.take(",") {
          columns.push(p.name())
        }
      }
      p.expect("on")
      let table = p.name()
      if p.take("for") {
        p.expect("each")
        p.expect("row")
      }
      let condition = if p.take("when") { p.expression(1) } else { yes() }
      p.expect("begin")
      let body : Array[DataStatement] = []
      while !p.take("end") {
        guard body.length() < 1000 else { fail("trigger body resource limit") }
        let statement = parse_statement(p, nested=true)
        let data = match statement {
          Select(select) => PreparedSelect(select)
          Insert(insert) => {
            guard insert.returning.is_empty() &&
              !(insert.values.length() == 1 && insert.values[0].is_empty()) else {
              fail("unsupported trigger INSERT clause")
            }
            PreparedInsert(insert)
          }
          Update(name, setters, predicate, returning) => {
            guard returning.is_empty() else {
              fail("RETURNING is not allowed in triggers")
            }
            PreparedUpdate(name, setters, predicate, [])
          }
          Delete(name, predicate, returning) => {
            guard returning.is_empty() else {
              fail("RETURNING is not allowed in triggers")
            }
            PreparedDelete(name, predicate, [])
          }
          _ => fail("unsupported trigger body statement")
        }
        guard timing != "before" || data_readonly(data) else {
          fail("BEFORE triggers currently support validation SELECT only")
        }
        body.push(data)
        p.expect(";")
      }
      guard !body.is_empty() && p.parameter == 0 else {
        fail("invalid trigger body or parameter")
      }
      let end = p.tokens[p.position - 1].end
      CreateObject(
        {
          kind: "trigger",
          name,
          table,
          sql: "CREATE TRIGGER " + @utf8.decode_lossy(p.source[start:end]),
          unique: false,
          columns: [],
          query: "",
          selection: None,
          index_terms: None,
          index_predicate: None,
          trigger: Some({ timing, event, columns, condition, body, }),
        },
        optional,
      )
    } else {
      fail("unsupported SQL CREATE " + p.peek())
    }
  } else if p.take("drop") {
    let kind = p.peek()
    guard ["table", "view", "index", "trigger"].contains(kind) else {
      fail("unsupported SQL DROP")
    }
    p.position += 1
    let optional = p.if_exists(false)
    Drop(kind, p.name(), optional)
  } else if p.take("insert") || p.take("replace") {
    let mut conflict_override : String? = None
    let conflict = if word == "replace" {
      conflict_override = Some("replace")
      "replace"
    } else if p.take("or") {
      let c = p.peek()
      p.position += 1
      guard ["ignore", "replace", "abort"].contains(c) else {
        fail("unsupported conflict algorithm")
      }
      conflict_override = Some(c)
      c
    } else {
      "abort"
    }
    p.expect("into")
    let table = p.name()
    let columns = if p.peek() == "(" { p.names() } else { [] }
    let values : Array[Array[Expr]] = []
    let mut selection : Selection? = None
    if p.peek() == "select" || p.peek() == "with" {
      selection = Some(p.selection())
    } else if p.take("default") {
      p.expect("values")
      values.push([])
    } else {
      p.expect("values")
      while true {
        p.expect("(")
        let row : Array[Expr] = []
        row.push(p.expression(1))
        while p.take(",") {
          row.push(p.expression(1))
        }
        p.expect(")")
        values.push(row)
        if !p.take(",") {
          break
        }
      }
    }
    let mut target : Array[String] = []
    let mut target_predicate : Expr? = None
    let mut updates : Array[(String, Expr)] = []
    let mut predicate = yes()
    let mut conflict = conflict
    if p.take("on") {
      p.expect("conflict")
      if p.peek() == "(" {
        target = p.names(qualifier=table, ordered=true)
        if p.take("where") {
          target_predicate = Some(p.expression(1))
        }
      }
      p.expect("do")
      if p.take("nothing") {
        conflict = "nothing"
      } else {
        p.expect("update")
        p.expect("set")
        conflict = "update"
        updates = p.setters()
        if p.take("where") {
          predicate = p.expression(1)
        }
      }
    }
    let returning = if p.take("returning") { p.projections() } else { [] }
    Insert({
      table,
      columns,
      values,
      conflict,
      target,
      updates,
      predicate,
      returning,
      conflict_override,
      target_predicate,
      selection,
    })
  } else if p.take("update") {
    let name = p.name()
    p.expect("set")
    let setters = p.setters()
    let predicate = if p.take("where") { p.expression(1) } else { yes() }
    let returning = if p.take("returning") { p.projections() } else { [] }
    Update(name, setters, predicate, returning)
  } else if p.take("delete") {
    p.expect("from")
    let name = p.name()
    let predicate = if p.take("where") { p.expression(1) } else { yes() }
    let returning = if p.take("returning") { p.projections() } else { [] }
    Delete(name, predicate, returning)
  } else if p.take("pragma") {
    let name = identifier(p.name())
    if p.take("(") {
      let table = p.name()
      p.expect(")")
      Pragma(name, table, None)
    } else if p.take("=") {
      Pragma(name, "", Some(p.expression(1)))
    } else {
      Pragma(name, "", None)
    }
  } else if p.take("alter") {
    p.expect("table")
    let table = p.name()
    if p.take("add") {
      ignore(p.take("column"))
      let start = p.tokens[p.position].start
      let (col, unique, auto, checks, fk) = p.column_def()
      guard col.primary == 0 &&
        !unique &&
        !auto &&
        checks.is_empty() &&
        fk is None else {
        fail("unsupported ALTER ADD constraint")
      }
      let end = p.tokens[p.position - 1].end
      AddColumn(table, col, @utf8.decode_lossy(p.source[start:end]))
    } else if p.take("drop") {
      ignore(p.take("column"))
      DropColumn(table, p.name())
    } else {
      p.expect("rename")
      if p.take("to") {
        RenameTable(table, p.name())
      } else {
        ignore(p.take("column"))
        let old = p.name()
        p.expect("to")
        let quoted = p.tokens[p.position].kind == 2
        RenameColumn(table, old, p.name(), quoted)
      }
    }
  } else {
    fail("unsupported SQL statement: " + word)
  }
  if !nested {
    ignore(p.take(";"))
    guard p.peek() == "" else {
      fail("unsupported or trailing SQL: " + p.tokens[p.position].word)
    }
  }
  stmt
}
