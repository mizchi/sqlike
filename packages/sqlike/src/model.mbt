///|
/// SQLite storage classes. Int64 values never pass through a JavaScript Number.
#derive(Eq)
pub(all) enum Value {
  Null
  Integer(Int64)
  Real(Double)
  Text(String)
  Blob(Bytes)
}

///|
#derive(ToJson, FromJson)
priv enum Expr {
  Literal(Value)
  TruthLiteral(Bool)
  CurrentTime(String)
  Parameter(Int32)
  Column(String, String)
  Star(String)
  Unary(String, Expr)
  Binary(String, Expr, Expr)
  Call(String, Array[Expr])
  Collate(Expr, String)
  Cast(Expr, String)
  RowNumber(Array[Ordering])
  Window(String, Array[Expr], Array[Expr], Array[Ordering], WindowFrame)
  Between(Expr, Expr, Expr)
  Case(Expr?, Array[(Expr, Expr)], Expr)
  InSelect(Expr, Selection)
  ScalarSelect(Selection)
  Exists(Selection)
}

///|
#derive(ToJson, FromJson)
priv struct Ordering {
  expression : Expr
  descending : Bool
}

///|
#derive(ToJson, FromJson)
priv struct Projection {
  expression : Expr
  explicit_label : Bool
  label : String
}

///|
#derive(FromJson)
priv struct Source {
  name : String
  qualifier : String
  left : Bool
  right : Bool?
  using_columns : Array[String]?
  natural : Bool?
  on : Expr
}

///|
#derive(FromJson)
priv struct Selection {
  ctes : Array[(String, Selection)]
  projections : Array[Projection]
  sources : Array[Source]
  predicate : Expr
  groups : Array[Expr]
  having : Expr
  orders : Array[Ordering]
  limit : Expr
  offset : Expr
  distinct : Bool
  compound : Array[(String, Selection)]?
  recursive : Bool?
  cte_names : Array[(String, Array[String])]?
}

///|
#derive(FromJson)
priv struct ForeignKey {
  column : Int32
  parent : String
  target : String
  cascade : Bool
  columns : Array[Int32]?
  targets : Array[String]?
  delete_action : String?
  update_action : String?
  initially_deferred : Bool?
}

///|
#derive(FromJson)
priv struct ColumnDef {
  name : String
  declared : String
  not_null : Bool
  mut primary : Int32
  primary_desc : Bool?
  default_value : Expr
  mut default_source : String?
  collation : String
}

///|
#derive(ToJson, FromJson)
priv struct StoredRow {
  id : Int64
  // Published row values are immutable. DML and DDL replace the row to retain
  // rollback / clone isolation without copying every unrelated value array.
  values : Array[Value]
}

///|
#derive(FromJson)
priv struct Table {
  name : String
  mut sql : String
  columns : Array[ColumnDef]
  unique_keys : Array[Array[Int32]]
  checks : Array[Expr]
  foreign_keys : Array[ForeignKey]
  without_rowid : Bool
  strict : Bool?
  autoincrement : Bool
  mut sequence : Int64
  mut sequence_present : Bool?
  mut rows : RowPages
}

///|
#derive(FromJson)
priv struct SchemaObject {
  kind : String
  name : String
  table : String
  sql : String
  unique : Bool
  columns : Array[String]
  query : String
  mut selection : Selection?
  index_terms : Array[Ordering]?
  index_predicate : Expr?
  trigger : TriggerDefinition?
}

///|
priv struct Store {
  mut encoding : Int32?
  tables : Array[Table]
  objects : Array[SchemaObject]
  mut cookie : Int32
  mut changes : Int32
  mut last_rowid : Int64
  mut foreign_keys : Bool
  mut deferred : Bool
  // Derived, bounded execution state; excluded from images and compiled artifacts.
  primary_indexes : Map[String, PrimaryIndex]
  indexes : Map[String, CachedIndex]
  declaration_sources : Map[String, Array[String]]
  mut dirty : DirtyState
  transactions : TransactionRuntime
  triggers : TriggerRuntime
}

///|
/// Opaque connection; only the SQL engine owns and mutates its state.
struct Database {
  mut store : Store
  mut serial : Int32
}

///|
#derive(FromJson)
priv struct Insertion {
  table : String
  columns : Array[String]
  values : Array[Array[Expr]]
  conflict : String
  target : Array[String]
  updates : Array[(String, Expr)]
  predicate : Expr
  returning : Array[Projection]
  conflict_override : String?
  target_predicate : Expr?
  selection : Selection?
}

