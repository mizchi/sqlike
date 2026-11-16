///|
/// Function metadata is checked while preparing, including unselected branches.
fn scalar_arity(name : String, count : Int32) -> Bool {
  match name {
    "substr" | "substring" => count == 2 || count == 3
    "trim" | "ltrim" | "rtrim" => count == 1 || count == 2
    "instr" | "nullif" => count == 2
    "replace" => count == 3
    "concat" => count >= 1
    "concat_ws" | "iif" | "if" => count >= 2
    "octet_length" | "quote" | "unicode" | "sign" => count == 1
    "round" => count == 1 || count == 2
    _ => false
  }
}

///|
fn saturated_add(a : Int64, b : Int64) -> Int64 {
  if b > 0L && a > 9223372036854775807L - b {
    9223372036854775807L
  } else if b < 0L && a < -9223372036854775808L - b {
    -9223372036854775808L
  } else {
    a + b
  }
}

///|
fn substring_bounds(
  size : Int32,
  start : Int64,
  count : Int64,
) -> (Int32, Int32) {
  let size = size.to_int64()
  let first = if start > 0L {
    start - 1L
  } else if start < 0L {
    saturated_add(size, start)
  } else {
    -1L
  }
  let (low, high) = if count >= 0L {
    (first, saturated_add(first, count))
  } else {
    (saturated_add(first, count), first)
  }
  (low.max(0L).min(size).to_int(), high.max(0L).min(size).to_int())
}

///|
/// SQLite substr counts Unicode scalar values for TEXT, bytes for BLOB.
fn substring_value(
  value : Value,
  start : Value,
  count : Value?,
) -> Value raise SqlError {
  if value is Null || start is Null || count is Some(Null) {
    return Null
  }
  let start = integer_value(start)
  // The native SQLite 3.53 oracle uses its default 1e9 value-length limit for an omitted count.
  let count = count.map(integer_value).unwrap_or(1000000000L)
  match value {
    Blob(bytes) => {
      let (first, last) = substring_bounds(bytes.length(), start, count)
      Blob(bytes[first:last].to_owned())
    }
    _ => {
      let chars : Array[Char] = []
      for char in checked_text_value(value).iter() {
        if char == '\u{0}' {
          break
        }
        chars.push(char)
      }
      let (first, last) = substring_bounds(chars.length(), start, count)
      Text(String::from_iter(chars[first:last].iter()))
    }
  }
}

///|
fn scalar_call(
  name : String,
  values : Array[Value],
  encoding : Int32,
) -> Value raise SqlError {
  match name {
    "sign" =>
      match numeric(values[0], true) {
        Integer(n) =>
          Integer(if n < 0L { -1L } else if n > 0L { 1L } else { 0L })
        Real(n) => Integer(if n < 0 { -1L } else if n > 0 { 1L } else { 0L })
        _ => Null
      }
    "unicode" => {
      if values[0] is Null {
        return Null
      }
      for c in checked_text_value(values[0]).iter() {
        return if c == '\u{0}' { Null } else { Integer(c.to_int().to_int64()) }
      }
      Null
    }
    "quote" => Text(sql_quote_value(values[0]))
    "round" => {
      if values.any(v => v is Null) {
        return Null
      }
      let n = if values.length() == 2 {
        integer_value(values[1]).max(0L).min(30L).to_int()
      } else {
        0
      }
      Real(sql_round(as_double(values[0]), n))
    }
    "substr" | "substring" =>
      substring_value(
        values[0],
        values[1],
        if values.length() == 3 {
          Some(values[2])
        } else {
          None
        },
      )
    "concat" | "concat_ws" => {
      if name == "concat_ws" && values[0] is Null {
        return Null
      }
      let separator = if name == "concat_ws" {
        checked_text_value(values[0])
      } else {
        ""
      }
      let first = if name == "concat_ws" { 1 } else { 0 }
      let strings : Array[String] = []
      for index in first..<values.length() {
        if !(values[index] is Null) {
          strings.push(checked_text_value(values[index]))
        }
      }
      Text(strings.join(separator))
    }
    "octet_length" =>
      match values[0] {
        Null => Null
        Blob(bytes) => Integer(bytes.length().to_int64())
        value => {
          let text = checked_text_value(value)
          Integer(
            (if encoding == 1 {
              @utf8.encode(text).length()
            } else {
              @utf16.encode(text).length()
            }).to_int64(),
          )
        }
      }
    "trim" | "ltrim" | "rtrim" => {
      if values.any(v => v is Null) {
        return Null
      }
      let text = checked_text_value(values[0])
      let chars = if values.length() == 2 {
        checked_text_value(values[1])
      } else {
        " "
      }
      Text(
        (if name == "trim" {
          text.trim(chars=chars[:])
        } else if name == "ltrim" {
          text.trim_start(chars=chars[:])
        } else {
          text.trim_end(chars=chars[:])
        }).to_owned(),
      )
    }
    "instr" => {
      if values.any(v => v is Null) {
        return Null
      }
      if values[0] is Blob(haystack) && values[1] is Blob(needle) {
        Integer(
          haystack.find(needle[:]).map(i => (i + 1).to_int64()).unwrap_or(0L),
        )
      } else {
        let haystack = checked_text_value(values[0])
        let needle = checked_text_value(values[1])
        match haystack.find(needle[:]) {
          None => Integer(0L)
          Some(index) =>
            Integer(haystack[:index].iter().count().to_int64() + 1L)
        }
      }
    }
    "replace" => {
      if values[0] is Null || values[1] is Null {
        return Null
      }
      let text = checked_text_value(values[0])
      let old = checked_text_value(values[1])
      if old == "" || old.has_prefix("\u{0}") {
        return Text(text)
      }
      if values[2] is Null {
        return Null
      }
      let new = checked_text_value(values[2])
      Text(text.replace_all(old=old[:], new=new[:]))
    }
    _ => fail("unsupported SQL function: " + name)
  }
}

