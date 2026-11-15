///|
#derive(ToJson)
priv struct LegacyTable {
  name : String
  sql : String
  columns : Array[ColumnDef]
  unique_keys : Array[Array[Int32]]
  checks : Array[Expr]
  foreign_keys : Array[ForeignKey]
  without_rowid : Bool
  autoincrement : Bool
  sequence : Int64
  sequence_present : Bool?
  rows : RowPages
}

///|
impl @json.ToJson for Table with fn to_json(self) {
  let legacy : LegacyTable = {
    name: self.name,
    sql: self.sql,
    columns: self.columns,
    unique_keys: self.unique_keys,
    checks: self.checks,
    foreign_keys: self.foreign_keys,
    without_rowid: self.without_rowid,
    autoincrement: self.autoincrement,
    sequence: self.sequence,
    sequence_present: self.sequence_present,
    rows: self.rows,
  }
  let json = @json.to_json(legacy)
  if self.strict is Some(value) && json is Object(fields) {
    fields["strict"] = @json.to_json(value)
  }
  json
}

///|
#derive(ToJson)
priv struct LegacySource {
  name : String
  qualifier : String
  left : Bool
  on : Expr
}

///|
impl @json.ToJson for Source with fn to_json(self) {
  let legacy : LegacySource = {
    name: self.name,
    qualifier: self.qualifier,
    left: self.left,
    on: self.on,
  }
  let json = @json.to_json(legacy)
  if self.right is Some(value) && json is Object(fields) {
    fields["right"] = @json.to_json(value)
  }
  if self.using_columns is Some(value) && json is Object(fields) {
    fields["using_columns"] = @json.to_json(value)
  }
  if self.natural is Some(value) && json is Object(fields) {
    fields["natural"] = @json.to_json(value)
  }
  json
}

///|
fn validate_strict_columns(columns : Array[ColumnDef]) -> Unit raise SqlError {
  guard FEATURE_STRICT else { fail("feature disabled: strictTables") }
  for col in columns {
    guard ["INT", "INTEGER", "REAL", "TEXT", "BLOB", "ANY"].contains(
      col.declared,
    ) else {
      fail("unknown datatype for STRICT column: " + col.name)
    }
  }
}

///|
fn column_affinity(table : Table, col : ColumnDef) -> String {
  if FEATURE_STRICT && table.strict == Some(true) && col.declared == "ANY" {
    "blob"
  } else {
    affinity_name(col.declared)
  }
}

///|
fn check_strict_values(
  table : Table,
  values : Array[Value],
) -> Unit raise SqlError {
  guard FEATURE_STRICT else { fail("feature disabled: strictTables") }
  for i, col in table.columns {
    let valid = match values[i] {
      Null => true
      Integer(_) => ["INT", "INTEGER", "REAL", "ANY"].contains(col.declared)
      Real(_) => ["REAL", "ANY"].contains(col.declared)
      Text(_) => ["TEXT", "ANY"].contains(col.declared)
      Blob(_) => ["BLOB", "ANY"].contains(col.declared)
    }
    guard valid else {
      fail("datatype constraint failed: " + table.name + "." + col.name)
    }
  }
}

///|
#derive(ToJson)
priv struct LegacyColumnDef {
  name : String
  declared : String
  not_null : Bool
  primary : Int32
  default_value : Expr
  collation : String
}

///|
impl @json.ToJson for ColumnDef with fn to_json(self) {
  let legacy : LegacyColumnDef = {
    name: self.name,
    declared: self.declared,
    not_null: self.not_null,
    primary: self.primary,
    default_value: self.default_value,
    collation: self.collation,
  }
  let json = @json.to_json(legacy)
  if self.default_source is Some(value) && json is Object(fields) {
    fields["default_source"] = @json.to_json(value)
  }
  if self.primary_desc is Some(value) && json is Object(fields) {
    fields["primary_desc"] = @json.to_json(value)
  }
  json
}
