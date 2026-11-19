///|
/// Deliberately bounded portable subset of SQLite's SQL formatter. Floating
/// conversions and newer escaping dialects fail explicitly until differential
/// tests establish their exact output across supported SQLite versions.
const FORMAT_OUTPUT_LIMIT : Int32 = 1048576

///|
priv struct FormatArguments {
  values : Array[Value]
  mut index : Int32
}

///|
fn FormatArguments::next(self : FormatArguments) -> Value {
  let index = self.index
  self.index += 1
  self.values.get(index).unwrap_or(Null)
}

///|
fn format_extent(value : Int64) -> Int32 raise SqlError {
  guard value >= -1048576L && value <= 1048576L else {
    fail("format output limit exceeded")
  }
  value.abs().to_int()
}

///|
fn format_repeat(text : String, count : Int32) -> String raise SqlError {
  let bytes = @utf8.encode(text).length()
  guard count >= 0 && (bytes == 0 || count <= FORMAT_OUTPUT_LIMIT / bytes) else {
    fail("format output limit exceeded")
  }
  let out = StringBuilder()
  for _ in 0..<count {
    out.write_string(text)
  }
  out.to_string()
}

///|
fn format_terminated(text : String) -> String {
  let out = StringBuilder()
  for c in text.iter() {
    if c == '\u{0}' {
      break
    }
    out.write_char(c)
  }
  out.to_string()
}

///|
fn format_number(
  chars : Array[Char],
  start : Int32,
) -> (Int32, Int32) raise SqlError {
  let mut value = 0
  let mut i = start
  while i < chars.length() && chars[i] >= '0' && chars[i] <= '9' {
    value = value * 10 + chars[i].to_int() - 48
    guard value <= FORMAT_OUTPUT_LIMIT else {
      fail("format output limit exceeded")
    }
    i += 1
  }
  (value, i)
}

///|
fn format_string_slice(
  text : String,
  precision : Int32,
  characters : Bool,
) -> String raise SqlError {
  if precision < 0 {
    return text
  }
  if characters {
    let chars = text.iter().to_array()
    return String::from_iter(chars[0:precision].iter())
  }
  let bytes = @utf8.encode(text)
  @utf8.decode(bytes[0:precision].to_owned()) catch {
    _ => fail("unsupported format: precision splits a UTF-8 character")
  }
}

///|
fn format_integer(
  value : Value,
  kind : Char,
  width : Int32,
  precision : Int32,
  zero : Bool,
  plus : Bool,
  space : Bool,
  alternate : Bool,
  comma : Bool,
) -> String raise SqlError {
  let n = integer_value(value)
  let signed = kind == 'd' || kind == 'i'
  let magnitude = if signed && n < 0L {
    0UL - n.reinterpret_as_uint64()
  } else {
    n.reinterpret_as_uint64()
  }
  let sign = if signed {
    if n < 0L {
      "-"
    } else if plus {
      "+"
    } else if space {
      " "
    } else {
      ""
    }
  } else {
    ""
  }
  let base = if kind == 'o' {
    8UL
  } else if ['x', 'X', 'p'].contains(kind) {
    16UL
  } else {
    10UL
  }
  let alphabet = if kind == 'X' || kind == 'p' {
    b"0123456789ABCDEF"
  } else {
    b"0123456789abcdef"
  }
  let mut remaining = magnitude
  let mut digits = ""
  while true {
    digits = alphabet[(remaining % base).to_int()]
      .to_int()
      .unsafe_to_char()
      .to_string() +
      digits
    remaining = remaining / base
    if remaining == 0UL {
      break
    }
  }
  let precision = if zero {
    precision.max(width - sign.length())
  } else {
    precision
  }
  digits = format_repeat("0", (precision - digits.length()).max(0)) + digits
  if comma && base == 10UL {
    let out = StringBuilder()
    for i, c in digits.iter().to_array() {
      if i > 0 && (digits.length() - i) % 3 == 0 {
        out.write_char(',')
      }
      out.write_char(c)
    }
    digits = out.to_string()
  }
  let prefix = if alternate && magnitude != 0UL {
    if kind == 'o' {
      "0"
    } else if kind == 'x' || kind == 'p' {
      "0x"
    } else if kind == 'X' {
      "0X"
    } else {
      ""
    }
  } else {
    ""
  }
  prefix + sign + digits
}

