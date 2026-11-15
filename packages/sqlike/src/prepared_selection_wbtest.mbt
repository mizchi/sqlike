///|
test "compiled selections reuse immutable metadata without retaining data snapshots" {
  let artifact = compile_program(
    "{\"schema\":[\"CREATE TABLE t(id INTEGER PRIMARY KEY,body BLOB)\"],\"queries\":[{\"name\":\"get\",\"sql\":\"SELECT body AS same,id AS same,t.*,_rowid_ FROM t WHERE id=?\"},{\"name\":\"add\",\"sql\":\"INSERT INTO t VALUES(?,?)\"}]}",
  )
  let db = aot_open(artifact, "")
  let (connection, program) = db.ready()
  guard program.query("get").selection is Some(plan) else {
    fail("missing prepared selection")
  }
  assert_true(physical_equal(plan, program.query("get").selection.unwrap()))
  assert_eq(plan.output.map(b => b.name), ["same", "same", "id", "body", "id"])
  assert_true(plan.simple is Some(_))
  assert_false(
    aot_execute(
      db, "add", "[{\"t\":\"integer\",\"v\":\"1\"},{\"t\":\"blob\",\"v\":[0,255]}]",
    ).contains("error"),
  )
  let image = aot_dump(db)
  let clone = aot_clone(db)
  assert_false(
    aot_execute(db, "add", "[{\"t\":\"integer\",\"v\":\"2\"},{\"t\":\"null\"}]").contains(
      "error",
    ),
  )
  let two = "[{\"t\":\"integer\",\"v\":\"2\"}]"
  assert_true(aot_execute(db, "get", two).contains("\"integer\""))
  assert_true(aot_execute(clone, "get", two).contains("\"rows\":[]"))
  aot_restore_checked(db, image)
  assert_true(aot_execute(db, "get", two).contains("\"rows\":[]"))
  assert_true(physical_equal(plan, program.query("get").selection.unwrap()))
  assert_eq(connection.statements, 0)
}
