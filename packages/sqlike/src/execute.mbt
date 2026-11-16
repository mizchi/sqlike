///|
/// Constraints and mutation operate on the row store, independently of parsing.
fn primary_key(table : Table) -> Array[Int32] {
  let keys = table.columns.mapi((i, c) => (i, c.primary)).filter(p => p.1 > 0)
  keys.sort_by((a, b) => a.1.compare(b.1))
  keys.map(p => p.0)
}

///|
fn integer_primary(table : Table) -> Int32 {
  if table.without_rowid {
    return -1
  }
  let mut primary = -1
  for i, column in table.columns {
    if column.primary > 0 {
      if primary >= 0 {
        return -1
      }
      primary = i
    }
  }
  if primary >= 0 &&
    table.columns[primary].declared == "INTEGER" &&
    table.columns[primary].primary_desc != Some(true) {
    primary
  } else {
    -1
  }
}

///|
fn evaluation(
  store : Store,
  params : Array[Value],
  row : Environment,
) -> Evaluation {
  {
    store,
    params,
    row,
    group: None,
    position: 0,
    outer: if store.triggers.row.is_empty() {
      []
    } else {
      [store.triggers.row]
    },
    ctes: Map([]),
    window_values: Map([]),
    depth: 0,
  }
}

///|
fn unique_keys(
  store : Store,
  table : Table,
) -> Array[Array[Int32]] raise SqlError {
  let keys = table.unique_keys.copy()
  for obj in store.objects {
    if obj.kind == "index" &&
      obj.unique &&
      identifier(obj.table) == identifier(table.name) {
      let fields = index_keys(table, obj)
      // A parent FK requires the table column's declared collation.
      if obj.index_predicate is None &&
        fields.all(f => {
          f.column >= 0 && f.collation == table.columns[f.column].collation
        }) {
        keys.push(fields.map(f => f.column))
      }
    }
  }
  keys
}

///|
fn unique_indexes(
  store : Store,
  table : Table,
) -> Array[UniqueIndex] raise SqlError {
  let keys = table.unique_keys.map(key => {
    (
      {
        parts: key.map(column => {
          column,
          expression: Column("", table.columns[column].name),
          collation: table.columns[column].collation,
          descending: false,
        }),
        predicate: None,
      } : UniqueIndex)
  })
  for obj in store.objects {
    if obj.kind == "index" &&
      obj.unique &&
      identifier(obj.table) == identifier(table.name) {
      keys.push(object_index(obj, table))
    }
  }
  keys
}

///|
fn conflict_row(
  store : Store,
  table : Table,
  values : Array[Value],
  excluded : Int64?,
  target : Array[Int32]?,
  target_predicate~ : Expr? = None,
) -> StoredRow? raise SqlError {
  let keys = unique_indexes(store, table).filter(index => {
    target is None ||
    (
      target == Some(index.parts.map(f => f.column)) &&
      (
        index.predicate is None ||
        (
          index.predicate is Some(required) &&
          target_predicate is Some(predicate) &&
          index_predicate_implied(required, predicate)
        )
      )
    )
  })
  for key in keys {
    if find_index_conflict(store, table, key, values, excluded) is Some(row) {
      return Some(row)
    }
  }
  None
}

///|
fn check_row(
  store : Store,
  table : Table,
  values : Array[Value],
  params : Array[Value],
) -> Unit raise SqlError {
  if FEATURE_STRICT && table.strict == Some(true) {
    check_strict_values(table, values)
  }
  for i, col in table.columns {
    if (
        col.not_null ||
        ((table.without_rowid || table.strict == Some(true)) && col.primary > 0)
      ) &&
      values[i] is Null {
      fail("NOT NULL constraint failed: " + table.name + "." + col.name)
    }
  }
  let ctx = evaluation(
    store,
    params,
    row_environment(table, { id: 0L, values, }, table.name),
  )
  for obj in store.objects {
    if obj.kind == "index" &&
      matches_identifier(obj.table, identifier(table.name)) {
      ignore(index_values(store, table, object_index(obj, table), values))
    }
  }
  for check in table.checks {
    if truth(evaluate(check, ctx)) == 0 {
      fail("CHECK constraint failed: " + table.name)
    }
  }
}

