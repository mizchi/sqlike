///|
/// Generated at application build time from an empty native SQLite schema.
/// The runtime writes data pages without parsing DDL or deriving auto-index names.
#derive(Eq, ToJson)
priv struct IndexField {
  column : Int32
  collation : String
  descending : Bool
}

///|
#derive(FromJson)
priv struct StorageTree {
  name : String
  table : String
  root : Int32
  kind : String
  fields : Array[StorageField]
  predicate : Expr?
}

///|
#derive(FromJson)
priv struct StorageField {
  column : Int32
  collation : String
  descending : Bool
  expression : Expr?
}

///|
impl @json.ToJson for StorageField with fn to_json(self) {
  let json = @json.to_json(
    (
      {
        column: self.column,
        collation: self.collation,
        descending: self.descending,
      } : IndexField),
  )
  if self.expression is Some(e) && json is Object(fields) {
    fields["expression"] = @json.to_json(e)
  }
  json
}

///|
#derive(ToJson)
priv struct LegacyStorageTree {
  name : String
  table : String
  root : Int32
  kind : String
  fields : Array[StorageField]
}

///|
impl @json.ToJson for StorageTree with fn to_json(self) {
  let json = @json.to_json(
    (
      {
        name: self.name,
        table: self.table,
        root: self.root,
        kind: self.kind,
        fields: self.fields,
      } : LegacyStorageTree),
  )
  if self.predicate is Some(e) && json is Object(fields) {
    fields["predicate"] = @json.to_json(e)
  }
  json
}

///|
#derive(ToJson, FromJson)
priv struct StoragePlan {
  format : String
  page_size : Int32
  image : String
  trees : Array[StorageTree]
}
