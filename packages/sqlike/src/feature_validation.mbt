///|
fn validate_table_features(table : Table) -> Unit raise SqlError {
  for col in table.columns {
    validate_collation(col.collation)
  }
  validate_optional_features(table)
  if table.strict == Some(true) && !FEATURE_STRICT {
    fail("feature disabled: strictTables")
  }
  if !table.foreign_keys.is_empty() && !FEATURE_FOREIGN_KEYS {
    fail("feature disabled: foreignKeys")
  }
}

///|
// Shared by the binary requirement encoder and all expression validators.
// Recognition does not pull the JSON/date implementations into a small runtime.
fn function_features(name : String) -> UInt32 {
  if name == "json" || name.has_prefix("json_") || name == "->" || name == "->>" {
    16U
  } else if [
      "date", "datetime", "time", "strftime", "unixepoch", "julianday", "timediff",
    ].contains(name) {
    32U
  } else {
    0U
  }
}

///|
fn validate_function_features(name : String) -> Unit raise SqlError {
  if !FEATURE_SQL_JSON && (function_features(name) & 16U) != 0U {
    fail("feature disabled: sqlJson")
  }
  if !FEATURE_DATETIME && (function_features(name) & 32U) != 0U {
    fail("feature disabled: dateTime")
  }
}

///|
fn[T : FeatureCheck] validate_optional_features(
  value : T,
) -> Unit raise SqlError {
  if !FEATURE_SQL_JSON || !FEATURE_DATETIME || !FEATURE_WINDOWS {
    FeatureCheck::check(value)
  }
}