///|
fn foreign_key_errors(
  store : Store,
  immediate~ : Bool = false,
  definitions~ : Bool = false,
  only_table~ : String? = None,
) -> Array[Environment] raise SqlError {
  if !FEATURE_FOREIGN_KEYS {
    return []
  }
  let errors : Array[Environment] = []
  for table in store.tables {
    if (only_table is Some(name) && identifier(table.name) != identifier(name)) ||
      (!definitions && table.rows.is_empty()) {
      continue
    }
    for i, fk in table.foreign_keys {
      if immediate &&
        !store.transactions.frames.is_empty() &&
        fk.initially_deferred == Some(true) {
        continue
      }
      let parent = get_table(store, fk.parent)
      let targets = foreign_targets(parent, fk)
      guard unique_keys(store, parent).any(k => {
        k.length() == targets.length() && targets.all(i => k.contains(i))
      }) else {
        fail("foreign key mismatch: " + table.name)
      }
      let columns = foreign_columns(fk)
      for row in table.rows {
        if columns.any(i => row.values[i] is Null) {
          continue
        }
        if !parent.rows.any(r => foreign_matches(store, parent, r, row, fk)) {
          errors.push([
            binding("table", Text(table.name)),
            binding(
              "rowid",
              if table.without_rowid {
                Null
              } else {
                Integer(row.id)
              },
            ),
            binding("parent", Text(parent.name)),
            binding(
              "fkid",
              Integer((table.foreign_keys.length() - 1 - i).to_int64()),
            ),
          ])
        }
      }
    }
  }
  errors
}

///|
fn validate_foreign_keys(
  store : Store,
  immediate~ : Bool = false,
) -> Unit raise SqlError {
  if store.foreign_keys && !foreign_key_errors(store, immediate~).is_empty() {
    fail("FOREIGN KEY constraint failed")
  }
}

///|
fn updated_row(
  store : Store,
  table : Table,
  previous : StoredRow,
  setters : Array[(String, Expr)],
  extra : Environment,
  params : Array[Value],
) -> StoredRow raise SqlError {
  let values = previous.values.copy()
  let ctx = evaluation(
    store,
    params,
    row_environment(table, previous, table.name) + extra,
  )
  for (name, expression) in setters {
    let i = column_index(table, name)
    values[i] = apply_affinity(
      evaluate(expression, ctx),
      column_affinity(table, table.columns[i]),
    )
  }
  let ipk = integer_primary(table)
  let id = if ipk >= 0 {
    guard values[ipk] is Integer(id) else {
      fail("datatype mismatch: INTEGER PRIMARY KEY")
    }
    id
  } else {
    previous.id
  }
  { id, values, }
}

///|
fn check_updated_row(
  store : Store,
  table : Table,
  previous : StoredRow,
  next : StoredRow,
  params : Array[Value],
  policy~ : String? = None,
) -> Bool raise SqlError {
  let values = next.values
  check_row(store, table, values, params) catch {
    SqlError(message) =>
      if policy == Some("ignore") && ignorable_row_constraint(message) {
        return false
      } else {
        fail(message)
      }
    error => raise error
  }
  for fields in unique_indexes(store, table) {
    let key = fields.parts.map(f => f.column)
    if fields.predicate is Some(_) ||
      key.any(i => i < 0) ||
      key_changed(key, previous.values, values) {
      while find_index_conflict(store, table, fields, values, Some(previous.id))
            is Some(duplicate) {
        if policy == Some("ignore") {
          return false
        }
        guard policy == Some("replace") &&
          delete_row(store, table, duplicate, 0, store.triggers.recursive) else {
          fail("UNIQUE constraint failed: " + table.name)
        }
      }
    }
  }
  true
}

