///|
pub fn open(program : String, image : String) -> @sqlike.AotDatabase {
  @sqlike.aot_open(program, image)
}

///|
pub fn info(db : @sqlike.AotDatabase) -> String {
  @sqlike.aot_info(db)
}

///|
pub fn query_info(db : @sqlike.AotDatabase, name : String) -> String {
  @sqlike.aot_query_info(db, name)
}

///|
pub fn execute(
  db : @sqlike.AotDatabase,
  name : String,
  bindings : String,
) -> String {
  @sqlike.aot_execute(db, name, bindings)
}

///|
pub fn prepare(
  db : @sqlike.AotDatabase,
  name : String,
) -> @sqlike.AotPreparedValues {
  @sqlike.aot_prepare_values(db, name)
}

///|
pub fn values(
  query : @sqlike.AotPreparedValues,
  bindings : String,
) -> @native.NativeValue {
  @native.native_result(@sqlike.aot_prepared_values(query, bindings))
}

///|
pub fn finalize(query : @sqlike.AotPreparedValues) -> String {
  @sqlike.aot_finalize_values(query)
}

///|
pub fn restore(db : @sqlike.AotDatabase, image : String) -> String {
  @sqlike.aot_restore(db, image)
}

///|
pub fn snapshot(db : @sqlike.AotDatabase) -> String {
  @sqlike.aot_dump(db)
}

///|
pub fn set_clock(db : @sqlike.AotDatabase, millis : String) -> String {
  @sqlike.aot_set_clock(db, millis)
}

///|
pub fn clone(db : @sqlike.AotDatabase) -> @sqlike.AotDatabase {
  @sqlike.aot_clone(db)
}
