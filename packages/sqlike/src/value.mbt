///|
/// SQL decimal grammar only. Generic language parsers also accept hex, octal,
/// binary and separators, which are not numeric TEXT in SQLite.
fn decimal_end(bytes : Bytes, start : Int32) -> (Int32, Bool) {
  let mut i = start
  if i < bytes.length() && (bytes[i] == b'+' || bytes[i] == b'-') {
    i += 1
  }
  let first = i
  while i < bytes.length() && bytes[i] >= b'0' && bytes[i] <= b'9' {
    i += 1
  }
  let mut digits = i - first
  let mut real = false
  if i < bytes.length() && bytes[i] == b'.' {
    real = true
    i += 1
    let first = i
    while i < bytes.length() && bytes[i] >= b'0' && bytes[i] <= b'9' {
      i += 1
    }
    digits += i - first
  }
  if digits == 0 {
    return (start, false)
  }
  if i < bytes.length() && (bytes[i] == b'e' || bytes[i] == b'E') {
    let exponent = i
    i += 1
    if i < bytes.length() && (bytes[i] == b'+' || bytes[i] == b'-') {
      i += 1
    }
    let first = i
    while i < bytes.length() && bytes[i] >= b'0' && bytes[i] <= b'9' {
      i += 1
    }
    if first == i {
      i = exponent
    } else {
      real = true
    }
  }
  (i, real)
}

///|
fn parse_number(text : String) -> Value raise SqlError {
  let bytes = @utf8.encode(text)
  let (end, real) = decimal_end(bytes, 0)
  guard end > 0 && end == bytes.length() else {
    fail("invalid SQL number: " + text)
  }
  if !real {
    return Integer(@string.parse_int64(text)) catch {
      _ => Real(decimal_double(text))
    }
  }
  Real(decimal_double(text))
}

///|
fn numeric(value : Value, strict : Bool) -> Value {
  match value {
    Text(s) => {
      let s = s.trim(chars=" \t\n\r\u{b}\u{c}").to_owned()
      let bytes = @utf8.encode(s)
      let (end, _) = decimal_end(bytes, 0)
      if strict {
        if end == 0 || end != bytes.length() {
          return value
        }
        parse_number(s) catch {
          _ => value
        }
      } else {
        if end == 0 {
          return Integer(0L)
        }
        let parsed = parse_number(@utf8.decode_lossy(bytes[0:end])) catch {
          _ => Integer(0L)
        }
        // SQLite's integer fast parse rejects embedded NUL; atof still reads
        // its prefix, yielding REAL for this input rather than INTEGER.
        if parsed is Integer(n) && bytes.to_array().contains(b'\x00') {
          Real(n.to_double())
        } else {
          parsed
        }
      }
    }
    Blob(b) =>
      if strict {
        value
      } else {
        numeric(Text(@utf8.decode_lossy(b)), false)
      }
    _ => value
  }
}

///|
fn nocase_prefix(value : String) -> String {
  let chars : Array[Char] = []
  for c in value.iter() {
    if c == '\u{0}' {
      break
    }
    chars.push(c)
  }
  identifier(String::from_iter(chars.iter()))
}

///|
fn nocase_compare(a : String, b : String) -> Int32 {
  let x = @utf8.encode(identifier(a))
  let y = @utf8.encode(identifier(b))
  for i in 0..<x.length().min(y.length()) {
    let c = x[i].compare(y[i])
    if c != 0 {
      return c
    }
    if x[i] == b'\x00' {
      break
    }
  }
  x.length().compare(y.length())
}

///|
fn affinity_name(declared : String) -> String {
  let t = declared.to_upper()
  if t.contains("INT") {
    "integer"
  } else if t.contains("CHAR") || t.contains("CLOB") || t.contains("TEXT") {
    "text"
  } else if t.contains("BLOB") || t == "" {
    "blob"
  } else if t.contains("REAL") || t.contains("FLOA") || t.contains("DOUB") {
    "real"
  } else {
    "numeric"
  }
}

///|
fn text_value(value : Value) -> String {
  match value {
    Null => ""
    Integer(n) => n.to_string()
    Real(n) => sqlite_real_text(n)
    Text(s) => s
    Blob(b) => @utf8.decode_lossy(b)
  }
}