///|
/// Unmodified keys cannot introduce a duplicate in a previously valid table.
fn key_changed(
  key : Array[Int32],
  before : Array[Value],
  after : Array[Value],
) -> Bool {
  key.any(i => before[i] != after[i])
}

///|
fn delete_row(
  store : Store,
  table : Table,
  row : StoredRow,
  depth : Int32,
  fire_events : Bool,
) -> Bool raise SqlError {
  if FEATURE_FOREIGN_KEYS {
    guard depth <= 32 else { fail("foreign key cascade depth limit") }
  }
  if fire_events {
    prepare_trigger_event(store, table, "delete", [])
    if !run_triggers(store, table, "before", "delete", [], Some(row), None) {
      return false
    }
  }
  foreign_restrict(store, table, row, None)
  remove_table_row(store, table, row)
  if !store.foreign_keys {
    if fire_events {
      ignore(run_triggers(store, table, "after", "delete", [], Some(row), None))
    }
    return true
  }
  foreign_actions(store, table, row, None, depth)
  if fire_events {
    ignore(run_triggers(store, table, "after", "delete", [], Some(row), None))
  }
  true
}

///|
fn insert_rows(
  store : Store,
  stmt : Insertion,
  params : Array[Value],
) -> Array[Environment] raise SqlError {
  let prior_override = store.triggers.conflict_override
  let stmt = if prior_override is Some(conflict) {
    { ..stmt, conflict, }
  } else {
    stmt
  }
  if prior_override is None {
    store.triggers.conflict_override = stmt.conflict_override
  }
  defer {
    store.triggers.conflict_override = prior_override
  }
  let stmt = if stmt.selection is Some(select) {
    let rows = select_rows(store, select, params, 0)
    {
      ..stmt,
      selection: None,
      values: rows.map(row => {
        row.filter(b => !b.hidden).map(b => Literal(b.value))
      }),
    }
  } else {
    stmt
  }
  let table = get_table(store, stmt.table)
  prepare_foreign_table(store, table)
  prepare_trigger_event(store, table, "insert", [])
  if stmt.conflict == "update" {
    prepare_trigger_event(store, table, "update", stmt.updates.map(p => p.0))
  }
  let columns = if stmt.columns.is_empty() {
    table.columns.mapi((i, _) => i)
  } else {
    stmt.columns.map(n => insertion_column(table, n))
  }
  guard columns.length() ==
    columns.filter(i => columns.filter(j => i == j).length() == 1).length() else {
    fail("duplicate INSERT column")
  }
  let mut target : Array[Int32]? = None
  if !stmt.target.is_empty() {
    let key = stmt.target.map(n => column_index(table, n))
    guard unique_indexes(store, table).any(index => {
      index.parts.map(f => f.column) == key &&
      (
        index.predicate is None ||
        (
          index.predicate is Some(required) &&
          stmt.target_predicate is Some(predicate) &&
          index_predicate_implied(required, predicate)
        )
      )
    }) else {
      fail(
        "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint",
      )
    }
    target = Some(key)
  }
  let result : Array[Environment] = []
  let empty_row = { id: 0L, values: Array::make(table.columns.length(), Null), }
  let template = row_environment(table, empty_row, table.name)
  let excluded = row_environment(table, empty_row, "excluded")
  for (name, e) in stmt.updates {
    ignore(column_index(table, name))
    prepare_expression(
      e,
      evaluation(store, params, template + excluded),
      false,
      false,
    )
  }
  prepare_expression(
    stmt.predicate,
    evaluation(store, params, template + excluded),
    false,
    false,
  )
  prepare_returning(stmt.returning, evaluation(store, params, template))
  for expressions in stmt.values {
    for e in expressions {
      prepare_expression(e, evaluation(store, params, []), false, false)
    }
  }
  let ipk = integer_primary(table)
  let defaults = table.columns.map(c => {
    apply_affinity(
      evaluate(c.default_value, evaluation(store, params, [])),
      column_affinity(table, c),
    )
  })
  store.changes = 0
  for expressions in stmt.values {
    guard expressions.is_empty() || expressions.length() == columns.length() else {
      fail("table column/value count mismatch")
    }
    let values = defaults.copy()
    let mut explicit_id : Value = Null
    for i, e in expressions {
      if columns[i] < 0 {
        explicit_id = evaluate(e, evaluation(store, params, []))
        if ipk >= 0 {
          values[ipk] = explicit_id
        }
        continue
      }
      values[columns[i]] = apply_affinity(
        evaluate(e, evaluation(store, params, [])),
        column_affinity(table, table.columns[columns[i]]),
      )
    }
    let mut maximum = if table.autoincrement {
      table.sequence
    } else if table.rows.is_empty() {
      0L
    } else {
      table.rows[0].id
    }
    for row in table.rows {
      maximum = maximum.max(row.id)
    }
    if ipk >= 0 {
      explicit_id = values[ipk]
    }
    let id = if !(explicit_id is Null) {
      let explicit_id = apply_affinity(explicit_id, "integer")
      guard explicit_id is Integer(n) else { fail("datatype mismatch: rowid") }
      n
    } else if ipk >= 0 && !(values[ipk] is Null) {
      guard values[ipk] is Integer(n) else {
        fail("datatype mismatch: INTEGER PRIMARY KEY")
      }
      n
    } else {
      guard maximum < 9223372036854775807L else {
        fail("rowid allocation limit")
      }
      maximum + 1L
    }
    if ipk >= 0 {
      values[ipk] = Integer(id)
    }
    let proposed = { id, values, }
    if !run_triggers(store, table, "before", "insert", [], None, Some(proposed)) {
      continue
    }
    let mut event = "insert"
    let mut before : StoredRow? = None
    let mut after = proposed
    table.sequence = table.sequence.max(id)
    if table.autoincrement {
      table.sequence_present = Some(true)
    }
    if stmt.conflict == "replace" {
      for i, c in table.columns {
        if c.not_null && values[i] is Null {
          values[i] = defaults[i]
        }
      }
    }
    check_row(store, table, values, params) catch {
      SqlError(message) =>
        if stmt.conflict == "ignore" && ignorable_row_constraint(message) {
          continue
        } else {
          fail(message)
        }
      error => raise error
    }
    let rowid_duplicate = if !table.without_rowid && !(explicit_id is Null) {
      candidate_rows(store, table, Some(id)).iter().next()
    } else {
      None
    }
    let duplicate = match rowid_duplicate {
      Some(row) => Some(row)
      None => conflict_row(store, table, values, None, None)
    }
    if duplicate is Some(previous) {
      if stmt.conflict == "ignore" {
        continue
      }
      if stmt.conflict == "nothing" || stmt.conflict == "update" {
        let matched = if target is None && rowid_duplicate is Some(row) {
          Some(row)
        } else {
          conflict_row(
            store,
            table,
            values,
            None,
            target,
            target_predicate=stmt.target_predicate,
          )
        }
        guard matched is Some(conflicting) && conflicting.id == previous.id else {
          fail("UNIQUE constraint failed: " + table.name)
        }
        if stmt.conflict == "nothing" {
          continue
        }
        let excluded = row_environment(table, { id, values, }, "excluded")
        if truth(
            evaluate(
              stmt.predicate,
              evaluation(
                store,
                params,
                row_environment(table, previous, table.name) + excluded,
              ),
            ),
          ) !=
          1 {
          continue
        }
        let next = updated_row(
          store,
          table,
          previous,
          stmt.updates,
          excluded,
          params,
        )
        if !run_triggers(
            store,
            table,
            "before",
            "update",
            stmt.updates.map(p => p.0),
            Some(previous),
            Some(next),
          ) {
          continue
        }
        if !check_updated_row(store, table, previous, next, params) {
          continue
        }
        event = "update"
        before = Some(previous)
        after = next
        foreign_restrict(store, table, previous, Some(next))
        replace_table_row(store, table, previous, next)
        foreign_actions(store, table, previous, Some(next), 0)
        if !stmt.returning.is_empty() {
          result.push(
            project(
              stmt.returning,
              evaluation(
                store,
                params,
                row_environment(table, next, table.name),
              ),
            ),
          )
        }
      } else if stmt.conflict == "replace" {
        if rowid_duplicate is Some(row) {
          ignore(delete_row(store, table, row, 0, store.triggers.recursive))
        }
        while conflict_row(store, table, values, None, None) is Some(row) {
          ignore(delete_row(store, table, row, 0, store.triggers.recursive))
        }
        append_table_row(store, table, { id, values, })
        store.last_rowid = id
        if !stmt.returning.is_empty() {
          result.push(
            project(
              stmt.returning,
              evaluation(
                store,
                params,
                row_environment(table, { id, values, }, table.name),
              ),
            ),
          )
        }
      } else {
        fail("UNIQUE constraint failed: " + table.name)
      }
    } else {
      append_table_row(store, table, { id, values, })
      store.last_rowid = id
      if !stmt.returning.is_empty() {
        result.push(
          project(
            stmt.returning,
            evaluation(
              store,
              params,
              row_environment(table, { id, values, }, table.name),
            ),
          ),
        )
      }
    }
    store.changes += 1
    ignore(
      run_triggers(
        store,
        table,
        "after",
        event,
        stmt.updates.map(p => p.0),
        before,
        Some(after),
      ),
    )
    guard table.rows.length() <= 100000 else {
      fail("SQL table resource limit")
    }
  }
  result
}

