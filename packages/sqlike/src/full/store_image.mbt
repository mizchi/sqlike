///|
/// Stable logical image. Execution caches are deliberately outside this contract.
#derive(ToJson, FromJson)
priv struct StoreImage {
  encoding : Int32?
  tables : Array[Table]
  objects : Array[SchemaObject]
  cookie : Int32
  changes : Int32
  last_rowid : Int64
  foreign_keys : Bool
  deferred : Bool
}

///|
impl @json.ToJson for Store with fn to_json(self) {
  let image : StoreImage = {
    encoding: self.encoding,
    tables: self.tables,
    objects: self.objects,
    cookie: self.cookie,
    changes: self.changes,
    last_rowid: self.last_rowid,
    foreign_keys: self.foreign_keys,
    deferred: self.deferred,
  }
  @json.to_json(image)
}

///|
impl @json.FromJson for Store with fn from_json(json, path) {
  let image : StoreImage = @json.from_json(json, path~)
  {
    encoding: image.encoding,
    tables: image.tables,
    objects: image.objects,
    cookie: image.cookie,
    changes: image.changes,
    last_rowid: image.last_rowid,
    foreign_keys: image.foreign_keys,
    deferred: image.deferred,
    indexes: Map([]),
    primary_indexes: Map([]),
    declaration_sources: Map([]),
    generated_plans: Map([]),
    dirty: dirty_state(),
    transactions: transaction_runtime(),
    triggers: trigger_runtime(),
  }
}
