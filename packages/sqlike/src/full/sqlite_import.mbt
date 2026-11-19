///|
/// Physical decoding is separate from SQL/storage state. Only a fully checked
/// candidate replaces the destination connection.
priv struct DiskSchema {
  kind : String
  name : String
  table : String
  root : Int32
  sql : String?
}

///|
fn sqlite_schema(file : SQLiteFile) -> Array[DiskSchema] raise SqlError {
  let entries : Array[DiskSchema] = []
  let names : Map[String, Bool] = Map([])
  for row in file.tree(1, false) {
    guard row.values
      is [Text(kind), Text(name), Text(table), Integer(root), sql] else {
      fail("corrupt SQLite: schema record")
    }
    guard ["table", "index", "view", "trigger"].contains(kind) &&
      !names.contains(schema_name_key(kind, name)) else {
      fail("corrupt SQLite: schema object type/name")
    }
    names[schema_name_key(kind, name)] = true
    let definition = match sql {
      Text(s) => Some(s)
      Null => None
      _ => fail("corrupt SQLite: schema SQL")
    }
    let page = if kind == "table" || kind == "index" {
      file.page_number(root)
    } else {
      guard root == 0L else { fail("corrupt SQLite: non-table root page") }
      0
    }
    entries.push({ kind, name, table, root: page, sql: definition, })
    guard entries.length() <= 2000 else {
      fail("SQLite schema object resource limit")
    }
  }
  entries
}

///|
fn sqlite_table_rows(
  file : SQLiteFile,
  table : Table,
  root : Int32,
  store : Store,
) -> Unit raise SqlError {
  let keys = primary_key(table)
  let order = if table.without_rowid {
    keys + insert_columns(table).filter(i => !keys.contains(i))
  } else {
    insert_columns(table)
  }
  let ipk = integer_primary(table)
  let rows = file.tree(root, table.without_rowid)
  for c in table.columns {
    prepare_default(store, c)
  }
  for index, row in rows {
    guard row.values.length() <= order.length() else {
      fail("corrupt SQLite: table record width")
    }
    let values : Array[Value] = Array::make(table.columns.length(), Null)
    for i in row.values.length()..<order.length() {
      let column = order[i]
      guard literal_default(table.columns[column].default_value) else {
        fail("unsupported SQLite missing expression-default cell")
      }
      values[column] = column_default(store, table, table.columns[column], [])
    }
    for i, value in row.values {
      let column = order[i]
      // REAL-affinity integers are a physical storage optimization in SQLite.
      values[column] = if affinity_name(table.columns[column].declared) ==
        "real" &&
        value is Integer(n) {
        Real(n.to_double())
      } else {
        value
      }
    }
    if ipk >= 0 {
      values[ipk] = Integer(row.key)
    }
    let id = if table.without_rowid { (index + 1).to_int64() } else { row.key }
    if table.without_rowid && !table.rows.is_empty() {
      let before = table.rows[table.rows.length() - 1]
      let mut comparison = 0
      for i in keys {
        comparison = compare_stored(
          store,
          before.values[i],
          values[i],
          table.columns[i].collation,
        )
        if comparison != 0 {
          break
        }
      }
      guard comparison < 0 else {
        fail("corrupt SQLite: unordered WITHOUT ROWID keys")
      }
    }
    table.sequence = table.sequence.max(id)
    append_table_row(
      store,
      table,
      generated_row(store, table, { id, values, }, storage=true),
    )
  }
}

///|
/// Canonical numeric keys compare the INTEGER/REAL representations exactly.
fn sqlite_key(values : Array[Value]) -> String {
  Json::array(
    values.map(value => {
      let value = match value {
        Real(n) =>
          if n >= -9223372036854775808.0 &&
            n < 9223372036854775808.0 &&
            n.to_int64().to_double() == n {
            Value::Integer(n.to_int64())
          } else {
            value
          }
        _ => value
      }
      value_json(value)
    }),
  ).stringify()
}

///|
fn sqlite_index_matches(
  store : Store,
  table : Table,
  index : UniqueIndex,
  records : Array[DiskRow],
) -> Bool raise SqlError {
  let tail = if table.without_rowid {
    primary_key(table).filter(i => {
      !index.parts.any(p => {
        p.column == i && p.collation == table.columns[i].collation
      })
    })
  } else {
    [-1]
  }
  let fields = index.parts +
    tail.map(column => {
      column,
      expression: Literal(Null),
      collation: if column < 0 {
        "binary"
      } else {
        table.columns[column].collation
      },
      descending: false,
    })
  let expected : Map[String, Int32] = Map([])
  let mut count = 0
  for row in table.rows {
    guard index_values(store, table, index, row.values) is Some(values) else {
      continue
    }
    let values = values +
      tail.map(i => if i < 0 { Integer(row.id) } else { row.values[i] })
    let key = sqlite_key(values)
    expected[key] = expected.get(key).unwrap_or(0) + 1
    count += 1
  }
  if count != records.length() {
    return false
  }
  let mut previous : Array[Value]? = None
  for row in records {
    if row.values.length() != fields.length() {
      return false
    }
    if previous is Some(before) {
      if before.length() != row.values.length() {
        return false
      }
      let mut comparison = 0
      for i, value in row.values {
        let collation = fields[i].collation
        comparison = compare_stored(store, before[i], value, collation)
        if fields[i].descending {
          comparison = -comparison
        }
        if comparison != 0 {
          break
        }
      }
      if comparison >= 0 {
        return false
      }
    }
    previous = Some(row.values)
    let key = sqlite_key(row.values)
    let n = expected.get(key).unwrap_or(0)
    if n == 0 {
      return false
    }
    expected[key] = n - 1
  }
  true
}

