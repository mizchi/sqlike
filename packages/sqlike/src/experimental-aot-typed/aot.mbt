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
/// The JS boundary admits only the public Value union, never MoonBit enums.
extern "js" fn binding_array(value : @native.NativeValue) -> Bool =
  #| value => Array.isArray(value)

///|
extern "js" fn binding_kind(value : @native.NativeValue) -> Int32 =
  #| v => v === null ? 0 : typeof v === 'bigint' ? 1 : typeof v === 'number' ? 2 : typeof v === 'string' && v.isWellFormed() ? 3 : v instanceof Uint8Array ? 4 : 5

///|
fn binding_items(
  value : @native.NativeValue,
) -> FixedArray[@native.NativeValue] = "%identity"

///|
fn binding_integer(value : @native.NativeValue) -> BigInt = "%identity"

///|
fn binding_real(value : @native.NativeValue) -> Double = "%identity"

///|
fn binding_text(value : @native.NativeValue) -> String = "%identity"

///|
fn binding_blob(value : @native.NativeValue) -> Bytes = "%identity"

///|
extern "js" fn binding_error(message : String) -> @native.NativeValue =
  #| message => { throw new Error(message) }

///|
extern "js" fn execution_error(json : String) -> @native.NativeValue =
  #| json => { const r = JSON.parse(json); const e = new Error(r.error); if (r.code) e.code = r.code; throw e }

///|
extern "js" fn execution_result(
  names : FixedArray[String],
  rows : @native.NativeValue,
  read_only : Bool,
  changes : Int32,
) -> @native.NativeValue =
  #| (names, rows, readonly, changes) => ({ names, rows, readonly, changes })

///|
fn typed_bindings(
  bindings : @native.NativeValue,
) -> Result[Array[@sqlike.Value], String] {
  guard binding_array(bindings) else {
    return Err("typed AOT bindings must be an array")
  }
  let values : Array[@sqlike.Value] = []
  for value in binding_items(bindings) {
    let value : @sqlike.Value = match binding_kind(value) {
      0 => Null
      1 => {
        let n = binding_integer(value)
        guard n.compare_int64(-9223372036854775808L) >= 0 &&
          n.compare_int64(9223372036854775807L) <= 0 else {
          return Err("INTEGER binding outside int64 range")
        }
        Integer(n.to_int64())
      }
      2 => {
        let n = binding_real(value)
        guard n.is_finite() else {
          return Err("typed AOT bindings require finite REAL values")
        }
        Real(n)
      }
      3 => Text(binding_text(value))
      // Borrow only until Statement.bind copies the bytes; Buffer/subarray are
      // accepted without relying on their potentially aliasing slice method.
      4 => Blob(binding_blob(value))
      _ =>
        return Err(
          "unsupported typed AOT binding: expected null, bigint, finite number, well-formed string or Uint8Array",
        )
    }
    values.push(value)
  }
  Ok(values)
}

///|
pub fn values_typed(
  query : @sqlike.AotPreparedValues,
  bindings : @native.NativeValue,
) -> @native.NativeValue {
  match typed_bindings(bindings) {
    Err(message) => binding_error(message)
    Ok(bindings) =>
      match @sqlike.aot_native_values(query, bindings) {
        Err(json) => execution_error(json)
        Ok(rows) => @native.native_result(Ok(rows))
      }
  }
}

///|
pub fn execute_typed(
  db : @sqlike.AotDatabase,
  name : String,
  bindings : @native.NativeValue,
) -> @native.NativeValue {
  match typed_bindings(bindings) {
    Err(message) => binding_error(message)
    Ok(bindings) =>
      match @sqlike.aot_native_execute(db, name, bindings) {
        Err(json) => execution_error(json)
        Ok(result) =>
          execution_result(
            FixedArray::from_array(result.names[:]),
            @native.native_result(Ok(result.rows)),
            result.read_only,
            result.changes,
          )
      }
  }
}

///|
pub fn copy_connection_state(
  target : @sqlike.AotDatabase,
  source : @sqlike.AotDatabase,
) -> String {
  @sqlike.aot_copy_connection_state(target, source)
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
