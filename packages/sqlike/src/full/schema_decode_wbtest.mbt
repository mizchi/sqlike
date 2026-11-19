///|
test "optional schema JSON fields retain omitted/unwrapped derive semantics" {
  let original = @json.parse(
    "{\"column\":0,\"parent\":\"p\",\"target\":\"id\",\"cascade\":false}",
  )
  let fk : ForeignKey = @json.from_json(original)
  assert_eq(fk.columns, None)
  assert_eq(fk.initially_deferred, None)
  assert_eq(@json.to_json(fk), original)
  let full = @json.parse(
    "{\"column\":0,\"parent\":\"p\",\"target\":\"id\",\"cascade\":true,\"columns\":[0,1],\"targets\":[\"id\",\"n\"],\"delete_action\":\"cascade\",\"update_action\":\"cascade\",\"initially_deferred\":true}",
  )
  let fk : ForeignKey = @json.from_json(full)
  assert_eq(@json.to_json(fk), full)
  let trigger = @json.parse(
    "{\"timing\":\"after\",\"event\":\"insert\",\"columns\":[],\"condition\":[\"Literal\",[\"Integer\",\"1\"]],\"body\":[[\"PreparedSelect\",{\"ctes\":[],\"projections\":[],\"sources\":[],\"predicate\":[\"Literal\",[\"Integer\",\"1\"]],\"groups\":[],\"having\":[\"Literal\",[\"Integer\",\"1\"]],\"orders\":[],\"limit\":[\"Literal\",[\"Integer\",\"-1\"]],\"offset\":[\"Literal\",[\"Integer\",\"0\"]],\"distinct\":false}]]}",
  )
  let decoded : TriggerDefinition = @json.from_json(trigger)
  assert_eq(@json.to_json(decoded), trigger)
}

///|
test "schema JSON rejects missing and mistyped fields including explicit null options" {
  for
    text in [
      "{}", "{\"column\":0,\"parent\":\"p\",\"target\":\"id\",\"cascade\":false,\"columns\":null}",
      "{\"column\":0,\"parent\":\"p\",\"target\":\"id\",\"cascade\":false,\"initially_deferred\":\"true\"}",
    ] {
    let json = @json.parse(text)
    let result : Result[ForeignKey, @json.JsonDecodeError] = Ok(
      @json.from_json(json),
    ) catch {
      e => Err(e)
    }
    assert_true(result is Err(_))
  }
  let result : Result[TriggerDefinition, @json.JsonDecodeError] = Ok(
    @json.from_json({ "timing": "after" }),
  ) catch {
    e => Err(e)
  }
  assert_true(result is Err(_))
}