///|
#derive(ToJson, FromJson)
priv enum DataStatement {
  PreparedTransaction(String, String)
  PreparedSelect(Selection)
  PreparedPragma(String, String)
  PreparedInsert(Insertion)
  PreparedUpdate(String, Array[(String, Expr)], Expr, Array[Projection])
  PreparedDelete(String, Expr, Array[Projection])
}

///|
priv enum ParsedStatement {
  Transaction(String, String)
  CreateTable(Table, Bool)
  CreateObject(SchemaObject, Bool)
  Drop(String, String, Bool)
  Insert(Insertion)
  Update(String, Array[(String, Expr)], Expr, Array[Projection])
  Delete(String, Expr, Array[Projection])
  Select(Selection)
  Pragma(String, String, Expr?)
  AddColumn(String, ColumnDef, String)
  RenameColumn(String, String, String, Bool)
  RenameTable(String, String)
  DropColumn(String, String)
}

///|
priv suberror SqlError {
  SqlError(String)
  TriggerIgnore
  TriggerAbort(String)
}

///|
fn[X] fail(message : String) -> X raise SqlError {
  raise SqlError(message)
}

///|
fn yes() -> Expr {
  Literal(Integer(1L))
}

///|
fn identifier(value : String) -> String {
  let mut uppercase = false
  for c in value.iter() {
    if c >= 'A' && c <= 'Z' {
      uppercase = true
      break
    }
  }
  if !uppercase {
    return value
  }
  let b = @utf8.encode(value)
  @utf8.decode_lossy(
    Bytes::from_array(
      b
      .to_array()
      .map(c => {
        let n = c.to_int()
        if n >= 65 && n <= 90 {
          (n + 32).to_byte()
        } else {
          c
        }
      }),
    ),
  )
}

///|
fn matches_identifier(value : String, normalized : String) -> Bool {
  value == normalized || identifier(value) == normalized
}

///|
fn get_table(store : Store, name : String) -> Table raise SqlError {
  let key = identifier(name)
  for table in store.tables {
    if matches_identifier(table.name, key) {
      return table
    }
  }
  fail("no such table: " + name)
}

///|
fn column_index(table : Table, name : String) -> Int32 raise SqlError {
  let key = identifier(name)
  for i, column in table.columns {
    if matches_identifier(column.name, key) {
      return i
    }
  }
  fail("no such column: " + name)
}

///|
fn value_json(value : Value) -> Json {
  match value {
    Null => { "t": "null" }
    Integer(n) => { "t": "integer", "v": n.to_string() }
    Real(n) =>
      {
        "t": "real",
        "v": if !n.is_finite() {
          Json::string(if n < 0.0 { "-Infinity" } else { "Infinity" })
        } else if n.reinterpret_as_uint64() == 0x8000000000000000UL {
          Json::number(n, repr="-0.0")
        } else {
          Json::number(n)
        },
      }
    Text(s) => { "t": "text", "v": s }
    Blob(b) => { "t": "blob", "v": b.to_array().map(c => c.to_int()) }
  }
}

///|
fn json_value(value : Json) -> Value raise {
  match value {
    { "t": "null", .. } => Null
    { "t": "integer", "v": String(s), .. } => Integer(@string.parse_int64(s))
    { "t": "real", "v": Number(n, ..), .. } => sql_real(n)
    { "t": "text", "v": String(s), .. } => Text(s)
    { "t": "blob", "v": Array(a), .. } => {
      let bytes = @buffer.Buffer()
      for n in a {
        guard n is Number(n, ..) &&
          n >= 0 &&
          n <= 255 &&
          n.to_int().to_double() == n else {
          fail("invalid blob binding")
        }
        bytes.write_byte(n.to_int().to_byte())
      }
      Blob(bytes.to_bytes())
    }
    _ => fail("invalid SQL binding")
  }
}

///|
pub fn database_open() -> Database {
  {
    serial: 0,
    store: {
      encoding: None,
      tables: [],
      objects: [],
      cookie: 0,
      changes: 0,
      last_rowid: 0L,
      foreign_keys: true,
      deferred: false,
      indexes: Map([]),
      primary_indexes: Map([]),
      declaration_sources: Map([]),
      dirty: dirty_state(),
      transactions: transaction_runtime(),
      triggers: trigger_runtime(),
    },
  }
}

///|
/// A versioned logical image, not a SQLite database file.
pub fn database_dump(db : Database) -> String {
  let state = @json.to_json(db.store)
  ({ "format": "moon-sql@1", "state": state } : Json).stringify()
}

