///|
/// Build-only SQL compiler entry. Browser runtime links only the executor APIs.
pub fn compile_program(request : String) -> String {
  @sqlike.compile_program(request)
}

///|
pub fn pack_program_binary(artifact : String) -> @sqlike.BinaryCatalog {
  @sqlike.pack_program_binary(artifact)
}

///|
pub fn binary_catalog_schema(catalog : @sqlike.BinaryCatalog) -> Bytes {
  @sqlike.binary_catalog_schema(catalog)
}

///|
pub fn binary_catalog_statements(catalog : @sqlike.BinaryCatalog) -> Bytes {
  @sqlike.binary_catalog_statements(catalog)
}

///|
pub fn binary_catalog_storage(catalog : @sqlike.BinaryCatalog) -> Bytes {
  @sqlike.binary_catalog_storage(catalog)
}

///|
pub fn binary_catalog_info(catalog : @sqlike.BinaryCatalog) -> String {
  @sqlike.binary_catalog_info(catalog)
}