///|
fn execute_pragma(
  store : Store,
  name : String,
  table : String,
  value : Expr?,
  params : Array[Value],
) -> Array[Environment] raise SqlError {
  validate_pragma_features(name)
  if FEATURE_SCHEMA_METADATA && pragma_features(name) != 0U {
    guard value is None else { fail("unsupported metadata PRAGMA assignment") }
    return index_metadata(store, name, table)
  }
  if name == "recursive_triggers" {
    if value is Some(e) {
      store.triggers.recursive = if e is Column("", n) {
        ["on", "true", "yes"].contains(identifier(n))
      } else {
        truth(evaluate(e, evaluation(store, params, []))) == 1
      }
      return []
    }
    return [[binding(name, boolean(store.triggers.recursive))]]
  }
  if name == "encoding" {
    if value is Some(expression) {
      if store.cookie == 0 && store.tables.is_empty() {
        let raw = match expression {
          Column("", name) => name
          _ => text_value(evaluate(expression, evaluation(store, params, [])))
        }
        let normalized = identifier(raw).replace_all(old="-", new="")
        store.encoding = Some(
          match normalized {
            "utf8" => 1
            "utf16" | "utf16le" => 2
            "utf16be" => 3
            _ => fail("unsupported encoding: " + raw)
          },
        )
      }
      return []
    }
    return [
      [
        binding(
          name,
          Text(
            match store.encoding.unwrap_or(1) {
              1 => "UTF-8"
              2 => "UTF-16le"
              _ => "UTF-16be"
            },
          ),
        ),
      ],
    ]
  }
  if name == "table_info" || name == "table_xinfo" {
    let found = store.tables.filter(t => identifier(t.name) == identifier(table))
    if found.is_empty() {
      return []
    }
    return found[0].columns.mapi((i, col) => {
      let output = [
        binding("cid", Integer(i.to_int64())),
        binding("name", Text(col.name)),
        binding("type", Text(col.declared)),
        binding(
          "notnull",
          boolean(
            col.not_null ||
            (
              (
                found[0].without_rowid ||
                (
                  found[0].strict == Some(true) &&
                  integer_primary(found[0]) != i
                )
              ) &&
              col.primary > 0
            ),
          ),
        ),
        binding(
          "dflt_value",
          match col.default_source {
            Some("") => Null
            Some(source) => Text(source)
            None =>
              match store.declaration_sources.get(found[0].sql) {
                Some(sources) =>
                  if sources[i] == "" {
                    Null
                  } else {
                    Text(sources[i])
                  }
                None =>
                  fail(
                    "unsupported SQL: declaration metadata requires catalog rebuild",
                  )
              }
          },
        ),
        binding("pk", Integer(col.primary.to_int64())),
      ]
      if name == "table_xinfo" {
        output.push(binding("hidden", Integer(0L)))
      }
      output
    })
  }
  if name == "foreign_key_list" {
    let found = store.tables.filter(t => identifier(t.name) == identifier(table))
    if found.is_empty() {
      return []
    }
    let t = found[0]
    let rows : Array[Environment] = []
    for i = t.foreign_keys.length() - 1; i >= 0; i = i - 1 {
      let fk = t.foreign_keys[i]
      let columns = foreign_columns(fk)
      let targets = fk.targets.unwrap_or(
        if fk.target == "" {
          []
        } else {
          [fk.target]
        },
      )
      for seq, column in columns {
        rows.push([
          binding("id", Integer((t.foreign_keys.length() - 1 - i).to_int64())),
          binding("seq", Integer(seq.to_int64())),
          binding("table", Text(fk.parent)),
          binding("from", Text(t.columns[column].name)),
          binding(
            "to",
            if targets.is_empty() {
              Null
            } else {
              Text(targets[seq])
            },
          ),
          binding("on_update", Text(foreign_action(fk, true).to_upper())),
          binding("on_delete", Text(foreign_action(fk, false).to_upper())),
          binding("match", Text("NONE")),
        ])
      }
    }
    return rows
  }
  if name == "foreign_key_check" {
    if table != "" {
      let target = get_table(store, table)
      return foreign_key_errors(
        store,
        definitions=true,
        only_table=Some(target.name),
      )
    }
    return foreign_key_errors(store, definitions=true)
  }
  if name == "schema_version" {
    guard value is None else { fail("schema_version is read only") }
    return [[binding(name, Integer(store.cookie.to_int64()))]]
  }
  if name == "quick_check" || name == "integrity_check" {
    fail(
      "unsupported PRAGMA: " + name + " requires a complete integrity checker",
    )
  }
  if name == "foreign_keys" || name == "defer_foreign_keys" {
    if value is Some(e) {
      let on = if e is Column("", n) {
        ["on", "true", "yes"].contains(identifier(n))
      } else {
        truth(evaluate(e, evaluation(store, params, []))) == 1
      }
      if name == "foreign_keys" {
        if store.transactions.frames.is_empty() {
          store.foreign_keys = on
        }
      } else {
        store.deferred = on
      }
      return []
    }
    return [
      [
        binding(
          name,
          boolean(
            if name == "foreign_keys" {
              store.foreign_keys
            } else {
              store.deferred
            },
          ),
        ),
      ],
    ]
  }
  fail("unsupported PRAGMA: " + name)
}