///|
fn apply_affinity(value : Value, affinity : String) -> Value {
  if affinity == "text" {
    match value {
      Integer(_) | Real(_) => Text(text_value(value))
      _ => value
    }
  } else if affinity == "integer" || affinity == "numeric" || affinity == "real" {
    let value = numeric(value, true)
    match value {
      Integer(n) => if affinity == "real" { Real(n.to_double()) } else { value }
      Real(n) =>
        if affinity != "real" &&
          n >= -9223372036854775808.0 &&
          n < 9223372036854775808.0 &&
          n.to_int64().to_double() == n {
          Integer(n.to_int64())
        } else {
          value
        }
      _ => value
    }
  } else {
    value
  }
}

///|
/// -1 = unknown, 0 = false, 1 = true.
fn truth(value : Value) -> Int32 {
  match numeric(value, false) {
    Null => -1
    Integer(n) => if n == 0L { 0 } else { 1 }
    Real(n) => if n == 0.0 { 0 } else { 1 }
    _ => 0
  }
}

///|
fn boolean(value : Bool) -> Value {
  Integer(if value { 1L } else { 0L })
}

///|
fn bytes_compare(a : Bytes, b : Bytes) -> Int32 {
  for i = 0; i < a.length().min(b.length()); i = i + 1 {
    if a[i] < b[i] {
      return -1
    }
    if a[i] > b[i] {
      return 1
    }
  }
  a.length().compare(b.length())
}

///|
/// Avoid rounding an Int64 to Double before comparison at the 2^53/2^63 edges.
fn integer_real_compare(i : Int64, r : Double) -> Int32 {
  if r >= 9223372036854775808.0 {
    -1
  } else if r < -9223372036854775808.0 {
    1
  } else {
    let truncated = r.to_int64()
    let c = i.compare(truncated)
    if c != 0 {
      c
    } else {
      i.to_double().compare(r)
    }
  }
}

///|
fn compare_value(a : Value, b : Value, collation : String) -> Int32 {
  fn rank(v : Value) -> Int32 {
    match v {
      Null => 0
      Integer(_) | Real(_) => 1
      Text(_) => 2
      Blob(_) => 3
    }
  }
  match (a, b) {
    (Integer(a), Integer(b)) => a.compare(b)
    (Real(a), Real(b)) => a.compare(b)
    (Integer(a), Real(b)) => integer_real_compare(a, b)
    (Real(a), Integer(b)) => -integer_real_compare(b, a)
    (Text(a), Text(b)) => {
      if collation == "nocase" {
        return nocase_compare(a, b)
      }
      let a = if collation == "rtrim" {
        a.trim_end(chars=" ").to_owned()
      } else {
        a
      }
      let b = if collation == "rtrim" {
        b.trim_end(chars=" ").to_owned()
      } else {
        b
      }
      bytes_compare(@utf8.encode(a), @utf8.encode(b))
    }
    (Blob(a), Blob(b)) => bytes_compare(a, b)
    _ => rank(a).compare(rank(b))
  }
}

///|
fn as_double(value : Value) -> Double {
  match numeric(value, false) {
    Integer(n) => n.to_double()
    Real(n) => n
    _ => 0.0
  }
}

///|
fn arithmetic(op : String, a : Value, b : Value) -> Value {
  if a is Null || b is Null {
    return Null
  }
  let a = numeric(a, false)
  let b = numeric(b, false)
  if op == "%" {
    let x = integer_value(a)
    let y = integer_value(b)
    if y == 0L {
      return Null
    }
    let remainder = if y == -1L { 0L } else { x % y }
    return if a is Real(_) || b is Real(_) {
      Real(remainder.to_double())
    } else {
      Integer(remainder)
    }
  }
  if a is Integer(x) && b is Integer(y) {
    if op == "+" {
      let z = x + y
      if (y >= 0L && z >= x) || (y < 0L && z < x) {
        return Integer(z)
      }
    } else if op == "-" {
      let z = x - y
      if (y >= 0L && z <= x) || (y < 0L && z > x) {
        return Integer(z)
      }
    } else if op == "*" {
      let z = x * y
      if y == 0L || (!(x == -9223372036854775808L && y == -1L) && z / y == x) {
        return Integer(z)
      }
    } else if op == "/" {
      if y == 0L {
        return Null
      }
      if !(x == -9223372036854775808L && y == -1L) {
        return Integer(x / y)
      }
    } else if op == "%" {
      return if y == 0L {
        Null
      } else if y == -1L {
        Integer(0L)
      } else {
        Integer(x % y)
      }
    }
  }
  let x = as_double(a)
  let y = as_double(b)
  match op {
    "+" => sql_real(x + y)
    "-" => sql_real(x - y)
    "*" => sql_real(x * y)
    "/" => if y == 0 { Null } else { sql_real(x / y) }
    "%" =>
      if y.to_int64() == 0L {
        Null
      } else if y.to_int64() == -1L {
        Real(0)
      } else {
        Real((x.to_int64() % y.to_int64()).to_double())
      }
    _ => Null
  }
}

