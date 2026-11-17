///|
/// The typed statement surface follows moonbit-community/sqlite3.mbt. Execution
/// is an injected prepared action so the browser AOT entry cannot pull in lex().
#derive(Eq)
pub(all) enum ErrorCode {
  Error
  Busy
  ReadOnly
  Corrupt
  Constraint
  Mismatch
  Misuse
  Range
  CantOpen
  Unknown(Int32)
}

///|
#derive(Eq)
pub(all) enum ExtendedCode {
  ConstraintCheck
  ConstraintForeignKey
  ConstraintNotNull
  ConstraintPrimaryKey
  ConstraintUnique
  ConstraintTrigger
  ConstraintDatatype
  Unknown(Int32)
}

///|
pub suberror SqliteError {
  SqliteError(code~ : ErrorCode, extended~ : ExtendedCode?, msg~ : String)
}

///|
fn sqlite_misuse(message : String) -> SqliteError {
  SqliteError(code=Misuse, extended=None, msg=message)
}

///|
fn interface_error(message : String) -> SqliteError {
  let extended = if message.contains("UNIQUE constraint") {
    Some(ExtendedCode::ConstraintUnique)
  } else if message.contains("NOT NULL constraint") {
    Some(ExtendedCode::ConstraintNotNull)
  } else if message.contains("CHECK constraint") {
    Some(ExtendedCode::ConstraintCheck)
  } else if message.contains("datatype constraint") {
    Some(ExtendedCode::ConstraintDatatype)
  } else if message.contains("FOREIGN KEY constraint") {
    Some(ExtendedCode::ConstraintForeignKey)
  } else {
    None
  }
  SqliteError(
    code=if extended is Some(_) { Constraint } else { Error },
    extended~,
    msg=message,
  )
}

///|
struct Connection {
  database : Database
  program : Program?
  mut closed : Bool
  mut statements : Int32
}

///|
fn Connection::healthy(self : Connection) -> Unit raise SqliteError {
  guard !self.closed else { raise sqlite_misuse("connection is closed") }
}

///|
/// File/IndexedDB ownership belongs to the host adapter. The portable MoonBit
/// constructor creates a memory connection; AOT adds a program-based constructor.
pub fn Connection::open(filename : String) -> Connection raise SqliteError {
  guard filename == ":memory:" else {
    raise SqliteError(
      code=CantOpen,
      extended=None,
      msg="portable connection requires :memory:",
    )
  }
  { database: database_open(), program: None, closed: false, statements: 0, }
}

///|
pub fn Connection::changes(self : Connection) -> Int64 raise SqliteError {
  self.healthy()
  connection_changes(self.database.store).to_int64()
}

///|
pub fn Connection::close(self : Connection) -> Unit raise SqliteError {
  if self.closed {
    return
  }
  guard self.statements == 0 else {
    raise SqliteError(
      code=Busy,
      extended=None,
      msg="connection has live statements",
    )
  }
  self.closed = true
}

///|
struct Statement {
  connection : Connection
  action : (Array[Value]) -> Array[Environment] raise SqlError
  parameters : Array[Value]
  names : Array[String]
  read_only : Bool
  tracks_changes : Bool
  mut rows : Array[Environment]
  mut cursor : Int32
  mut phase : Int32
  mut last_error : SqliteError?
}

///|
fn statement_new(
  connection : Connection,
  parameters : Int32,
  names : Array[String],
  read_only : Bool,
  action : (Array[Value]) -> Array[Environment] raise SqlError,
  tracks_changes~ : Bool = false,
) -> Statement {
  connection.statements += 1
  {
    connection,
    action,
    parameters: Array::make(parameters, Null),
    names,
    read_only,
    tracks_changes,
    rows: [],
    cursor: -1,
    phase: 0,
    last_error: None,
  }
}

///|
fn Statement::healthy(self : Statement) -> Unit raise SqliteError {
  self.connection.healthy()
  guard self.phase != 4 else { raise sqlite_misuse("statement is finalized") }
}

///|
fn Statement::value(self : Statement, index : Int32) -> Value raise SqliteError {
  self.healthy()
  guard self.phase == 1 else {
    raise sqlite_misuse("statement has no current row")
  }
  guard index >= 0 && index < self.names.length() else {
    raise sqlite_misuse("column index out of range")
  }
  let mut visible = 0
  for binding in self.rows[self.cursor] {
    if !binding.hidden {
      if visible == index {
        return binding.value
      }
      visible += 1
    }
  }
  raise sqlite_misuse("result column metadata mismatch")
}

///|
pub fn Statement::column_count(self : Statement) -> Int32 raise SqliteError {
  self.healthy()
  self.names.length()
}

///|
pub fn Statement::column_name(
  self : Statement,
  index~ : Int32,
) -> String raise SqliteError {
  self.healthy()
  guard index >= 0 && index < self.names.length() else {
    raise sqlite_misuse("column index out of range")
  }
  self.names[index]
}

///|
/// Bindings are one-based, result columns zero-based, as in SQLite.
trait Bind {
  fn bind(Statement, Int32, Self) -> Unit raise SqliteError
}

///|
trait Column {
  fn column(Statement, Int32) -> Self raise SqliteError
}

///|
pub fn[T : Bind] Statement::bind(
  self : Statement,
  index~ : Int32,
  value : T,
) -> Unit raise SqliteError {
  self.healthy()
  guard self.phase == 0 else {
    raise sqlite_misuse("reset before rebinding an executed statement")
  }
  guard index >= 1 && index <= self.parameters.length() else {
    raise SqliteError(
      code=Range,
      extended=None,
      msg="binding index out of range",
    )
  }
  T::bind(self, index, value)
}