///|
fn execute_statement(
  store : Store,
  stmt : ParsedStatement,
  params : Array[Value],
) -> Array[Environment] raise SqlError {
  let result : Array[Environment] = match stmt {
    Transaction(op, name) => return execute_transaction(store, op, name)
    Select(select) => return select_rows(store, select, params, 0)
    Pragma(name, table, value) =>
      return execute_pragma(store, name, table, value, params)
    CreateTable(table, optional) => {
      validate_table_features(table)
      if store.tables.any(t => identifier(t.name) == identifier(table.name)) ||
        store.objects.any(o => identifier(o.name) == identifier(table.name)) {
        guard optional else { fail("table already exists: " + table.name) }
      } else {
        // Resolve every constraint expression before installing the table.
        let template = row_environment(
          table,
          { id: 0L, values: Array::make(table.columns.length(), Null), },
          table.name,
        )
        for e in table.checks {
          guard !has_parameter(e) && !has_subquery(e) else {
            fail("parameters prohibited in CHECK constraints")
          }
          prepare_expression(
            e,
            evaluation(store, params, template),
            false,
            false,
          )
        }
        for c in table.columns {
          guard constant_default(c.default_value) else {
            fail("unsupported SQL DEFAULT expression")
          }
        }
        store.tables.push(table)
        schema_changed(store)
      }
      []
    }
    CreateObject(object, optional) => {
      if store.objects.any(o => identifier(o.name) == identifier(object.name)) ||
        store.tables.any(t => identifier(t.name) == identifier(object.name)) {
        guard optional else { fail("schema object already exists") }
      } else {
        if object.kind == "index" {
          let table = get_table(store, object.table)
          validate_index_definition(store, table, object)
          for row in table.rows {
            ignore(
              index_values(
                store,
                table,
                object_index(object, table),
                row.values,
              ),
            )
          }
          store.objects.push(object)
          if object.unique {
            for row in table.rows {
              guard conflict_row(store, table, row.values, Some(row.id), None)
                is None else {
                fail("UNIQUE constraint failed: " + table.name)
              }
            }
          }
        } else if object.kind == "trigger" {
          validate_trigger_metadata(get_table(store, object.table), object)
          store.objects.push(object)
        } else {
          store.objects.push(object)
        }
        schema_changed(store)
      }
      []
    }
    Drop(kind, name, optional) => {
      if kind == "table" {
        let tables = store.tables.filter(t => {
          identifier(t.name) == identifier(name)
        })
        guard !tables.is_empty() || optional else {
          fail("no such table: " + name)
        }
        if !tables.is_empty() {
          let remaining = store.tables.filter(t => {
            identifier(t.name) != identifier(name)
          })
          store.tables.clear()
          for t in remaining {
            store.tables.push(t)
          }
          let objects = store.objects.filter(o => {
            identifier(o.table) != identifier(name) || o.kind == "view"
          })
          store.objects.clear()
          for o in objects {
            store.objects.push(o)
          }
          schema_changed(store)
        }
      } else {
        let objects = store.objects.filter(o => {
          !(identifier(o.name) == identifier(name) && o.kind == kind)
        })
        guard objects.length() != store.objects.length() || optional else {
          fail("no such " + kind + ": " + name)
        }
        if objects.length() != store.objects.length() {
          store.objects.clear()
          for o in objects {
            store.objects.push(o)
          }
          schema_changed(store)
        }
      }
      []
    }
    Insert(insertion) =>
      return execute_data_statement(store, PreparedInsert(insertion), params)
    Update(name, setters, predicate, returning) =>
      return execute_data_statement(
        store,
        PreparedUpdate(name, setters, predicate, returning),
        params,
      )
    Delete(name, predicate, returning) =>
      return execute_data_statement(
        store,
        PreparedDelete(name, predicate, returning),
        params,
      )
    AddColumn(name, col, definition) => {
      let table = get_table(store, name)
      if table.strict == Some(true) {
        validate_strict_columns([col])
      }
      guard !table.columns.any(c => identifier(c.name) == identifier(col.name)) else {
        fail("duplicate column name")
      }
      guard constant_default(col.default_value) else {
        fail("unsupported SQL DEFAULT expression")
      }
      let value = apply_affinity(
        evaluate(col.default_value, evaluation(store, params, [])),
        column_affinity(table, col),
      )
      guard !col.not_null || !(value is Null) || table.rows.is_empty() else {
        fail("NOT NULL constraint failed")
      }
      if FEATURE_STRICT && table.strict == Some(true) && !table.rows.is_empty() {
        let candidate = { ..table, columns: [col], }
        check_strict_values(candidate, [value])
      }
      table.columns.push(col)
      replace_table_rows(
        store,
        table,
        table.rows.map(row => { ..row, values: row.values + [value], }),
      )
      let bytes = @utf8.encode(table.sql)
      let mut end = bytes.length() - 1
      while end >= 0 && bytes[end] != b')' {
        end -= 1
      }
      guard end >= 0 else { fail("corrupt table SQL") }
      table.sql = @utf8.decode_lossy(bytes[0:end]) +
        ", " +
        definition +
        @utf8.decode_lossy(bytes[end:])
      schema_changed(store)
      []
    }
    RenameColumn(name, old, new, quoted) => {
      migrate_schema(store, name, name, old, new, false, quoted~)
      []
    }
    RenameTable(name, next) => {
      migrate_schema(store, name, next, "", "", false)
      []
    }
    DropColumn(name, column) => {
      migrate_schema(store, name, name, column, column, true)
      []
    }
  }
  result
}

