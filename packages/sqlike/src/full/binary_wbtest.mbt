///|
test "binary primitives preserve int64 REAL bits UTF8 and reject malformed frames" {
  let writer = binary_writer()
  let values : Array[Value] = [
    Integer(-9223372036854775808L),
    Integer(9223372036854775807L),
    Real(-0.0),
    Real(1.0),
    Text("\u{FEFF}a\u{0}b"),
    Blob(b"\x00\xff"),
    Null,
  ]
  Binary::write(values, writer)
  let bytes = binary_finish(writer, 1)
  let reader = binary_reader(bytes, 1, 1048576)
  let actual : Array[Value] = Binary::read(reader)
  reader.finish()
  assert_eq(actual.length(), values.length())
  for i, value in values {
    assert_true(same_stored_value(value, actual[i]))
  }
  for i in 0..<bytes.length() {
    let truncated = bytes[0:i].to_owned()
    let result = try {
      let r = binary_reader(truncated, 1, 1048576)
      let _v : Array[Value] = Binary::read(r)
      r.finish()
      true
    } catch {
      _ => false
    }
    assert_false(result)
  }
  let trailing = @buffer.Buffer()
  trailing.write_bytes(bytes[:])
  trailing.write_byte(b'\x00')
  let rejected = try {
    let r = binary_reader(trailing.to_bytes(), 1, 1048576)
    let _v : Array[Value] = Binary::read(r)
    r.finish()
    false
  } catch {
    _ => true
  }
  assert_true(rejected)
}

///|
test "binary reader rejects unknown tags required features and excessive nesting" {
  let w = binary_writer()
  w.uint(99U)
  let rejected = try {
    let r = binary_reader(binary_finish(w, 1), 1, 1048576)
    let _v : Value = Binary::read(r)
    false
  } catch {
    _ => true
  }
  assert_true(rejected)
  w.require_feature(0x80000000U)
  let unknown_feature = try {
    ignore(binary_reader(binary_finish(w, 1), 1, 1048576))
    false
  } catch {
    _ => true
  }
  assert_true(unknown_feature)
  let mut expr = yes()
  for _ in 0..<300 {
    expr = Unary("+", expr)
  }
  let w = binary_writer()
  Binary::write(expr, w)
  let depth = try {
    let r = binary_reader(binary_finish(w, 1), 1, 1048576)
    let _v : Expr = Binary::read(r)
    false
  } catch {
    _ => true
  }
  assert_true(depth)
}

///|
test "defined delta rejects invalid column patches without changing live data or counters" {
  let artifact = compile_program(
    "{\"schema\":[\"CREATE TABLE t(id INTEGER PRIMARY KEY,n TEXT)\"],\"queries\":[{\"name\":\"put\",\"sql\":\"INSERT INTO t VALUES(1,'kept')\"}]}",
  )
  let catalog = pack_program_binary(artifact)
  assert_eq(catalog.error, "")
  let db = defined_open(catalog.schema, catalog.statements, b"")
  assert_false(defined_execute(db, "put", "[]").contains("error"))
  let (connection, _) = db.core.ready()
  let before = defined_snapshot(db).data
  let w = binary_writer()
  Binary::write(db.schema_id, w)
  Binary::write(connection.database.serial, w)
  Binary::write(connection.database.serial + 1, w)
  Binary::write(1, w)
  Binary::write(1L, w)
  Binary::write(true, w)
  let sequences : Array[(Int64, Bool?)] = [(0L, None)]
  Binary::write(sequences, w)
  let edits = [PatchRow("t", 1L, 1L, [(99, Text("bad"))])]
  Binary::write(edits, w)
  assert_true(defined_apply_delta(db, binary_finish(w, 5)).contains("error"))
  assert_eq(defined_snapshot(db).data, before)
}

///|
test "typed MoonBit connection initializes from binary definitions and accepts only compiled queries" {
  let text = compile_program(
    "{\"schema\":[\"CREATE TABLE t(id INTEGER PRIMARY KEY,n TEXT)\"],\"queries\":[{\"name\":\"put\",\"sql\":\"INSERT INTO t VALUES(?,?) RETURNING id,n\"}]}",
  )
  let catalog = pack_program_binary(text)
  assert_eq(catalog.error, "")
  let program = Program::load_binary(catalog.schema, catalog.statements)
  let connection = Connection::from_program(program)
  let statement = connection.prepare_compiled(program.query("put"))
  statement.bind(index=1, 9007199254740993L)
  statement.bind(index=2, "kept")
  assert_true(statement.step())
  let id : Int64 = statement.column(index=0)
  let name : String = statement.column(index=1)
  assert_eq(id, 9007199254740993L)
  assert_eq(name, "kept")
  statement.finalize()
  assert_false(
    try {
      ignore(connection.prepare("SELECT * FROM t"))
      true
    } catch {
      _ => false
    },
  )
  connection.close()
}
