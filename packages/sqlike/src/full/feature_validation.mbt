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
  if name == "$json-table" {
    8192U
  } else if name == "$generated-virtual" {
    4096U
  } else if name == "$filter" {
    256U
  } else if name == "$aggregate-order" {
    512U
  } else if name == "$row" {
    1024U
  } else if name == "$update-from" {
    2048U
  } else if name == "json" ||
    name.has_prefix("json_") ||
    name == "->" ||
    name == "->>" {
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
  if !FEATURE_JSON_TABLE && (function_features(name) & 8192U) != 0U {
    fail("feature disabled: jsonTableFunctions")
  }
  if !FEATURE_GENERATED_COLUMNS && (function_features(name) & 4096U) != 0U {
    fail("feature disabled: generatedColumns")
  }
  if !FEATURE_UPDATE_FROM && (function_features(name) & 2048U) != 0U {
    fail("feature disabled: updateFrom")
  }
  if !FEATURE_ROW_VALUES && (function_features(name) & 1024U) != 0U {
    fail("feature disabled: rowValues")
  }
  if !FEATURE_AGGREGATE_ORDER && (function_features(name) & 512U) != 0U {
    fail("feature disabled: aggregateOrderBy")
  }
  if !FEATURE_AGGREGATE_FILTER && (function_features(name) & 256U) != 0U {
    fail("feature disabled: aggregateFilter")
  }
  if !FEATURE_SQL_JSON && (function_features(name) & 16U) != 0U {
    fail("feature disabled: sqlJson")
  }
  if !FEATURE_DATETIME && (function_features(name) & 32U) != 0U {
    fail("feature disabled: dateTime")
  }
}

///|
fn pragma_features(name : String) -> UInt32 {
  if ["index_list", "index_info", "index_xinfo"].contains(name) {
    128U
  } else {
    0U
  }
}

///|
fn validate_pragma_features(name : String) -> Unit raise SqlError {
  if !FEATURE_SCHEMA_METADATA && pragma_features(name) != 0U {
    fail("feature disabled: schemaMetadata")
  }
}

///|
fn[T : FeatureCheck] validate_optional_features(
  value : T,
) -> Unit raise SqlError {
  if CAP_CATALOG_SPECIALIZED ||
    !FEATURE_SQL_JSON ||
    !FEATURE_DATETIME ||
    !FEATURE_WINDOWS ||
    !FEATURE_SCHEMA_METADATA ||
    !FEATURE_AGGREGATE_ORDER ||
    !FEATURE_ROW_VALUES ||
    !FEATURE_UPDATE_FROM ||
    !FEATURE_GENERATED_COLUMNS ||
    !FEATURE_JSON_TABLE ||
    !FEATURE_AGGREGATE_FILTER {
    FeatureCheck::check(value)
  }
}