///|
/// Every statement is atomic, including failures halfway through a multi-row write.
fn database_exec_inner(
  db : Database,
  sql : String,
  bindings : String,
  read_only : Bool,
  positional : Bool,
) -> String {
  let mut backup : Store? = None
  let mut tracks_changes = false
  try {
    let parser = lex(sql)
    let stmt = parse_statement(parser)
    tracks_changes = stmt is Insert(_) ||
      stmt is Update(_, _, _, _) ||
      stmt is Delete(_, _, _)
    let params_json : Array[Json] = @json.from_json(@json.parse(bindings))
    let params = params_json.map(json_value) catch {
      _ => fail("invalid SQL bindings")
    }
    guard parser.parameter == params.length() else {
      fail("SQL binding count mismatch")
    }
    let read = match stmt {
      Select(_) | Pragma(_, _, None) => true
      _ => false
    }
    guard !read_only || read else {
      fail("query() accepts read-only statements")
    }
    if !read {
      backup = Some(copy_store(db.store))
    }
    let rows = execute_statement(db.store, stmt, params)
    if !read {
      db.serial += 1
    }
    (
      {
        "rows": if positional {
          Json::array(
            rows.map(row => {
              Json::array(
                row.filter(b => !b.hidden).map(b => value_json(b.value)),
              )
            }),
          )
        } else {
          result_json(rows)
        },
        "readonly": read,
      } : Json).stringify()
  } catch {
    e => {
      if backup is Some(previous) {
        if tracks_changes {
          previous.last_rowid = db.store.last_rowid
        }
        db.store = previous
        if tracks_changes {
          db.store.triggers.failed_statement = true
        }
      }
      public_error_json(e).stringify()
    }
  }
}

///|
pub fn database_exec(
  db : Database,
  sql : String,
  bindings : String,
  read_only : Bool,
) -> String {
  database_exec_inner(db, sql, bindings, read_only, false)
}

///|
/// SQL result columns retain ordinal position even when names are duplicated.
pub fn database_query_values(
  db : Database,
  sql : String,
  bindings : String,
) -> String {
  database_exec_inner(db, sql, bindings, true, true)
}

///|
/// Mutable execution with ordinal result columns, including DML RETURNING.
pub fn database_exec_values(
  db : Database,
  sql : String,
  bindings : String,
) -> String {
  database_exec_inner(db, sql, bindings, false, true)
}

///|
/// SQLite OR IGNORE covers row constraints, but never datatype violations or
/// evaluation errors (including an index expression or an explicit RAISE).
fn ignorable_row_constraint(message : String) -> Bool {
  message.has_prefix("NOT NULL constraint failed") ||
  message.has_prefix("CHECK constraint failed") ||
  message.has_prefix("UNIQUE constraint failed")
}
