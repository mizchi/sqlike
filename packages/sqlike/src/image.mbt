///|
/// Reopen validates the logical schema and row invariants before publication.
fn table_definition(table : Table) -> Json {
  let json : Json = {
    "name": table.name,
    "columns": @json.to_json(
      table.columns.map(c => { ..c, default_source: None, }),
    ),
    "unique": @json.to_json(table.unique_keys),
    "checks": @json.to_json(table.checks),
    "foreign": @json.to_json(table.foreign_keys),
    "withoutRowid": table.without_rowid,
    "autoincrement": table.autoincrement,
  }
  if table.strict is Some(value) && json is Object(fields) {
    fields["strict"] = @json.to_json(value)
  }
  json
}

///|
fn validate_store_rows(store : Store) -> Unit raise SqlError {
  guard [1, 2, 3].contains(store.encoding.unwrap_or(1)) &&
    store.cookie >= 0 &&
    store.changes >= 0 &&
    !store.deferred &&
    store.tables.length() <= 1000 &&
    store.objects.length() <= 1000 else {
    fail("invalid Moon SQL image metadata")
  }
  let names : Map[String, Bool] = Map([])
  for table in store.tables {
    validate_table_features(table)
    if table.strict == Some(true) {
      validate_strict_columns(table.columns)
    }
    guard !names.contains(identifier(table.name)) &&
      table.columns.length() > 0 &&
      table.columns.length() <= 2000 &&
      table.rows.length() <= 100000 else {
      fail("invalid Moon SQL image table")
    }
    names[identifier(table.name)] = true
    let ids : Map[String, Bool] = Map([])
    let ipk = integer_primary(table)
    for row in table.rows {
      guard row.values.length() == table.columns.length() &&
        !ids.contains(row.id.to_string()) else {
        fail("invalid Moon SQL image row")
      }
      ids[row.id.to_string()] = true
      guard ipk < 0 || row.values[ipk] == Integer(row.id) else {
        fail("invalid Moon SQL image rowid")
      }
      for v in row.values {
        if v is Real(n) {
          guard !n.is_nan() else { fail("invalid Moon SQL image real") }
        }
      }
      check_row(store, table, row.values, [])
      guard conflict_row(store, table, row.values, Some(row.id), None) is None else {
        fail("invalid Moon SQL image UNIQUE constraint")
      }
    }
  }
  for obj in store.objects {
    validate_optional_features(obj)
    if obj.kind == "trigger" && !FEATURE_TRIGGERS {
      fail("feature disabled: triggers")
    }
    guard !names.contains(identifier(obj.name)) else {
      fail("invalid Moon SQL image object")
    }
    names[identifier(obj.name)] = true
    if obj.kind == "index" {
      validate_index_definition(store, get_table(store, obj.table), obj)
    }
    if obj.kind == "trigger" {
      validate_trigger_metadata(get_table(store, obj.table), obj)
    }
  }
  validate_foreign_keys(store)
}

///|
fn validate_image(store : Store) -> Unit raise SqlError {
  guard store.tables.length() <= 1000 && store.objects.length() <= 1000 else {
    fail("invalid Moon SQL image metadata")
  }
  for table in store.tables {
    let parsed = parse_statement(lex(table.sql))
    guard parsed is CreateTable(definition, _) else {
      fail("invalid Moon SQL image schema")
    }
    if table.columns.length() == definition.columns.length() {
      for i, col in table.columns {
        if col.default_source is Some(source) {
          guard definition.columns[i].default_source == Some(source) else {
            fail("invalid Moon SQL declaration metadata")
          }
        }
      }
    }
    guard table_definition(table) == table_definition(definition) else {
      fail("invalid Moon SQL image schema")
    }
    // Recover observable declaration spelling without rewriting a legacy image.
    store.declaration_sources[table.sql] = definition.columns.map(c => {
      c.default_source.unwrap_or("")
    })
  }
  for obj in store.objects {
    let parsed = parse_statement(lex(obj.sql))
    if obj.selection is None && parsed is CreateObject(definition, _) {
      obj.selection = definition.selection
    }
    guard parsed is CreateObject(definition, _) &&
      @json.to_json(obj) == @json.to_json(definition) else {
      fail("invalid Moon SQL image object schema")
    }
  }
  validate_store_rows(store)
}

///|
/// Fixed schema identity for parser-free images; mutable rows and counters are excluded.
fn schema_identity(store : Store) -> Json {
  {
    "encoding": store.encoding.unwrap_or(1),
    "cookie": store.cookie,
    "tables": store.tables.map(table => {
      ({ "sql": table.sql, "definition": table_definition(table) } : Json)
    }),
    "objects": @json.to_json(store.objects),
    "foreignKeys": store.foreign_keys,
  }
}
