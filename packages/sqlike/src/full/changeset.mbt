///|
/// Native SQLite Session wire format; this does not embed or invoke SQLite.
fn session_varint(out : @buffer.Buffer, n : Int32) -> Unit {
  if n >= 16384 {
    out.write_byte(((n >> 14) | 128).to_byte())
  }
  if n >= 128 {
    out.write_byte((((n >> 7) & 127) | 128).to_byte())
  }
  out.write_byte((n & 127).to_byte())
}

///|
fn session_value(out : @buffer.Buffer, value : Value) -> Unit {
  match value {
    Null => out.write_byte(b'\x05')
    Integer(n) => {
      out.write_byte(b'\x01')
      out.write_int64_be(n)
    }
    Real(n) => {
      out.write_byte(b'\x02')
      out.write_double_be(n)
    }
    Text(s) => {
      let b = @utf8.encode(s)
      out.write_byte(b'\x03')
      session_varint(out, b.length())
      out.write_bytes(b)
    }
    Blob(b) => {
      out.write_byte(b'\x04')
      session_varint(out, b.length())
      out.write_bytes(b)
    }
  }
}

///|
fn internal_table(name : String) -> Bool {
  let n = identifier(name)
  n.has_prefix("_bls_") ||
  n.has_prefix("_litestream_") ||
  n.has_prefix("sqlite_") ||
  n.has_prefix("__turso_")
}

///|
fn session_schema(table : Table) -> Unit raise SqlError {
  guard !has_generated_columns(table) else {
    fail("unsupported generated columns in Session changesets; use SQL or LTX")
  }
  let pk = primary_key(table)
  guard !pk.is_empty() &&
    pk.all(i => {
      table.columns[i].not_null ||
      integer_primary(table) == i ||
      table.without_rowid ||
      table.strict == Some(true)
    }) else {
    fail("binary mode requires declared non-null primary keys on every table")
  }
}

///|
fn session_rows_equal(table : Table, a : StoredRow, b : StoredRow) -> Bool {
  primary_key(table).all(i => a.values[i] == b.values[i])
}

///|
pub fn database_changeset(db : Database, before : Database) -> String {
  if !FEATURE_BINARY_SYNC {
    return ({ "error": "feature disabled: binarySync" } : Json).stringify()
  }
  try {
    let previous = before.store
    guard previous.cookie == db.store.cookie else {
      fail("DDL must use SQL mode")
    }
    let out = @buffer.Buffer()
    for table in db.store.tables {
      if internal_table(table.name) {
        continue
      }
      session_schema(table)
      let old = get_table(previous, table.name)
      let operations = @buffer.Buffer()
      for row in old.rows {
        let matching = table.rows.filter(next => {
          session_rows_equal(table, row, next)
        })
        if matching.is_empty() {
          operations.write_byte(b'\x09')
          operations.write_byte(b'\x00')
          for value in row.values {
            session_value(operations, value)
          }
        } else {
          let next = matching[0]
          if row.values == next.values {
            continue
          }
          operations.write_byte(b'\x17')
          operations.write_byte(b'\x00')
          for i, value in row.values {
            if table.columns[i].primary > 0 || value != next.values[i] {
              session_value(operations, value)
            } else {
              operations.write_byte(b'\x00')
            }
          }
          for i, value in next.values {
            if table.columns[i].primary == 0 && value != row.values[i] {
              session_value(operations, value)
            } else {
              operations.write_byte(b'\x00')
            }
          }
        }
      }
      for row in table.rows {
        if old.rows.any(previous => session_rows_equal(table, previous, row)) {
          continue
        }
        operations.write_byte(b'\x12')
        operations.write_byte(b'\x00')
        for value in row.values {
          session_value(operations, value)
        }
      }
      let data = operations.to_bytes()
      if data.length() == 0 {
        continue
      }
      guard table.columns.length() <= 255 else {
        fail("changeset column limit")
      }
      out.write_byte(b'T')
      session_varint(out, table.columns.length())
      for col in table.columns {
        out.write_byte(col.primary.to_byte())
      }
      out.write_bytes(@utf8.encode(table.name))
      out.write_byte(b'\x00')
      out.write_bytes(data)
    }
    let data = out.to_bytes()
    guard data.length() <= 1048576 else { fail("changeset resource limit") }
    ({ "data": data.to_array().map(b => b.to_int()) } : Json).stringify()
  } catch {
    e => ({ "error": public_error(e) } : Json).stringify()
  }
}

///|
pub fn database_is_readonly(sql : String) -> Bool {
  try {
    match parse_statement(lex(sql)) {
      Select(_) | Pragma(_, _, None) => true
      _ => false
    }
  } catch {
    _ => false
  }
}
