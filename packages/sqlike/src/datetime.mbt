///|
/// Proleptic Gregorian arithmetic, independent of host Date/timezone APIs.
fn date_floor(a : Int64, b : Int64) -> Int64 {
  let q = a / b
  if a % b < 0L {
    q - 1L
  } else {
    q
  }
}

///|
fn civil_days(year : Int64, month : Int64, day : Int64) -> Int64 {
  let y = year - (if month <= 2L { 1L } else { 0L })
  let era = date_floor(y, 400L)
  let yoe = y - era * 400L
  let m = month + (if month > 2L { -3L } else { 9L })
  era * 146097L +
  yoe * 365L +
  yoe / 4L -
  yoe / 100L +
  (153L * m + 2L) / 5L +
  day -
  1L -
  719468L
}

///|
fn date_civil(days : Int64) -> (Int64, Int64, Int64) {
  let z = days + 719468L
  let era = date_floor(z, 146097L)
  let doe = z - era * 146097L
  let yoe = (doe - doe / 1460L + doe / 36524L - doe / 146096L) / 365L
  let y = yoe + era * 400L
  let doy = doe - (365L * yoe + yoe / 4L - yoe / 100L)
  let mp = (5L * doy + 2L) / 153L
  let d = doy - (153L * mp + 2L) / 5L + 1L
  let m = mp + (if mp < 10L { 3L } else { -9L })
  (y + (if m <= 2L { 1L } else { 0L }), m, d)
}

///|
fn date_pad(n : Int64, width : Int32) -> String {
  let s = n.abs().to_string()
  (if n < 0L { "-" } else { "" }) + decimal_zeros(width - s.length()) + s
}

///|
fn date_digits(b : Bytes, start : Int32, count : Int32) -> Int64? {
  if start < 0 || start + count > b.length() {
    return None
  }
  let mut value = 0L
  for i in start..<(start + count) {
    if b[i] < b'0' || b[i] > b'9' {
      return None
    }
    value = value * 10L + (b[i].to_int() - 48).to_int64()
  }
  Some(value)
}

///|
fn date_parse(
  value : Value,
  epoch : Bool,
  auto : Bool,
  clock : Int64?,
) -> Int64? {
  if value is Null {
    return None
  }
  if identifier(text_value(value)) == "now" {
    return clock
  }
  let raw = text_value(value)
  let number = match value {
    Integer(n) => Some(n.to_double())
    Real(n) => Some(n)
    _ =>
      match cast_numeric(value) {
        Integer(_) | Real(_) =>
          Some(@string.parse_double(raw)) catch {
            _ => None
          }
        _ => None
      }
  }
  if number is Some(n) {
    let ms = if epoch || (auto && (n < 0.0 || n >= 5373484.5)) {
      n * 1000.0
    } else {
      (n - 2440587.5) * 86400000.0
    }
    if !ms.is_finite() || ms < -210866760000000.0 || ms > 253402300799999.0 {
      return None
    }
    return Some((ms + 210866760000000.5).to_int64() - 210866760000000L)
  }
  let b = @utf8.encode(raw)
  let mut pos = 0
  let mut y = 2000L
  let mut m = 1L
  let mut d = 1L
  if b.length() >= 10 && b[4] == b'-' && b[7] == b'-' {
    guard date_digits(b, 0, 4) is Some(yy) &&
      date_digits(b, 5, 2) is Some(mm) &&
      date_digits(b, 8, 2) is Some(dd) else {
      return None
    }
    y = yy
    m = mm
    d = dd
    pos = 10
    if m < 1L || m > 12L || d < 1L || d > 31L {
      return None
    }
    while pos < b.length() && (b[pos] == b' ' || b[pos] == b'T') {
      pos += 1
    }
  }
  let mut hour = 0L
  let mut minute = 0L
  let mut second = 0L
  let mut fraction = 0L
  if pos < b.length() && b[pos] != b'Z' && b[pos] != b'z' {
    guard pos + 5 <= b.length() &&
      b[pos + 2] == b':' &&
      date_digits(b, pos, 2) is Some(h) &&
      date_digits(b, pos + 3, 2) is Some(mi) else {
      return None
    }
    hour = h
    minute = mi
    pos += 5
    if pos < b.length() && b[pos] == b':' {
      guard date_digits(b, pos + 1, 2) is Some(sec) else { return None }
      second = sec
      pos += 3
      if pos < b.length() && b[pos] == b'.' {
        pos += 1
        let start = pos
        while pos < b.length() && b[pos] >= b'0' && b[pos] <= b'9' {
          pos += 1
        }
        if pos == start {
          return None
        }
        let digits = @utf8.decode_lossy(b[start:pos]) + "000"
        fraction = ((@string.parse_double("0." + digits) catch { _ => 0.0 }) *
        1000.0 +
        0.5).to_int64()
      }
    }
    if hour > 24L || minute > 59L || second > 59L {
      return None
    }
  }
  let mut offset = 0L
  while pos < b.length() && b[pos] == b' ' {
    pos += 1
  }
  if pos < b.length() && (b[pos] == b'+' || b[pos] == b'-') {
    let sign = if b[pos] == b'-' { -1L } else { 1L }
    guard pos + 6 <= b.length() &&
      b[pos + 3] == b':' &&
      date_digits(b, pos + 1, 2) is Some(h) &&
      date_digits(b, pos + 4, 2) is Some(mi) &&
      h <= 14L &&
      mi < 60L else {
      return None
    }
    offset = sign * (h * 60L + mi) * 60000L
    pos += 6
  } else if pos < b.length() && (b[pos] == b'Z' || b[pos] == b'z') {
    pos += 1
  }
  while pos < b.length() && b[pos] == b' ' {
    pos += 1
  }
  if pos != b.length() || b.length() == 0 {
    return None
  }
  Some(
    civil_days(y, m, d) * 86400000L +
    hour * 3600000L +
    minute * 60000L +
    second * 1000L +
    fraction -
    offset,
  )
}

