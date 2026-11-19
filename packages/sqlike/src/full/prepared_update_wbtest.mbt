///|
test "compiled updates reuse schema metadata across connections and store replacement" {
  let artifact = compile_program(
    "{\"schema\":[\"CREATE TABLE t(id INTEGER PRIMARY KEY,n REAL,body BLOB)\"],\"queries\":[{\"name\":\"set\",\"sql\":\"UPDATE t SET n=n+?,body=? WHERE id=? RETURNING _rowid_,n,body\"},{\"name\":\"add\",\"sql\":\"INSERT INTO t VALUES(1,1,x'00')\"},{\"name\":\"get\",\"sql\":\"SELECT n,body FROM t\"}]}",
  )
  let db = aot_open(artifact, "")
  let (connection, program) = db.ready()
  guard program.query("set").update is Some(plan) else {
    fail("missing prepared update")
  }
  assert_true(physical_equal(plan, program.query("set").update.unwrap()))
  assert_eq(plan.columns, ["n", "body"])
  assert_eq(plan.setters.map(s => s.column), [1, 2])
  assert_eq(plan.setters.map(s => s.affinity), ["real", "blob"])
  assert_eq(plan.integer_primary, 0)
  assert_true(
    plan.layout.all(b => b.value == (if b.hidden { Integer(0L) } else { Null })),
  )
  assert_false(aot_execute(db, "add", "[]").contains("error"))
  let image = aot_dump(db)
  let clone = aot_clone(db)
  let (_, cloned_program) = clone.ready()
  assert_true(physical_equal(plan, cloned_program.query("set").update.unwrap()))
  let bindings = "[{\"t\":\"integer\",\"v\":\"2\"},{\"t\":\"blob\",\"v\":[255]},{\"t\":\"integer\",\"v\":\"1\"}]"
  assert_false(aot_execute(db, "set", bindings).contains("error"))
  assert_true(aot_execute(db, "get", "[]") != aot_execute(clone, "get", "[]"))
  aot_restore_checked(db, image)
  assert_eq(aot_execute(db, "get", "[]"), aot_execute(clone, "get", "[]"))
  assert_false(aot_execute(db, "set", bindings).contains("error"))
  assert_true(physical_equal(plan, program.query("set").update.unwrap()))
  assert_true(
    plan.layout.all(b => b.value == (if b.hidden { Integer(0L) } else { Null })),
  )
  assert_eq(connection.statements, 0)
}

///|
test "updates of the same wide table share one immutable layout" {
  let artifact = compile_program(
    "{\"schema\":[\"CREATE TABLE T(id INTEGER PRIMARY KEY,n REAL,body BLOB)\"],\"queries\":[{\"name\":\"a\",\"sql\":\"UPDATE t SET n=? WHERE id=?\"},{\"name\":\"b\",\"sql\":\"UPDATE T SET body=? WHERE _rowid_=?\"}]}",
  )
  let program = Program::load(artifact)
  let a = program.query("a").update.unwrap()
  let b = program.query("b").update.unwrap()
  assert_true(physical_equal(a.layout, b.layout))
}
