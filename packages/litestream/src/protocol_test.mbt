///|
test "binary envelope round trip, Unicode identity and opaque payload" {
  let frame = @litestream.encode_frame(2, 42, "端末-A:1", b"\x00\xff\x01")
  let decoded = @json.parse(@litestream.decode_frame(frame))
  assert_true(decoded is { "base": 42, "opId": "端末-A:1", .. })
}

///|
test "deduplication precedes revision checks" {
  inspect(@litestream.revision_decision(8, 3, 1, true), content="duplicate")
  inspect(@litestream.revision_decision(8, 3, 1, false), content="stale")
  inspect(@litestream.revision_decision(8, 3, 2, false), content="apply")
  inspect(@litestream.revision_decision(8, 9, 2, false), content="future")
}

///|
test "SQL cannot escape the transaction or access sync metadata" {
  assert_true(
    @litestream.sql_allowed("UPDATE notes SET title = ? WHERE id = ?"),
  )
  assert_true(
    @litestream.sql_allowed(
      "SELECT CASE WHEN score > 0 THEN 'yes' ELSE 'no' END FROM notes;",
    ),
  )
  assert_false(@litestream.sql_allowed("COMMIT; DELETE FROM notes"))
  assert_false(@litestream.sql_allowed("SELECT * FROM \"_bls_log\""))
  assert_false(@litestream.sql_allowed("/* hi */ PRAGMA writable_schema=1"))
  assert_false(@litestream.sql_allowed("SELECT 1; DELETE FROM notes"))
}
