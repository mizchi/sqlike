///|
/// Parse the requested prefix of decimal digits into an unsigned integer.
fn decimal_prefix(digits : String, n : Int32) -> UInt64 {
  let mut value = 0UL
  for c in digits[0:n].to_owned().iter() {
    value = value * 10UL + (c.to_int() - 48).to_uint64()
  }
  value
}

///|
fn decimal_zeros(n : Int32) -> String {
  Array::make(n.max(0), "0").join("")
}

///|
/// SQLite 3.53's %!.17g numeric rendering: normalized binary-to-decimal conversion,
/// round-trip shortening for long 9/0 tails, then rounding to 17 digits.
/// Binary-to-decimal conversion uses integer arithmetic; shortening probes parse
/// candidate decimals back to Double. Reference: sqlite3FpDecode and numeric rendering.
fn sqlite_real_text(value : Double) -> String {
  if value == 0.0 {
    return "0.0"
  }
  if !value.is_finite() {
    return if value < 0.0 { "-Inf" } else { "Inf" }
  }
  let bits = value.abs().reinterpret_as_uint64()
  let exponent = ((bits >> 52) & 0x7ffUL).to_int()
  let mut mantissa = bits & 0xfffffffffffffUL
  let mut binary = exponent - 1086
  if exponent == 0 {
    let mut leading = 0
    while (mantissa & 0x8000000000000000UL) == 0UL {
      mantissa = mantissa << 1
      leading += 1
    }
    binary = -1074 - leading
  } else {
    mantissa = (mantissa << 11) | 0x8000000000000000UL
  }
  // Mirror SQLite's normalized 64-bit power-of-ten multiplication. Using a
  // fixed count of decimal digits here would introduce double-rounding errors.
  let decimal_power = 17 - (((binary + 63) * 78913) >> 18)
  let binary_power = (decimal_power * 108853) >> 15
  let shift = 63 - binary_power
  let ten = @bigint.BigInt::from_int(10).pow(
    @bigint.BigInt::from_int(decimal_power.abs()),
  )
  let one = @bigint.BigInt::from_int(1)
  let numerator = if decimal_power >= 0 { ten } else { one }
  let denominator = if decimal_power >= 0 { one } else { ten }
  let numerator = if shift >= 0 { numerator << shift } else { numerator }
  let denominator = if shift < 0 { denominator << -shift } else { denominator }
  let power = numerator / denominator
  let product = (@bigint.BigInt::from_uint64(mantissa) * power) >> 64
  let high = product.to_uint64() >> -(binary + binary_power + 2)
  let significand = (high + ((high << 1) & 2UL)) >> 1
  let digits = significand.to_string()
  let mut point = digits.length() - decimal_power
  let mut precision = 17
  if digits[15] == '9' && digits[14] == '9' {
    let mut count = 14
    while count > 0 && digits[count - 1] == '9' {
      count -= 1
    }
    let decimal = if count == 0 {
      1UL
    } else {
      decimal_prefix(digits, count) + 1UL
    }
    let shortened = decimal.to_string() + "e" + (point - count).to_string()
    if (@string.parse_double(shortened) catch { _ => 0.0 }) == value.abs() {
      precision = count + 1
    }
  } else if point >= digits.length() ||
    (digits[15] == '0' && digits[14] == '0' && digits[13] == '0') {
    let mut count = 13
    while count > 1 && digits[count - 1] == '0' {
      count -= 1
    }
    let shortened = decimal_prefix(digits, count).to_string() +
      "e" +
      (point - count).to_string()
    if (@string.parse_double(shortened) catch { _ => 0.0 }) == value.abs() {
      precision = count + 1
    }
  }
  let mut decimal = decimal_prefix(digits, precision)
  if digits[precision] >= '5' {
    decimal += 1UL
  }
  let rounded = decimal.to_string()
  if rounded.length() > precision {
    point += 1
  }
  let mut count = rounded.length()
  while count > 1 && rounded[count - 1] == '0' {
    count -= 1
  }
  let rounded = rounded[0:count].to_owned()
  let sign = if value < 0.0 { "-" } else { "" }
  let scientific = point - 1
  if scientific < -4 || scientific >= 17 {
    let exponent = scientific.abs().to_string()
    sign +
    rounded[0:1].to_owned() +
    "." +
    (if rounded.length() == 1 { "0" } else { rounded[1:].to_owned() }) +
    "e" +
    (if scientific < 0 { "-" } else { "+" }) +
    (if exponent.length() < 2 { "0" } else { "" }) +
    exponent
  } else if point <= 0 {
    sign + "0." + decimal_zeros(-point) + rounded
  } else if point >= count {
    sign + rounded + decimal_zeros(point - count) + ".0"
  } else {
    sign + rounded[0:point].to_owned() + "." + rounded[point:].to_owned()
  }
}