///|
fn format_value(values : Array[Value]) -> Value raise SqlError {
  if values.is_empty() || values[0] is Null {
    return Null
  }
  let template = format_terminated(checked_text_value(values[0]))
  if template.is_empty() {
    fail("unsupported SQL: empty format differs across SQLite versions")
  }
  guard @utf8.encode(template).length() <= FORMAT_OUTPUT_LIMIT else {
    fail("format output limit exceeded")
  }
  let chars = template.iter().to_array()
  let args : FormatArguments = { values, index: 1, }
  let out = StringBuilder()
  let mut size = 0
  let mut i = 0
  while i < chars.length() {
    if chars[i] != '%' {
      let start = i
      while i < chars.length() && chars[i] != '%' {
        i += 1
      }
      let text = String::from_iter(chars[start:i].iter())
      size += @utf8.encode(text).length()
      guard size <= FORMAT_OUTPUT_LIMIT else {
        fail("format output limit exceeded")
      }
      out.write_string(text)
      continue
    }
    i += 1
    if i == chars.length() {
      guard size < FORMAT_OUTPUT_LIMIT else {
        fail("format output limit exceeded")
      }
      out.write_char('%')
      break
    }
    let mut left = false
    let mut zero = false
    let mut plus = false
    let mut space = false
    let mut alternate = false
    let mut characters = false
    let mut comma = false
    while i < chars.length() {
      match chars[i] {
        '-' => left = true
        '0' => zero = true
        '+' => plus = true
        ' ' => space = true
        '#' => alternate = true
        '!' => characters = true
        ',' => comma = true
        _ => break
      }
      i += 1
    }
    let width = if i < chars.length() && chars[i] == '*' {
      i += 1
      let n = integer_value(args.next())
      if n < 0L {
        left = true
      }
      format_extent(n)
    } else {
      let (n, next) = format_number(chars, i)
      i = next
      n
    }
    let precision = if i < chars.length() && chars[i] == '.' {
      i += 1
      if i < chars.length() && chars[i] == '*' {
        i += 1
        format_extent(integer_value(args.next()))
      } else {
        let (n, next) = format_number(chars, i)
        i = next
        n
      }
    } else {
      -1
    }
    if i < chars.length() && chars[i] == 'l' {
      i += 1
      if i < chars.length() && chars[i] == 'l' {
        i += 1
      }
    }
    guard i < chars.length() else {
      fail("unsupported format: incomplete substitution")
    }
    let kind = chars[i]
    i += 1
    if kind == 'n' {
      continue
    }
    let value : Value = if kind == '%' { Null } else { args.next() }
    let text = if ['d', 'i', 'u', 'x', 'X', 'o', 'p'].contains(kind) {
      format_integer(
        value, kind, width, precision, zero, plus, space, alternate, comma,
      )
    } else if kind == '%' {
      "%"
    } else if kind == 'c' {
      let text = format_terminated(checked_text_value(value))
      let first = text.iter().next().unwrap_or('\u{0}')
      format_repeat(first.to_string(), precision.max(1))
    } else if ['s', 'z', 'q', 'Q', 'w'].contains(kind) {
      guard !alternate || (kind != 'q' && kind != 'Q') else {
        fail("unsupported format: alternate SQL escaping")
      }
      if value is Null && kind == 'Q' {
        format_string_slice("NULL", precision, characters)
      } else {
        let text = if value is Null {
          if kind == 'q' || kind == 'w' {
            "(NULL)"
          } else {
            ""
          }
        } else {
          format_terminated(checked_text_value(value))
        }
        guard @utf8.encode(text).length() <= FORMAT_OUTPUT_LIMIT else {
          fail("format output limit exceeded")
        }
        let text = format_string_slice(text, precision, characters)
        if kind == 'q' || kind == 'Q' || kind == 'w' {
          // Quote escaping can double the retained bytes. Check before replacing.
          guard @utf8.encode(text).length() <= (FORMAT_OUTPUT_LIMIT - 2) / 2 else {
            fail("format output limit exceeded")
          }
          let text = if kind == 'w' {
            text.replace_all(old="\"", new="\"\"")
          } else {
            text.replace_all(old="'", new="''")
          }
          if kind == 'Q' {
            "'" + text + "'"
          } else {
            text
          }
        } else {
          text
        }
      }
    } else {
      fail("unsupported format conversion: " + kind.to_string())
    }
    let length = if kind == 'c' || characters {
      text.iter().count()
    } else {
      @utf8.encode(text).length()
    }
    let padding = (width - length).max(0)
    let bytes = @utf8.encode(text).length()
    guard padding <= FORMAT_OUTPUT_LIMIT - size &&
      bytes <= FORMAT_OUTPUT_LIMIT - size - padding else {
      fail("format output limit exceeded")
    }
    let spaces = format_repeat(" ", padding)
    if !left {
      out.write_string(spaces)
    }
    out.write_string(text)
    if left {
      out.write_string(spaces)
    }
    size += bytes + padding
  }
  Text(out.to_string())
}
