///|
pub fn aot_open(program : String, image : String) -> @sqlike.AotDatabase {
  @sqlike.aot_open(program, image)
}

///|
pub fn aot_info(database : @sqlike.AotDatabase) -> String {
  @sqlike.aot_info(database)
}

///|
pub fn aot_execute(
  database : @sqlike.AotDatabase,
  name : String,
  bindings : String,
) -> String {
  @sqlike.aot_execute(database, name, bindings)
}

///|
pub fn aot_dump(database : @sqlike.AotDatabase) -> String {
  @sqlike.aot_dump(database)
}

///|
pub fn aot_restore(database : @sqlike.AotDatabase, image : String) -> String {
  @sqlike.aot_restore(database, image)
}

///|
pub fn aot_export_sqlite(db : @sqlike.AotDatabase) -> @sqlike.SqliteResult {
  @sqlike.aot_export_sqlite(db)
}

///|
pub fn sqlite_data(result : @sqlike.SqliteResult) -> Bytes {
  @sqlike.sqlite_data(result)
}

///|
pub fn sqlite_info(result : @sqlike.SqliteResult) -> String {
  @sqlike.sqlite_info(result)
}

///|
pub fn sqlite_data_base64(result : @sqlike.SqliteResult) -> String {
  @sqlike.sqlite_data_base64(result)
}

///|
pub fn encode_ltx(
  base : Bytes,
  data : Bytes,
  min : String,
  max : String,
  timestamp : String,
) -> @litestream.LtxResult {
  @litestream.encode_ltx(base, data, min, max, timestamp)
}

///|
pub fn encode_ltx_base64(
  base : String,
  data : String,
  min : String,
  max : String,
  timestamp : String,
) -> @litestream.LtxResult {
  @litestream.encode_ltx_base64(base, data, min, max, timestamp)
}

///|
pub fn apply_ltx(
  base : Bytes,
  txid : String,
  file : Bytes,
  version : Int32,
) -> @litestream.LtxResult {
  @litestream.apply_ltx(base, txid, file, version)
}

///|
pub fn apply_ltx_base64(
  base : String,
  txid : String,
  file : String,
  version : Int32,
) -> @litestream.LtxResult {
  @litestream.apply_ltx_base64(base, txid, file, version)
}

///|
pub fn ltx_data(result : @litestream.LtxResult) -> Bytes {
  @litestream.ltx_data(result)
}

///|
pub fn ltx_info(result : @litestream.LtxResult) -> String {
  @litestream.ltx_info(result)
}

///|
pub fn ltx_data_base64(result : @litestream.LtxResult) -> String {
  @litestream.ltx_data_base64(result)
}

///|
pub fn aot_query_info(db : @sqlike.AotDatabase, name : String) -> String {
  @sqlike.aot_query_info(db, name)
}

///|
pub fn aot_clone(db : @sqlike.AotDatabase) -> @sqlike.AotDatabase {
  @sqlike.aot_clone(db)
}

///|
pub fn aot_delta(db : @sqlike.AotDatabase, snapshot : Bool) -> String {
  @sqlike.aot_delta(db, snapshot)
}

///|
pub fn aot_ack_delta(db : @sqlike.AotDatabase, serial : Int32) -> String {
  @sqlike.aot_ack_delta(db, serial)
}

///|
pub fn aot_apply_delta(db : @sqlike.AotDatabase, delta : String) -> String {
  @sqlike.aot_apply_delta(db, delta)
}

///|
pub fn aot_set_clock(db : @sqlike.AotDatabase, milliseconds : String) -> String {
  @sqlike.aot_set_clock(db, milliseconds)
}

///|
pub fn aot_copy_connection_state(
  target : @sqlike.AotDatabase,
  source : @sqlike.AotDatabase,
) -> String {
  @sqlike.aot_copy_connection_state(target, source)
}
