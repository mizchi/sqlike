///|
/// SQLite preserves INTEGER inputs; REAL and decimal/exponent TEXT stay REAL.
/// Numeric conversion reads TEXT up to its first NUL and never converts BLOB.
fn math_rounding_value(name : String, value : Value) -> Value {
  let value : Value = match value {
    Text(s) =>
      match s.find("\u{0}") {
        Some(i) => Text(s[:i].to_owned())
        None => value
      }
    _ => value
  }
  match numeric(value, true) {
    Integer(_) as value => value
    Real(n) =>
      Real(
        if name == "floor" || (name == "trunc" && !(n < 0.0)) {
          n.floor()
        } else {
          -(-n).floor()
        },
      )
    _ => Null
  }
}