///|
/// Iterative wildcard matching avoids recursive blowups on hostile LIKE input.
fn like(text : String, pattern : String) -> Bool {
  let text = nocase_prefix(text).to_array()
  let pattern = nocase_prefix(pattern).to_array()
  let mut previous = Array::make(text.length() + 1, false)
  previous[0] = true
  for c in pattern {
    let next = Array::make(text.length() + 1, false)
    if c == '%' {
      next[0] = previous[0]
    }
    for i = 1; i <= text.length(); i = i + 1 {
      next[i] = if c == '%' {
        previous[i] || next[i - 1]
      } else {
        previous[i - 1] && (c == '_' || c == text[i - 1])
      }
    }
    previous = next
  }
  previous[text.length()]
}

///|
/// SQLite BINARY compares bytes in the database encoding; NOCASE/RTRIM use
/// their UTF-8 collators. Newly created logical databases default to UTF-8.
fn compare_stored(
  store : Store,
  a : Value,
  b : Value,
  collation : String,
) -> Int32 {
  let encoding = store.encoding.unwrap_or(1)
  if collation == "binary" && encoding != 1 && a is Text(a) && b is Text(b) {
    let order : @utf16.Endian = if encoding == 2 { Little } else { Big }
    bytes_compare(
      @utf16.encode(a, endianness=order),
      @utf16.encode(b, endianness=order),
    )
  } else {
    compare_value(a, b, collation)
  }
}

///|
/// Remainder and integer casts do not round an existing INTEGER through Double.
fn integer_value(value : Value) -> Int64 {
  if value is Text(text) {
    let bytes = @utf8.encode(text)
    let mut index = 0
    while index < bytes.length() &&
          [9, 10, 11, 12, 13, 32].contains(bytes[index].to_int()) {
      index += 1
    }
    let negative = index < bytes.length() && bytes[index] == b'-'
    if index < bytes.length() && (bytes[index] == b'-' || bytes[index] == b'+') {
      index += 1
    }
    let limit = if negative {
      9223372036854775808UL
    } else {
      9223372036854775807UL
    }
    let mut number = 0UL
    while index < bytes.length() && bytes[index] >= b'0' && bytes[index] <= b'9' {
      let digit = (bytes[index].to_int() - 48).to_uint64()
      if number > (limit - digit) / 10UL {
        return if negative {
          -9223372036854775808L
        } else {
          9223372036854775807L
        }
      }
      number = number * 10UL + digit
      index += 1
    }
    return if negative {
      (0UL - number).reinterpret_as_int64()
    } else {
      number.reinterpret_as_int64()
    }
  }
  if value is Blob(bytes) {
    return integer_value(Text(@utf8.decode_lossy(bytes)))
  }
  match numeric(value, false) {
    Integer(n) => n
    Real(n) =>
      if n >= 9223372036854775808.0 {
        9223372036854775807L
      } else if n <= -9223372036854775808.0 {
        -9223372036854775808L
      } else {
        n.to_int64()
      }
    _ => 0L
  }
}

///|
fn shift_value(op : String, a : Value, b : Value) -> Value {
  if a is Null || b is Null {
    return Null
  }
  let a = integer_value(a)
  let b = integer_value(b)
  let left = (op == "<<") != (b < 0L)
  if b >= 64L || b <= -64L {
    return Integer(if !left && a < 0L { -1L } else { 0L })
  }
  let n = b.abs().to_int()
  Integer(if left { a << n } else { a >> n })
}

///|
/// Grammar has already been checked. The core parser rejects overflow whereas
/// SQLite represents it as IEEE infinity; underflow remains signed zero.
fn decimal_double(text : String) -> Double {
  @string.parse_double(text) catch {
    _ => {
      let lower = identifier(text)
      let parts = lower.split("e").to_array()
      let zero = parts[0]
        .to_owned()
        .iter()
        .all(c => c == '0' || c == '.' || c == '+' || c == '-')
      let underflow = parts.length() > 1 && parts[1].has_prefix("-")
      let value = if zero || underflow {
        0.0
      } else {
        0x7ff0000000000000UL.reinterpret_as_double()
      }
      if text.has_prefix("-") {
        -value
      } else {
        value
      }
    }
  }
}

///|
fn sql_real(n : Double) -> Value {
  if n.is_nan() {
    Null
  } else {
    Real(n)
  }
}
