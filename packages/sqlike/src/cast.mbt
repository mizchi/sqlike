///|
/// CAST integer reads a decimal prefix (unlike numeric affinity), saturating int64.
fn cast_integer(value : Value) -> Int64 {
  match value {
    Integer(n) => n
    Real(n) =>
      if n >= 9223372036854775808.0 {
        9223372036854775807L
      } else if n <= -9223372036854775808.0 {
        -9223372036854775808L
      } else {
        n.to_int64()
      }
    _ => {
      let bytes = @utf8.encode(
        text_value(value).trim_start(chars=" \t\n\r\u{b}\u{c}").to_owned(),
      )
      let negative = bytes.length() > 0 && bytes[0] == b'-'
      let start = if bytes.length() > 0 &&
        (bytes[0] == b'-' || bytes[0] == b'+') {
        1
      } else {
        0
      }
      let mut end = start
      while end < bytes.length() && bytes[end] >= b'0' && bytes[end] <= b'9' {
        end += 1
      }
      if end == start {
        return 0L
      }
      @string.parse_int64(@utf8.decode_lossy(bytes[0:end])) catch {
        _ => if negative { -9223372036854775808L } else { 9223372036854775807L }
      }
    }
  }
}

///|
fn cast_value(value : Value, target : String) -> Value raise SqlError {
  if value is Null {
    return Null
  }
  match target {
    "integer" => Integer(cast_integer(value))
    "text" => Text(checked_text_value(value))
    "blob" =>
      match value {
        Blob(_) => value
        _ => Blob(@utf8.encode(text_value(value)))
      }
    "real" =>
      match cast_numeric(value) {
        Integer(n) => Real(n.to_double())
        Real(_) as v => v
        _ => Real(0.0)
      }
    _ =>
      match value {
        Integer(_) | Real(_) => value
        _ =>
          match cast_numeric(value) {
            Real(n) =>
              if n >= -2251799813685248.0 &&
                n < 2251799813685248.0 &&
                n.to_int64().to_double() == n {
                Integer(n.to_int64())
              } else {
                Real(n)
              }
            v => v
          }
      }
  }
}

///|
fn cast_numeric(value : Value) -> Value {
  if value is Integer(_) || value is Real(_) {
    return value
  }
  let b = @utf8.encode(
    text_value(value).trim_start(chars=" \t\n\r\u{b}\u{c}").to_owned(),
  )
  let mut end = if b.length() > 0 && (b[0] == b'-' || b[0] == b'+') {
    1
  } else {
    0
  }
  let start = end
  while end < b.length() && b[end] >= b'0' && b[end] <= b'9' {
    end += 1
  }
  let mut digits = end - start
  if end < b.length() && b[end] == b'.' {
    end += 1
    let start = end
    while end < b.length() && b[end] >= b'0' && b[end] <= b'9' {
      end += 1
    }
    digits += end - start
  }
  if digits == 0 {
    return Integer(0L)
  }
  if end < b.length() && (b[end] == b'e' || b[end] == b'E') {
    let saved = end
    end += 1
    if end < b.length() && (b[end] == b'-' || b[end] == b'+') {
      end += 1
    }
    let start = end
    while end < b.length() && b[end] >= b'0' && b[end] <= b'9' {
      end += 1
    }
    if end == start {
      end = saved
    }
  }
  parse_number(@utf8.decode_lossy(b[0:end])) catch {
    _ => Integer(0L)
  }
}
