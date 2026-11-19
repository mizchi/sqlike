///|
/// Experimental read-only result contract for optional native adapters. No JS
/// representation escapes here. Bytes stay immutable; native adapters copy them
/// before exposing mutable host byte arrays.
pub fn query_prepared_values(
  query : SqlPrepared,
  bindings : String,
) -> Result[Array[Array[Value]], String] {
  try {
    if query.error is Some(error) {
      fail(error)
    }
    guard query.statement is Some(Select(_)) else {
      fail("typed results accept SELECT only")
    }
    let encoded : Array[Json] = @json.from_json(@json.parse(bindings))
    let params = encoded.map(json_value) catch {
      _ => fail("invalid SQL bindings")
    }
    guard params.length() == query.parameters else {
      fail("SQL binding count mismatch")
    }
    Ok(
      prepared_sql_rows(query, params).map(row => {
        row.filter(b => !b.hidden).map(b => b.value)
      }),
    )
  } catch {
    error => Err(public_error(error))
  }
}