///|
pub fn[T : Column] Statement::column(
  self : Statement,
  index~ : Int32,
) -> T raise SqliteError {
  self.healthy()
  T::column(self, index)
}

///|
pub fn Statement::reset(
  self : Statement,
  clear_bindings~ : Bool = false,
) -> Unit raise SqliteError {
  self.healthy()
  let previous = self.last_error
  self.phase = 0
  self.rows = []
  self.cursor = -1
  self.last_error = None
  if clear_bindings {
    for i in 0..<self.parameters.length() {
      self.parameters[i] = Null
    }
  }
  if previous is Some(error) {
    raise error
  }
}

///|
pub fn Statement::step(self : Statement) -> Bool raise SqliteError {
  self.healthy()
  if self.phase == 2 || self.phase == 3 {
    self.phase = 0
    self.rows = []
    self.cursor = -1
    self.last_error = None
  }
  if self.phase == 0 {
    let backup = if self.read_only {
      None
    } else {
      Some(copy_store(self.connection.database.store))
    }
    try {
      let cookie = self.connection.database.store.cookie
      self.rows = (self.action)(self.parameters)
      if !self.read_only {
        self.connection.database.serial += 1
        if self.connection.database.store.cookie != cookie {
          self.connection.database.schema_epoch += 1L
        }
      }
    } catch {
      cause => {
        if backup is Some(store) {
          if self.tracks_changes {
            store.last_rowid = self.connection.database.store.last_rowid
          }
          self.connection.database.store = store
        }
        if self.tracks_changes {
          self.connection.database.store.triggers.failed_statement = true
        }
        let error = match cause {
          TriggerAbort(message) =>
            SqliteError(
              code=Constraint,
              extended=Some(ConstraintTrigger),
              msg=message,
            )
          _ => interface_error(public_error(cause))
        }
        self.last_error = Some(error)
        self.phase = 3
        raise error
      }
    }
  }
  self.cursor += 1
  if self.cursor >= self.rows.length() {
    self.phase = 2
    false
  } else {
    self.phase = 1
    true
  }
}

///|
pub fn Statement::finalize(self : Statement) -> Unit raise SqliteError {
  if self.phase == 4 {
    return
  }
  self.healthy()
  self.phase = 4
  self.rows = []
  self.connection.statements -= 1
  if self.last_error is Some(error) {
    self.last_error = None
    raise error
  }
}

///|
fn Statement::set_binding(
  statement : Statement,
  index : Int32,
  value : Value,
) -> Unit raise SqliteError {
  statement.healthy()
  guard statement.phase == 0 else {
    raise sqlite_misuse("reset before rebinding an executed statement")
  }
  guard index >= 1 && index <= statement.parameters.length() else {
    raise SqliteError(
      code=Range,
      extended=None,
      msg="binding index out of range",
    )
  }
  statement.parameters[index - 1] = match value {
    Blob(bytes) => Blob(Bytes::from_array(bytes.to_array()))
    Real(n) => if n.is_nan() { Null } else { Real(n) }
    _ => value
  }
}

///|
pub impl Bind for Value with fn bind(statement, index, value) {
  statement.set_binding(index, value)
}

///|
pub impl Bind for Int32 with fn bind(statement, index, value) {
  statement.set_binding(index, Integer(value.to_int64()))
}

///|
pub impl Bind for Int64 with fn bind(statement, index, value) {
  statement.set_binding(index, Integer(value))
}

///|
pub impl Bind for Double with fn bind(statement, index, value) {
  statement.set_binding(index, Real(value))
}

///|
pub impl Bind for String with fn bind(statement, index, value) {
  statement.set_binding(index, Text(value))
}

///|
pub impl Bind for Bytes with fn bind(statement, index, value) {
  statement.set_binding(index, Blob(value))
}

///|
pub impl Bind for StringView with fn bind(statement, index, value) {
  statement.set_binding(index, Text(value.to_owned()))
}

///|
pub impl Bind for BytesView with fn bind(statement, index, value) {
  statement.set_binding(index, Blob(value.to_owned()))
}

///|
pub impl Column for Value with fn column(statement, index) {
  match statement.value(index) {
    Blob(bytes) => Blob(Bytes::from_array(bytes.to_array()))
    value => value
  }
}

///|
pub impl Column for Int64 with fn column(statement, index) {
  integer_value(statement.value(index))
}

///|
pub impl Column for Double with fn column(statement, index) {
  as_double(statement.value(index))
}

///|
pub impl Column for String with fn column(statement, index) {
  let value = statement.value(index)
  if value is Blob(_) &&
    statement.connection.database.store.encoding.unwrap_or(1) != 1 {
    raise interface_error("unsupported SQL: BLOB conversion in UTF-16 database")
  }
  checked_text_value(value) catch {
    e => raise interface_error(public_error(e))
  }
}

///|
pub impl Column for Bytes with fn column(statement, index) {
  match statement.value(index) {
    Blob(bytes) => Bytes::from_array(bytes.to_array())
    value => @utf8.encode(text_value(value))
  }
}

///|
/// Hosts inject one UTC instant before stepping statements that use the clock.
pub fn Connection::set_clock(
  self : Connection,
  milliseconds : Int64,
) -> Unit raise SqliteError {
  self.healthy()
  self.database.store.triggers.clock = Some(milliseconds)
}