///|
/// Decode before replacing the connection; malformed images leave it unchanged.
pub fn database_restore(db : Database, image : String) -> String {
  try {
    guard @json.parse(image) is { "format": "moon-sql@1", "state": state, .. } else {
      fail("unsupported Moon SQL image")
    }
    let restored : Store = @json.from_json(state)
    validate_image(restored)
    db.store = restored
    "{}"
  } catch {
    e =>
      (
        {
          "error": match e {
            SqlError(message) => message
            _ => e.to_string()
          },
        } : Json).stringify()
  }
}

///|
pub fn database_version(db : Database) -> Int32 {
  db.store.cookie
}

///|
/// Transaction checkpoints copy mutable containers, sharing immutable row values.
fn copy_store(store : Store) -> Store {
  {
    ..store,
    tables: store.tables.map(t => {
      ..t,
      rows: t.rows.fork(),
      columns: t.columns.map(c => { ..c, }),
    }),
    objects: store.objects.copy(),
    indexes: Map([]),
    primary_indexes: Map(
      store.primary_indexes.to_array().map(pair => (pair.0, { ..pair.1, })),
    ),
    declaration_sources: Map(store.declaration_sources.to_array()),
    dirty: { ..store.dirty, edits: store.dirty.edits.copy(), },
    transactions: {
      frames: store.transactions.frames.copy(),
      explicit: store.transactions.explicit,
    },
    triggers: {
      ..trigger_runtime(),
      clock: store.triggers.clock,
      recursive: store.triggers.recursive,
      failed_statement: store.triggers.failed_statement,
    },
  }
}

///|
pub fn database_clone(db : Database) -> Database {
  { store: copy_store(db.store), serial: db.serial, }
}

///|
pub fn database_serial(db : Database) -> Int32 {
  db.serial
}

///|
fn insertion_column(table : Table, name : String) -> Int32 raise SqlError {
  let key = identifier(name)
  for i, col in table.columns {
    if identifier(col.name) == key {
      return i
    }
  }
  if !table.without_rowid && ["rowid", "_rowid_", "oid"].contains(key) {
    return -1
  }
  fail("no such column: " + name)
}

///|
#derive(ToJson, FromJson)
priv enum FiniteValue {
  Null
  Integer(Int64)
  Real(Double)
  Text(String)
  Blob(Bytes)
}

///|
impl @json.ToJson for Value with fn to_json(self) {
  let legacy : FiniteValue = match self {
    Null => Null
    Integer(n) => Integer(n)
    Real(n) => {
      if n.reinterpret_as_uint64() == 0x8000000000000000UL {
        // Nested JSON parse/stringify (AOT journal envelopes, JS hosts) may
        // normalize numeric -0. Use the same tagged extension as infinity.
        return [Json::string("Real"), Json::string("-0")]
      }
      if !n.is_finite() {
        return [
          Json::string("Real"),
          Json::string(if n < 0.0 { "-Infinity" } else { "Infinity" }),
        ]
      }
      Real(n)
    }
    Text(s) => Text(s)
    Blob(b) => Blob(b)
  }
  @json.to_json(legacy)
}

///|
impl @json.FromJson for Value with fn from_json(json, path) {
  if json is Array([String("Real"), String("-0")]) {
    return Real(0x8000000000000000UL.reinterpret_as_double())
  }
  if json is Array([String("Real"), String("Infinity")]) {
    return Real(0x7ff0000000000000UL.reinterpret_as_double())
  }
  if json is Array([String("Real"), String("-Infinity")]) {
    return Real(0xfff0000000000000UL.reinterpret_as_double())
  }
  let legacy : FiniteValue = @json.from_json(json, path~)
  match legacy {
    Null => Null
    Integer(n) => Integer(n)
    Real(n) => {
      guard !n.is_nan() else {
        raise @json.JsonDecodeError((path, "invalid stored REAL"))
      }
      Real(n)
    }
    Text(s) => Text(s)
    Blob(b) => Blob(b)
  }
}

///|
/// Transfer only connection-local counters when a host restores a data clone.
/// No schema, rows, transaction frames, persistence serial or caches are copied.
pub fn database_copy_connection_state(
  target : Database,
  source : Database,
) -> Unit {
  target.store.last_rowid = source.store.last_rowid
  target.store.changes = source.store.changes
  target.store.triggers.failed_statement = source.store.triggers.failed_statement
}
