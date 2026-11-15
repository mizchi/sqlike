///|
// Wasm GC Bytes are opaque references at the JS boundary. These explicit
// transfer functions preserve the same binary format through the string ABI.
pub fn defined_open_base64(
  schema : String,
  statements : String,
  image : String,
) -> DefinedDatabase {
  try {
    guard schema.length() <= 1398104 &&
      statements.length() <= 1398104 &&
      image.length() <= 89478488 else {
      fail("binary transfer resource limit")
    }
    defined_open(
      @base64.decode(schema),
      @base64.decode(statements),
      @base64.decode(image),
    )
  } catch {
    e =>
      {
        core: { connection: None, program: None, error: Some(public_error(e)), },
        schema_id: "",
      }
  }
}

///|
pub fn binary_data_base64(result : BinaryResult) -> String {
  @base64.encode(result.data)
}

///|
pub fn defined_restore_base64(db : DefinedDatabase, text : String) -> String {
  try {
    guard text.length() <= 89478488 else {
      fail("binary transfer resource limit")
    }
    defined_restore(db, @base64.decode(text))
  } catch {
    e => ({ "error": public_error(e) } : Json).stringify()
  }
}

///|
pub fn defined_apply_delta_base64(
  db : DefinedDatabase,
  text : String,
) -> String {
  try {
    guard text.length() <= 89478488 else {
      fail("binary transfer resource limit")
    }
    defined_apply_delta(db, @base64.decode(text))
  } catch {
    e => ({ "error": public_error(e) } : Json).stringify()
  }
}
