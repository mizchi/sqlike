///|
pub fn defined_export_sqlite(
  schema : Bytes,
  statements : Bytes,
  layout : Bytes,
  image : Bytes,
) -> @sqlike.SqliteResult {
  @sqlike.defined_export_sqlite(schema, statements, layout, image)
}

///|
pub fn sqlite_data(result : @sqlike.SqliteResult) -> Bytes {
  @sqlike.sqlite_data(result)
}

///|
pub fn sqlite_info(result : @sqlike.SqliteResult) -> String {
  @sqlike.sqlite_info(result)
}