///|
fn datetime_arity(name : String, count : Int32) -> Bool {
  ["date", "time", "datetime", "julianday", "unixepoch"].contains(name) ||
  (name == "strftime" && count >= 1)
}

///|
fn datetime_call(
  name : String,
  values : Array[Value],
  clock : Int64?,
) -> Value raise SqlError {
  for value in values {
    if value is Blob(_) {
      ignore(checked_text_value(value))
    }
  }
  let begin = if name == "strftime" { 1 } else { 0 }
  if values.any(v => v is Null) {
    return Null
  }
  let input = if values.length() > begin { values[begin] } else { Text("now") }
  let mods = if values.length() > begin + 1 {
    values[begin + 1:].to_owned().map(v => identifier(text_value(v)))
  } else {
    []
  }
  let epoch = !mods.is_empty() && mods[0] == "unixepoch"
  let auto = !mods.is_empty() && mods[0] == "auto"
  guard date_parse(input, epoch, auto, clock) is Some(parsed) else {
    return Null
  }
  let mut ms = parsed
  let mut overflow = 0L
  let mut subsec = false
  for i, modifier in mods {
    if i == 0 &&
      (modifier == "unixepoch" || modifier == "auto" || modifier == "julianday") {
      continue
    }
    if modifier == "subsec" || modifier == "subsecond" {
      subsec = true
      continue
    }
    if modifier == "floor" {
      ms -= overflow * 86400000L
      overflow = 0L
      continue
    }
    if modifier == "ceiling" {
      overflow = 0L
      continue
    }
    overflow = 0L
    let days = date_floor(ms, 86400000L)
    let remainder = ms - days * 86400000L
    let (y, m, d) = date_civil(days)
    if modifier == "start of day" {
      ms = days * 86400000L
    } else if modifier == "start of month" {
      ms = civil_days(y, m, 1L) * 86400000L
    } else if modifier == "start of year" {
      ms = civil_days(y, 1L, 1L) * 86400000L
    } else if modifier.has_prefix("weekday ") {
      guard (@string.parse_int64(modifier[8:].to_owned()) catch { _ => -1L })
        is n &&
        n >= 0L &&
        n <= 6L else {
        return Null
      }
      let weekday = ((days + 4L) % 7L + 7L) % 7L
      ms += (n - weekday + 7L) % 7L * 86400000L
    } else {
      let parts = modifier.split(" ").to_array().filter(v => !v.is_empty())
      if parts.length() != 2 {
        return Null
      }
      let n = @string.parse_double(parts[0].to_owned()) catch {
        _ => return Null
      }
      let unit = parts[1].to_owned().trim_end(chars="s").to_owned()
      if unit == "month" || unit == "year" {
        let months = if unit == "year" { n * 12.0 } else { n }
        let whole = months.to_int64()
        let target = y * 12L + m - 1L + whole
        let yy = date_floor(target, 12L)
        let mm = target - yy * 12L + 1L
        let max = civil_days(yy, mm + 1L, 1L) - civil_days(yy, mm, 1L)
        ms = civil_days(yy, mm, d) * 86400000L +
          remainder +
          ((months - whole.to_double()) * 30.0 * 86400000.0).to_int64()
        overflow = (d - max).max(0L)
      } else {
        let factor = match unit {
          "day" => 86400000.0
          "hour" => 3600000.0
          "minute" => 60000.0
          "second" => 1000.0
          _ => return Null
        }
        let increment = n * factor
        if !increment.is_finite() || increment.abs() > 464269060799999.0 {
          return Null
        }
        ms += increment.to_int64()
      }
    }
  }
  if ms < -210866760000000L || ms > 253402300799999L {
    return Null
  }
  if name == "julianday" {
    return Real(ms.to_double() / 86400000.0 + 2440587.5)
  }
  if name == "unixepoch" {
    return if subsec {
      Real(ms.to_double() / 1000.0)
    } else {
      Integer(date_floor(ms, 1000L))
    }
  }
  let days = date_floor(ms, 86400000L)
  let (y, m, d) = date_civil(days)
  let rest = ms - days * 86400000L
  let hour = rest / 3600000L
  let minute = rest / 60000L % 60L
  let second = rest / 1000L % 60L
  let date = date_pad(y, 4) + "-" + date_pad(m, 2) + "-" + date_pad(d, 2)
  let time = date_pad(hour, 2) +
    ":" +
    date_pad(minute, 2) +
    ":" +
    date_pad(second, 2) +
    (if subsec { "." + date_pad(rest % 1000L, 3) } else { "" })
  if name == "date" {
    return Text(date)
  }
  if name == "time" {
    return Text(time)
  }
  if name == "datetime" {
    return Text(date + " " + time)
  }
  let format = @utf8.encode(text_value(values[0]))
  let out = @buffer.Buffer()
  let mut i = 0
  while i < format.length() {
    if format[i] != b'%' {
      out.write_byte(format[i])
      i += 1
      continue
    }
    i += 1
    if i == format.length() {
      return Null
    }
    let value = match format[i].to_int() {
      37 => "%"
      89 => date_pad(y, 4)
      109 => date_pad(m, 2)
      100 => date_pad(d, 2)
      101 => d.to_string()
      72 => date_pad(hour, 2)
      107 => hour.to_string()
      73 => date_pad((hour + 11L) % 12L + 1L, 2)
      108 => ((hour + 11L) % 12L + 1L).to_string()
      77 => date_pad(minute, 2)
      83 => date_pad(second, 2)
      102 => date_pad(second, 2) + "." + date_pad(rest % 1000L, 3)
      70 => date
      82 => date_pad(hour, 2) + ":" + date_pad(minute, 2)
      84 =>
        date_pad(hour, 2) +
        ":" +
        date_pad(minute, 2) +
        ":" +
        date_pad(second, 2)
      115 => date_floor(ms, 1000L).to_string()
      119 => (((days + 4L) % 7L + 7L) % 7L).to_string()
      117 => (((days + 3L) % 7L + 7L) % 7L + 1L).to_string()
      106 => date_pad(days - civil_days(y, 1L, 1L) + 1L, 3)
      85 =>
        date_pad(
          (days - civil_days(y, 1L, 1L) + 7L - ((days + 4L) % 7L + 7L) % 7L) /
          7L,
          2,
        )
      87 =>
        date_pad(
          (days - civil_days(y, 1L, 1L) + 7L - ((days + 3L) % 7L + 7L) % 7L) /
          7L,
          2,
        )
      86 | 71 | 103 => {
        let thursday = days + 3L - ((days + 3L) % 7L + 7L) % 7L
        let (iso_year, _, _) = date_civil(thursday)
        if format[i].to_int() == 71 {
          date_pad(iso_year, 4)
        } else if format[i].to_int() == 103 {
          date_pad(iso_year % 100L, 2)
        } else {
          date_pad((thursday - civil_days(iso_year, 1L, 1L)) / 7L + 1L, 2)
        }
      }
      112 => if hour < 12L { "AM" } else { "PM" }
      80 => if hour < 12L { "am" } else { "pm" }
      74 => text_value(Real(ms.to_double() / 86400000.0 + 2440587.5))
      _ => return Null
    }
    out.write_bytes(@utf8.encode(value))
    i += 1
  }
  Text(@utf8.decode_lossy(out.to_bytes()))
}

///|
/// One clock instant is supplied by the host before executing a statement.
pub fn database_set_clock(db : Database, milliseconds : String) -> String {
  try {
    let value = @string.parse_int64(milliseconds)
    db.store.triggers.clock = Some(value)
    "{}"
  } catch {
    e => public_error_json(e).stringify()
  }
}
