///|
test "community-style typed binding and column access preserve original storage classes" {
  let db = @sqlike.Connection::open(":memory:")
  let statement = db.prepare(
    "SELECT ? AS integer_value,? AS real_value,? AS text_value,? AS blob_value,? AS null_value",
  )
  statement.bind(index=1, 9007199254740993L)
  statement.bind(index=2, 1.25)
  statement.bind(index=3, "hello😀")
  statement.bind(index=4, b"\x00\xff")
  statement.bind(index=5, @sqlike.Value::Null)
  assert_eq(statement.column_count(), 5)
  assert_eq(statement.column_name(index=2), "text_value")
  assert_true(statement.step())
  let integer : Int64 = statement.column(index=0)
  let real : Double = statement.column(index=1)
  let text : String = statement.column(index=2)
  let blob : Bytes = statement.column(index=3)
  let null_value : @sqlike.Value = statement.column(index=4)
  assert_eq(integer, 9007199254740993L)
  assert_eq(real, 1.25)
  assert_eq(text, "hello😀")
  assert_eq(blob, b"\x00\xff")
  assert_true(null_value is Null)
  // Coercing accessors must not change the dynamic storage-class result.
  let coerced : String = statement.column(index=0)
  assert_eq(coerced, "9007199254740993")
  let original : @sqlike.Value = statement.column(index=0)
  assert_true(original is Integer(9007199254740993L))
  assert_false(statement.step())
  statement.finalize()
  statement.finalize()
  db.close()
}

///|
test "reset preserves bindings by default and clears them only when requested" {
  let db = @sqlike.Connection::open(":memory:")
  let statement = db.prepare("SELECT ?")
  statement.bind(index=1, 42)
  assert_true(statement.step())
  statement.reset()
  assert_true(statement.step())
  let value : Int64 = statement.column(index=0)
  assert_eq(value, 42L)
  statement.reset(clear_bindings=true)
  assert_true(statement.step())
  let value : @sqlike.Value = statement.column(index=0)
  assert_true(value is Null)
  statement.finalize()
  db.close()
}

///|
test "typed interface rejects column access without a current row and connection close with live statements" {
  let db = @sqlike.Connection::open(":memory:")
  let statement = db.prepare("SELECT 1")
  let no_row = try {
    let _ : Int64 = statement.column(index=0)
    false
  } catch {
    _ => true
  }
  assert_true(no_row)
  let busy = try {
    db.close()
    false
  } catch {
    _ => true
  }
  assert_true(busy)
  assert_true(statement.step())
  let outside = try {
    let _ : Int64 = statement.column(index=1)
    false
  } catch {
    _ => true
  }
  assert_true(outside)
  statement.finalize()
  let finalized = try {
    ignore(statement.step())
    false
  } catch {
    _ => true
  }
  assert_true(finalized)
  db.close()
}

///|
test "the same typed statement API executes precompiled queries" {
  let artifact = @sqlike.compile_program(
    "{\"schema\":[\"CREATE TABLE notes(id INTEGER PRIMARY KEY,title TEXT NOT NULL)\"],\"queries\":[{\"name\":\"add\",\"sql\":\"INSERT INTO notes VALUES(?,?)\"},{\"name\":\"get\",\"sql\":\"SELECT title FROM notes WHERE id=?\"}]}",
  )
  let program = @sqlike.Program::load(artifact)
  let connection = @sqlike.Connection::from_program(program)
  let insert = connection.prepare_compiled(program.query("add"))
  insert.bind(index=1, 1L)
  insert.bind(index=2, "事前コンパイル")
  assert_false(insert.step())
  assert_eq(connection.changes(), 1L)
  insert.finalize()
  let select = connection.prepare_compiled(program.query("get"))
  select.bind(index=1, 1L)
  assert_true(select.step())
  let title : String = select.column(index=0)
  assert_eq(title, "事前コンパイル")
  select.finalize()
  connection.close()
}

///|
test "a compiled connection rejects SQL text and queries from another program" {
  let a = @sqlike.Program::load(
    @sqlike.compile_program(
      "{\"schema\":[],\"queries\":[{\"name\":\"one\",\"sql\":\"SELECT 1\"}]}",
    ),
  )
  let b = @sqlike.Program::load(
    @sqlike.compile_program(
      "{\"schema\":[],\"queries\":[{\"name\":\"two\",\"sql\":\"SELECT 2\"}]}",
    ),
  )
  let connection = @sqlike.Connection::from_program(a)
  let rejected_sql = try {
    ignore(connection.prepare("CREATE TABLE changed(n INTEGER)"))
    false
  } catch {
    _ => true
  }
  assert_true(rejected_sql)
  let rejected_query = try {
    ignore(connection.prepare_compiled(b.query("two")))
    false
  } catch {
    _ => true
  }
  assert_true(rejected_query)
  connection.close()
}

///|
test "integer column conversion uses SQLite decimal prefixes and clamps without exponent coercion" {
  let db = @sqlike.Connection::open(":memory:")
  let statement = db.prepare("SELECT ?")
  let cases : Array[(@sqlike.Value, Int64)] = [
    (Text("2e1"), 2L),
    (Text(" -3.9tail"), -3L),
    (Text("922337203685477580899"), 9223372036854775807L),
    (Text("-922337203685477580899"), -9223372036854775808L),
    (Text("no digits"), 0L),
    (Blob(b"+42x"), 42L),
    (Null, 0L),
    (Real(1.0e100), 9223372036854775807L),
  ]
  for (input, expected) in cases {
    statement.bind(index=1, input)
    assert_true(statement.step())
    let actual : Int64 = statement.column(index=0)
    assert_eq(actual, expected)
    statement.reset()
  }
  statement.finalize()
  db.close()
}
