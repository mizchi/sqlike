///|
test "result cell writer preserves the existing typed JSON contract" {
  let values : Array[Value] = [
    Null,
    Integer(-9223372036854775808L),
    Integer(9223372036854775807L),
    Real(-0.0),
    Real(0.0),
    Real(1.0 / 0.0),
    Real(-1.0 / 0.0),
    Real(5.0e-324),
    Real(1.7976931348623157e308),
    Text("\"\\\n\r\t\u{0}\u{1}\u{1f}\u{feff}é😀</script>\u{2028}"),
    Blob(b""),
    Blob(Bytes::makei(256, i => i.to_byte())),
  ]
  for value in values {
    let output = StringBuilder()
    write_result_cell(output, value)
    assert_true(@json.parse(output.to_string()) == value_json(value))
    if value is Real(n) && n.reinterpret_as_uint64() == 0x8000000000000000UL {
      assert_true(output.to_string().contains("-0.0"))
    }
  }
}

///|
test "positional writer omits hidden bindings and preserves duplicate positions" {
  let rows = [
    [
      binding("same", Integer(1L)),
      { ..binding("hidden", Text("secret")), hidden: true, },
      binding("same", Real(1.0)),
      binding("blob", Blob(b"\x00\xff")),
    ],
    [],
  ]
  for read_only in [true, false] {
    let expected : Json = {
      "rows": rows.map(row => {
        Json::array(row.filter(b => !b.hidden).map(b => value_json(b.value)))
      }),
      "readonly": read_only,
    }
    assert_true(
      @json.parse(positional_result_json(rows, read_only)) == expected,
    )
  }
  assert_true(
    @json.parse(positional_result_json([], true)) ==
    ({ "rows": [], "readonly": true } : Json),
  )
}