///|
fn sql_quote_value(value : Value) -> String {
  match value {
    Null => "NULL"
    Integer(n) => n.to_string()
    Real(n) =>
      if !n.is_finite() {
        if n < 0.0 {
          "-9.0e+999"
        } else {
          "9.0e+999"
        }
      } else {
        sqlite_real_text(n)
      }
    Blob(b) =>
      "X'" +
      b
      .to_array()
      .map(c => {
        let h = "0123456789ABCDEF"
        h[c.to_int() >> 4:(c.to_int() >> 4) + 1].to_owned() +
        h[c.to_int() & 15:(c.to_int() & 15) + 1].to_owned()
      })
      .join("") +
      "'"
    Text(s) => {
      let chars : Array[Char] = []
      for c in s.iter() {
        if c == '\u{0}' {
          break
        }
        chars.push(c)
      }
      "'" + String::from_iter(chars.iter()).replace_all(old="'", new="''") + "'"
    }
  }
}

///|
/// Round SQLite's decimal rendering, avoiding a binary multiply by 10^n.
fn sql_round(value : Double, places : Int32) -> Double {
  if !value.is_finite() || value.abs() > 4503599627370496.0 {
    return value
  }
  if places == 0 {
    return (if value < 0.0 {
        -(value.abs() + 0.5).floor()
      } else {
        (value + 0.5).floor()
      }) +
      0.0
  }
  if value == 0.0 {
    return 0.0
  }
  let bits = value.abs().reinterpret_as_uint64()
  let exponent = ((bits >> 52) & 0x7ffUL).to_int()
  let mantissa = (bits & 0xfffffffffffffUL) |
    (if exponent == 0 { 0UL } else { 0x10000000000000UL })
  let power = if exponent == 0 { -1074 } else { exponent - 1075 }
  let ten = @bigint.BigInt::from_int(10).pow(@bigint.BigInt::from_int(places))
  let mut numerator = @bigint.BigInt::from_uint64(mantissa) * ten
  let mut denominator = @bigint.BigInt::from_int(1)
  if power >= 0 {
    numerator = numerator << power
  } else {
    denominator = denominator << -power
  }
  let rounded = (numerator + denominator / @bigint.BigInt::from_int(2)) /
    denominator
  let result = @string.parse_double(
    rounded.to_string() + "e-" + places.to_string(),
  ) catch {
    _ => 0.0
  }
  if value < 0.0 {
    -result
  } else {
    result
  }
}
