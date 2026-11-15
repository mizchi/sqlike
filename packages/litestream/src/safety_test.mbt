///|
test "guard precedence blocks schema and effect ambiguity" {
  assert_eq(
    @litestream.assess_apply(3, 1, 2, true, false, true, true),
    "schema",
  )
  assert_eq(@litestream.assess_apply(3, 1, 2, true, true, true, true), "apply")
  assert_eq(@litestream.assess_apply(3, 1, 1, true, true, true, true), "stale")
  assert_eq(
    @litestream.assess_apply(3, 3, 1, true, true, true, false),
    "effects",
  )
  assert_eq(
    @litestream.assess_apply(3, 3, 1, true, true, false, false),
    "cardinality",
  )
  assert_eq(
    @litestream.assess_apply(3, 3, 1, false, false, false, false),
    "database",
  )
}
