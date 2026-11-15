///|
#derive(ToJson, FromJson)
priv struct TriggerDefinition {
  timing : String
  event : String
  columns : Array[String]
  condition : Expr
  body : Array[DataStatement]
}

///|
/// Connection-local execution frames, never serialized or shared with a clone.
priv struct TriggerRuntime {
  mut clock : Int64?
  mut row : Environment
  active : Array[String]
  mut recursive : Bool
  mut prior_changes : Int32
  mut data_depth : Int32
  mut failed_statement : Bool
  mut conflict_override : String?
}

///|
fn trigger_runtime() -> TriggerRuntime {
  {
    clock: None,
    row: [],
    active: [],
    recursive: false,
    prior_changes: 0,
    data_depth: 0,
    failed_statement: false,
    conflict_override: None,
  }
}

///|
fn connection_changes(store : Store) -> Int32 {
  if store.triggers.failed_statement {
    0
  } else {
    store.changes
  }
}

///|
fn trigger_raise_action(args : Array[Expr]) -> String raise SqlError {
  guard !args.is_empty() && args[0] is Column("", name) else {
    fail("unsupported RAISE() action")
  }
  let name = identifier(name)
  guard (name == "ignore" && args.length() == 1) ||
    (name == "abort" && args.length() == 2) else {
    fail("unsupported RAISE() action")
  }
  name
}

///|
fn trigger_environment(
  table : Table,
  event : String,
  before : StoredRow?,
  after : StoredRow?,
) -> Environment {
  let mut env : Environment = []
  if event != "insert" && before is Some(row) {
    env = env + row_environment(table, row, "old")
  }
  if event != "delete" && after is Some(row) {
    env = env + row_environment(table, row, "new")
  }
  env
}

///|
fn trigger_applies(
  trigger : TriggerDefinition,
  event : String,
  columns : Array[String],
) -> Bool {
  trigger.event == event &&
  (
    trigger.columns.is_empty() ||
    trigger.columns.any(c => columns.any(n => identifier(c) == identifier(n)))
  )
}

///|
fn validate_trigger_metadata(
  table : Table,
  object : SchemaObject,
) -> Unit raise SqlError {
  guard FEATURE_TRIGGERS else { fail("feature disabled: triggers") }
  validate_optional_features(object)
  guard object.trigger is Some(t) &&
    ["before", "after"].contains(t.timing) &&
    ["insert", "update", "delete"].contains(t.event) &&
    !t.body.is_empty() &&
    t.body.length() <= 1000 &&
    (t.event == "update" || t.columns.is_empty()) &&
    (t.timing != "before" || t.body.all(data_readonly)) &&
    identifier(object.table) == identifier(table.name) else {
    fail("invalid or unsupported trigger definition")
  }
}

///|
fn prepare_trigger(
  store : Store,
  table : Table,
  object : SchemaObject,
) -> Unit raise SqlError {
  guard FEATURE_TRIGGERS else { fail("feature disabled: triggers") }
  validate_trigger_metadata(table, object)
  guard object.trigger is Some(t) else { fail("missing trigger definition") }
  let row = { id: 0L, values: Array::make(table.columns.length(), Null), }
  let old = store.triggers.row
  store.triggers.row = trigger_environment(table, t.event, Some(row), Some(row))
  store.triggers.active.push(identifier(object.name))
  defer {
    store.triggers.row = old
    ignore(store.triggers.active.pop())
  }
  prepare_expression(t.condition, evaluation(store, [], []), false, false)
  for statement in t.body {
    ignore(prepared_names(store, statement, 0))
  }
}

///|
fn prepare_trigger_event(
  store : Store,
  table : Table,
  event : String,
  columns : Array[String],
) -> Unit raise SqlError {
  if !FEATURE_TRIGGERS {
    return
  }
  for object in store.objects {
    if object.kind == "trigger" &&
      matches_identifier(object.table, identifier(table.name)) &&
      object.trigger is Some(t) &&
      trigger_applies(t, event, columns) {
      prepare_trigger(store, table, object)
    }
  }
}

///|
fn fire_trigger(
  store : Store,
  table : Table,
  object : SchemaObject,
  before : StoredRow?,
  after : StoredRow?,
) -> Bool raise SqlError {
  guard object.trigger is Some(t) else { fail("missing trigger definition") }
  guard store.triggers.active.length() < 32 else {
    fail("too many levels of trigger recursion")
  }
  let env = store.triggers.row
  let changes = store.changes
  let rowid = store.last_rowid
  store.triggers.row = trigger_environment(table, t.event, before, after)
  store.triggers.active.push(identifier(object.name))
  store.changes = store.triggers.prior_changes
  defer {
    store.triggers.row = env
    ignore(store.triggers.active.pop())
    store.changes = changes
    store.last_rowid = rowid
  }
  try {
    if truth(evaluate(t.condition, evaluation(store, [], []))) != 1 {
      return true
    }
    for statement in t.body {
      ignore(execute_data_statement(store, statement, []))
    }
    true
  } catch {
    TriggerIgnore => false
    TriggerAbort(message) => raise TriggerAbort(message)
    SqlError(message) => fail(message)
  }
}

///|
#derive(ToJson)
priv struct LegacyInsertion {
  table : String
  columns : Array[String]
  values : Array[Array[Expr]]
  conflict : String
  target : Array[String]
  updates : Array[(String, Expr)]
  predicate : Expr
  returning : Array[Projection]
}

///|
impl @json.ToJson for Insertion with fn to_json(self) {
  let json = @json.to_json(
    (
      {
        table: self.table,
        columns: self.columns,
        values: self.values,
        conflict: self.conflict,
        target: self.target,
        updates: self.updates,
        predicate: self.predicate,
        returning: self.returning,
      } : LegacyInsertion),
  )
  if json is Object(fields) {
    if self.conflict_override is Some(value) {
      fields["conflict_override"] = @json.to_json(value)
    }
    if self.selection is Some(value) {
      fields["selection"] = @json.to_json(value)
    }
    if self.target_predicate is Some(value) {
      fields["target_predicate"] = @json.to_json(value)
    }
  }
  json
}

///|
fn run_triggers(
  store : Store,
  table : Table,
  timing : String,
  event : String,
  columns : Array[String],
  before : StoredRow?,
  after : StoredRow?,
) -> Bool raise SqlError {
  if !FEATURE_TRIGGERS {
    return true
  }
  let triggers = store.objects.filter(o => {
    o.kind == "trigger" && matches_identifier(o.table, identifier(table.name))
  })
  for i in 0..<triggers.length() {
    let object = triggers[triggers.length() - 1 - i]
    if object.trigger is Some(t) &&
      t.timing == timing &&
      trigger_applies(t, event, columns) &&
      (
        store.triggers.recursive ||
        !store.triggers.active.contains(identifier(object.name))
      ) {
      if !fire_trigger(store, table, object, before, after) {
        return false
      }
    }
  }
  true
}
