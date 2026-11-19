///|
/// Optional JS-only experiment. No default runtime or npm entry imports this.
#external
pub type NativeValue

///|
extern "js" fn null_value() -> NativeValue =
  #| () => null

///|
extern "js" fn integer_value(n : BigInt) -> NativeValue =
  #| n => n

///|
extern "js" fn real_value(n : Double) -> NativeValue =
  #| n => n

///|
extern "js" fn text_value(s : String) -> NativeValue =
  #| s => s

///|
extern "js" fn blob_value(b : Bytes) -> NativeValue =
  #| b => new Uint8Array(b)

///|
fn array_value(a : FixedArray[NativeValue]) -> NativeValue = "%identity"

///|
extern "js" fn failure(message : String) -> NativeValue =
  #| message => { throw new Error(message) }

///|
pub fn open() -> @sqlike.Database {
  @sqlike.database_open()
}

///|
pub fn exec(db : @sqlike.Database, sql : String, bindings : String) -> String {
  @sqlike.database_exec(db, sql, bindings, false)
}

///|
pub fn restore(db : @sqlike.Database, image : String) -> String {
  @sqlike.database_restore(db, image)
}

///|
pub fn snapshot(db : @sqlike.Database) -> String {
  @sqlike.database_dump(db)
}

///|
pub fn set_clock(db : @sqlike.Database, millis : String) -> String {
  @sqlike.database_set_clock(db, millis)
}

///|
pub fn prepare(db : @sqlike.Database, sql : String) -> @sqlike.SqlPrepared {
  @sqlike.database_prepare(db, sql)
}

///|
pub fn values(query : @sqlike.SqlPrepared, bindings : String) -> NativeValue {
  native_result(@sqlike.query_prepared_values(query, bindings))
}

///|
/// Shared by optional JS adapters; not a default runtime or JS export.
pub fn native_result(
  result : Result[Array[Array[@sqlike.Value]], String],
) -> NativeValue {
  match result {
    Err(message) => failure(message)
    Ok(rows) => {
      let rows = rows.map(row => {
        let row = row.map(value => {
          match value {
            Null => null_value()
            Integer(n) => integer_value(@bigint.BigInt::from_int64(n))
            Real(n) => real_value(n)
            Text(s) => text_value(s)
            Blob(b) => blob_value(b)
          }
        })
        array_value(FixedArray::from_array(row[:]))
      })
      array_value(FixedArray::from_array(rows[:]))
    }
  }
}
