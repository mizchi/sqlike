///|
pub fn defined_open(
  schema : Bytes,
  statements : Bytes,
  image : Bytes,
) -> @sqlike.DefinedDatabase {
  @sqlike.defined_open(schema, statements, image)
}

///|
pub fn defined_info(db : @sqlike.DefinedDatabase) -> String {
  @sqlike.defined_info(db)
}

///|
pub fn defined_execute(
  db : @sqlike.DefinedDatabase,
  name : String,
  bindings : String,
) -> String {
  @sqlike.defined_execute(db, name, bindings)
}

///|
pub fn defined_query_info(
  db : @sqlike.DefinedDatabase,
  name : String,
) -> String {
  @sqlike.defined_query_info(db, name)
}

///|
pub fn defined_set_clock(
  db : @sqlike.DefinedDatabase,
  millis : String,
) -> String {
  @sqlike.defined_set_clock(db, millis)
}

///|
pub fn defined_clone(db : @sqlike.DefinedDatabase) -> @sqlike.DefinedDatabase {
  @sqlike.defined_clone(db)
}

///|
pub fn defined_copy_connection_state(
  target : @sqlike.DefinedDatabase,
  source : @sqlike.DefinedDatabase,
) -> String {
  @sqlike.defined_copy_connection_state(target, source)
}

///|
pub fn defined_snapshot(db : @sqlike.DefinedDatabase) -> @sqlike.BinaryResult {
  @sqlike.defined_snapshot(db)
}

///|
pub fn defined_restore(db : @sqlike.DefinedDatabase, bytes : Bytes) -> String {
  @sqlike.defined_restore(db, bytes)
}

///|
pub fn defined_delta(
  db : @sqlike.DefinedDatabase,
  full : Bool,
) -> @sqlike.BinaryResult {
  @sqlike.defined_delta(db, full)
}

///|
pub fn defined_apply_delta(
  db : @sqlike.DefinedDatabase,
  bytes : Bytes,
) -> String {
  @sqlike.defined_apply_delta(db, bytes)
}

///|
pub fn defined_ack_delta(
  db : @sqlike.DefinedDatabase,
  serial : Int32,
) -> String {
  @sqlike.defined_ack_delta(db, serial)
}

///|
pub fn binary_data(result : @sqlike.BinaryResult) -> Bytes {
  @sqlike.binary_data(result)
}

///|
pub fn binary_info(result : @sqlike.BinaryResult) -> String {
  @sqlike.binary_info(result)
}

///|
pub fn defined_open_base64(
  schema : String,
  statements : String,
  image : String,
) -> @sqlike.DefinedDatabase {
  @sqlike.defined_open_base64(schema, statements, image)
}

///|
pub fn binary_data_base64(result : @sqlike.BinaryResult) -> String {
  @sqlike.binary_data_base64(result)
}

///|
pub fn defined_restore_base64(
  db : @sqlike.DefinedDatabase,
  image : String,
) -> String {
  @sqlike.defined_restore_base64(db, image)
}

///|
pub fn defined_apply_delta_base64(
  db : @sqlike.DefinedDatabase,
  image : String,
) -> String {
  @sqlike.defined_apply_delta_base64(db, image)
}

///|
pub fn sqlite_pager_open() -> @sqlike.SqlitePager {
  @sqlike.sqlite_pager_open()
}

///|
pub fn defined_pager_prepare(
  db : @sqlike.DefinedDatabase,
  layout : Bytes,
  pager : @sqlike.SqlitePager,
) -> @sqlike.SqlitePageBatch {
  @sqlike.defined_pager_prepare(db, layout, pager)
}

///|
pub fn defined_pager_prepare_base64(
  db : @sqlike.DefinedDatabase,
  layout : String,
  pager : @sqlike.SqlitePager,
) -> @sqlike.SqlitePageBatch {
  @sqlike.defined_pager_prepare_base64(db, layout, pager)
}

///|
pub fn sqlite_pager_info(batch : @sqlike.SqlitePageBatch) -> String {
  @sqlike.sqlite_pager_info(batch)
}

///|
pub fn sqlite_pager_supply(
  batch : @sqlike.SqlitePageBatch,
  page : Int32,
  data : Bytes,
) -> String {
  @sqlike.sqlite_pager_supply(batch, page, data)
}

///|
pub fn sqlite_pager_supply_base64(
  batch : @sqlike.SqlitePageBatch,
  page : Int32,
  data : String,
) -> String {
  @sqlike.sqlite_pager_supply_base64(batch, page, data)
}

///|
pub fn sqlite_pager_page(
  batch : @sqlike.SqlitePageBatch,
  index : Int32,
) -> Bytes {
  @sqlike.sqlite_pager_page(batch, index)
}

///|
pub fn sqlite_pager_page_base64(
  batch : @sqlike.SqlitePageBatch,
  index : Int32,
) -> String {
  @sqlike.sqlite_pager_page_base64(batch, index)
}

///|
pub fn sqlite_pager_ack(
  pager : @sqlike.SqlitePager,
  batch : @sqlike.SqlitePageBatch,
) -> String {
  @sqlike.sqlite_pager_ack(pager, batch)
}
