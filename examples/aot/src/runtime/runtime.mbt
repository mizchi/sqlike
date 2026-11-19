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
pub fn aot_prepare_values(
  db : @sqlike.AotDatabase,
  name : String,
) -> @sqlike.AotPreparedValues {
  @sqlike.aot_prepare_values(db, name)
}

///|
pub fn aot_prepared_execute(
  query : @sqlike.AotPreparedValues,
  bindings : String,
) -> String {
  @sqlike.aot_prepared_execute(query, bindings)
}

///|
pub fn aot_finalize_values(query : @sqlike.AotPreparedValues) -> String {
  @sqlike.aot_finalize_values(query)
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

///|
pub fn sqlite_pager_open() -> @sqlike.SqlitePager {
  @sqlike.sqlite_pager_open()
}

///|
pub fn aot_pager_prepare(
  db : @sqlike.AotDatabase,
  pager : @sqlike.SqlitePager,
) -> @sqlike.SqlitePageBatch {
  @sqlike.aot_pager_prepare(db, pager)
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
pub fn sqlite_pager_page(
  batch : @sqlike.SqlitePageBatch,
  index : Int32,
) -> Bytes {
  @sqlike.sqlite_pager_page(batch, index)
}

///|
pub fn sqlite_pager_ack(
  pager : @sqlike.SqlitePager,
  batch : @sqlike.SqlitePageBatch,
) -> String {
  @sqlike.sqlite_pager_ack(pager, batch)
}

///|
pub fn sqlite_pager_page_base64(
  batch : @sqlike.SqlitePageBatch,
  index : Int32,
) -> String {
  @sqlike.sqlite_pager_page_base64(batch, index)
}

///|
pub fn sqlite_pager_supply_base64(
  batch : @sqlike.SqlitePageBatch,
  page : Int32,
  text : String,
) -> String {
  @sqlike.sqlite_pager_supply_base64(batch, page, text)
}

///|
pub fn encode_ltx_pages(
  state : String,
  metadata : String,
  data : Bytes,
) -> @litestream.LtxResult {
  @litestream.encode_ltx_pages(state, metadata, data)
}

///|
pub fn encode_ltx_pages_base64(
  state : String,
  metadata : String,
  data : String,
) -> @litestream.LtxResult {
  @litestream.encode_ltx_pages_base64(state, metadata, data)
}

///|
pub fn encode_ltx_pages_binary(
  state : String,
  metadata : String,
  data : Bytes,
  previous : Bytes,
) -> @litestream.LtxResult {
  @litestream.encode_ltx_pages_binary(state, metadata, data, previous)
}

///|
pub fn encode_ltx_pages_binary_base64(
  state : String,
  metadata : String,
  data : String,
  previous : String,
) -> @litestream.LtxResult {
  @litestream.encode_ltx_pages_binary_base64(state, metadata, data, previous)
}

///|
pub fn aot_snapshot_open(db : @sqlike.AotDatabase) -> @sqlike.AotSnapshot {
  @sqlike.aot_snapshot_open(db)
}

///|
pub fn aot_snapshot_info(s : @sqlike.AotSnapshot) -> String {
  @sqlike.aot_snapshot_info(s)
}

///|
pub fn aot_snapshot_chunk(
  s : @sqlike.AotSnapshot,
  i : Int32,
) -> @sqlike.SqliteResult {
  @sqlike.aot_snapshot_chunk(s, i)
}

///|
pub fn aot_snapshot_restore(
  db : @sqlike.AotDatabase,
  h : String,
) -> @sqlike.AotSnapshotReader {
  @sqlike.aot_snapshot_restore(db, h)
}

///|
pub fn aot_snapshot_supply(r : @sqlike.AotSnapshotReader, b : Bytes) -> String {
  @sqlike.aot_snapshot_supply(r, b)
}

///|
pub fn aot_snapshot_finish(r : @sqlike.AotSnapshotReader) -> String {
  @sqlike.aot_snapshot_finish(r)
}

///|
pub fn aot_snapshot_supply_base64(
  r : @sqlike.AotSnapshotReader,
  b : String,
) -> String {
  @sqlike.aot_snapshot_supply_base64(r, b)
}

///|
pub fn aot_snapshot_incremental(
  db : @sqlike.AotDatabase,
) -> @sqlike.AotSnapshot {
  @sqlike.aot_snapshot_incremental(db)
}

///|
pub fn aot_snapshot_reuse(
  current : @sqlike.AotSnapshot,
  before : @sqlike.AotSnapshot,
  index : Int32,
) -> Int32 {
  @sqlike.aot_snapshot_reuse(current, before, index)
}
