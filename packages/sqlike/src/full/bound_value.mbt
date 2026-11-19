///|
/// Literal/bind key operands shared by access plans and execution-local IN sets.

///|
priv enum BoundValue {
  KeyLiteral(Value)
  KeyParameter(Int32)
}

///|
fn bind_key_value(e : Expr) -> BoundValue? {
  match e {
    Literal(value) => Some(KeyLiteral(value))
    Parameter(index) => Some(KeyParameter(index))
    _ => None
  }
}

///|
fn read_key_value(
  value : BoundValue,
  params : Array[Value],
) -> Value raise SqlError {
  match value {
    KeyLiteral(value) => value
    KeyParameter(index) => {
      guard index >= 0 && index < params.length() else {
        fail("missing SQL binding")
      }
      params[index]
    }
  }
}