///|
fn sqlite_import(data : Bytes) -> Store raise SqlError {
  let file = sqlite_header(data)
  file.reserve_ptrmap()
  file.freelist()
  let schema = sqlite_schema(file)
  let candidate = { ..database_open().store, encoding: Some(file.encoding), }
  let mut largest = 1
  for entry in schema {
    if entry.root > largest {
      largest = entry.root
    }
    if entry.kind != "table" {
      continue
    }
    guard entry.sql is Some(sql) else {
      fail("corrupt SQLite: table definition missing")
    }
    let parsed = parse_statement(lex(sql))
    guard parsed is CreateTable(table, _) &&
      identifier(table.name) == identifier(entry.name) &&
      identifier(entry.table) == identifier(entry.name) else {
      fail("unsupported SQLite table definition")
    }
    table.sql = sql
    candidate.tables.push(table)
    sqlite_table_rows(file, table, entry.root, candidate)
  }
  // Install all declared index constraints before validating rows / FK targets.
  for entry in schema {
    if entry.kind == "table" {
      continue
    }
    if entry.sql is Some(sql) {
      let parsed = parse_statement(lex(sql))
      guard parsed is CreateObject(object, _) &&
        object.kind == entry.kind &&
        identifier(object.name) == identifier(entry.name) &&
        identifier(object.table) == identifier(entry.table) else {
        fail("unsupported SQLite schema definition")
      }
      if object.kind == "index" {
        validate_index_definition(
          candidate,
          get_table(candidate, object.table),
          object,
        )
      }
      candidate.objects.push(object)
    } else {
      guard entry.kind == "index" && entry.name.has_prefix("sqlite_autoindex_") else {
        fail("corrupt SQLite: missing schema definition")
      }
    }
  }
  for entry in schema {
    if entry.kind != "index" {
      continue
    }
    let records = file.tree(entry.root, true)
    let table = get_table(candidate, entry.table)
    let alternatives = if entry.sql is Some(sql) {
      guard parse_statement(lex(sql)) is CreateObject(object, _) else {
        fail("unsupported SQLite index definition")
      }
      [object_index(object, table)]
    } else {
      table.unique_keys.map(key => {
        (
          {
            parts: key.map(column => {
              column,
              expression: Column("", table.columns[column].name),
              collation: table.columns[column].collation,
              descending: false,
            }),
            predicate: None,
          } : UniqueIndex)
      })
    }
    guard alternatives.any(index => {
      sqlite_index_matches(candidate, table, index, records)
    }) else {
      fail("corrupt SQLite: index/table records disagree")
    }
  }
  let sequences = candidate.tables.filter(t => {
    identifier(t.name) == "sqlite_sequence"
  })
  if !sequences.is_empty() {
    let sequence = sequences[0]
    let name = column_index(sequence, "name")
    let number = column_index(sequence, "seq")
    for row in sequence.rows {
      guard row.values[name] is Text(name) && row.values[number] is Integer(n) else {
        fail("corrupt SQLite: AUTOINCREMENT sequence")
      }
      for table in candidate.tables {
        if table.autoincrement && identifier(table.name) == identifier(name) {
          table.sequence = table.sequence.max(n)
          table.sequence_present = Some(true)
        }
      }
    }
  }
  let cookie = disk_cursor(data, 40, 44).word()
  guard cookie <= 2147483647L else {
    fail("unsupported SQLite schema cookie range")
  }
  candidate.cookie = cookie.to_int()
  let max_root = disk_cursor(data, 52, 56).word()
  guard max_root == 0L || max_root == largest.to_int64() else {
    fail("corrupt SQLite: largest root page")
  }
  file.validate_pages()
  validate_image(candidate)
  candidate
}

///|
pub fn database_import_sqlite(db : Database, image : Bytes) -> String {
  try {
    let candidate = sqlite_import(image)
    db.store = candidate
    db.serial += 1
    db.schema_epoch += 1L
    "{}"
  } catch {
    error => ({ "error": public_error(error) } : Json).stringify()
  }
}

///|
/// Portable string ABI for Wasm GC. The JavaScript backend uses bytes directly.
pub fn database_import_sqlite_base64(db : Database, image : String) -> String {
  try {
    guard image.length() <= 89478488 else {
      fail("SQLite base64 resource limit")
    }
    database_import_sqlite(db, @base64.decode(image))
  } catch {
    _ => "{\"error\":\"invalid SQLite base64 image\"}"
  }
}
