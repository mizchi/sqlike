///|
priv struct ForeignReference {
  parent : String
  targets : Array[String]
  delete_action : String
  update_action : String
  initially_deferred : Bool
}

///|
fn Parser::foreign_reference(p : Parser) -> ForeignReference raise SqlError {
  let parent = p.name()
  let targets = if p.peek() == "(" { p.names() } else { [] }
  let mut delete_action = "no action"
  let mut update_action = "no action"
  let mut initially_deferred = false
  while true {
    if p.take("on") {
      let update = p.take("update")
      if !update {
        p.expect("delete")
      }
      let action = if p.take("no") {
        p.expect("action")
        "no action"
      } else if p.take("set") {
        if p.take("null") {
          "set null"
        } else {
          p.expect("default")
          "set default"
        }
      } else if p.take("cascade") {
        "cascade"
      } else {
        p.expect("restrict")
        "restrict"
      }
      if update {
        update_action = action
      } else {
        delete_action = action
      }
    } else if p.take("deferrable") {
      if p.take("initially") {
        initially_deferred = p.take("deferred")
        if !initially_deferred {
          p.expect("immediate")
        }
      }
    } else if p.peek() == "not" &&
      p.position + 1 < p.tokens.length() &&
      p.tokens[p.position + 1].word == "deferrable" {
      p.position += 2
      if p.take("initially") {
        if !p.take("immediate") {
          p.expect("deferred")
        }
      }
    } else {
      break
    }
  }
  { parent, targets, delete_action, update_action, initially_deferred, }
}

///|
fn make_foreign_key(
  columns : Array[Int32],
  reference : ForeignReference,
) -> ForeignKey raise SqlError {
  guard !columns.is_empty() &&
    (
      reference.targets.is_empty() ||
      columns.length() == reference.targets.length()
    ) else {
    fail("foreign key column count mismatch")
  }
  {
    column: columns[0],
    parent: reference.parent,
    target: if reference.targets.is_empty() {
      ""
    } else {
      reference.targets[0]
    },
    cascade: reference.delete_action == "cascade",
    columns: if columns.length() > 1 {
      Some(columns)
    } else {
      None
    },
    targets: if reference.targets.length() > 1 {
      Some(reference.targets)
    } else {
      None
    },
    delete_action: if reference.delete_action == "no action" ||
      reference.delete_action == "cascade" {
      None
    } else {
      Some(reference.delete_action)
    },
    update_action: if reference.update_action == "no action" {
      None
    } else {
      Some(reference.update_action)
    },
    initially_deferred: if reference.initially_deferred {
      Some(true)
    } else {
      None
    },
  }
}

///|
#derive(ToJson)
priv struct LegacyForeignKey {
  column : Int32
  parent : String
  target : String
  cascade : Bool
}

///|
impl @json.ToJson for ForeignKey with fn to_json(self) {
  let old : LegacyForeignKey = {
    column: self.column,
    parent: self.parent,
    target: self.target,
    cascade: self.cascade,
  }
  let json = @json.to_json(old)
  if json is Object(fields) {
    if self.columns is Some(v) {
      fields["columns"] = @json.to_json(v)
    }
    if self.targets is Some(v) {
      fields["targets"] = @json.to_json(v)
    }
    if self.delete_action is Some(v) {
      fields["delete_action"] = @json.to_json(v)
    }
    if self.update_action is Some(v) {
      fields["update_action"] = @json.to_json(v)
    }
    if self.initially_deferred is Some(v) {
      fields["initially_deferred"] = @json.to_json(v)
    }
  }
  json
}

///|
fn foreign_columns(fk : ForeignKey) -> Array[Int32] {
  fk.columns.unwrap_or([fk.column])
}

///|
fn foreign_targets(
  parent : Table,
  fk : ForeignKey,
) -> Array[Int32] raise SqlError {
  let names = fk.targets.unwrap_or(
    if fk.target == "" {
      []
    } else {
      [fk.target]
    },
  )
  let targets = if names.is_empty() {
    primary_key(parent)
  } else {
    names.map(n => column_index(parent, n))
  }
  guard targets.length() == foreign_columns(fk).length() else {
    fail("foreign key mismatch")
  }
  targets
}

///|
fn foreign_action(fk : ForeignKey, update : Bool) -> String {
  if update {
    fk.update_action.unwrap_or("no action")
  } else {
    fk.delete_action.unwrap_or(if fk.cascade { "cascade" } else { "no action" })
  }
}

///|
fn foreign_matches(
  store : Store,
  parent : Table,
  row : StoredRow,
  child : StoredRow,
  fk : ForeignKey,
) -> Bool raise SqlError {
  let targets = foreign_targets(parent, fk)
  foreign_columns(fk)
  .mapi((i, c) => {
    !(child.values[c] is Null) &&
    compare_stored(
      store,
      apply_affinity(
        child.values[c],
        column_affinity(parent, parent.columns[targets[i]]),
      ),
      row.values[targets[i]],
      parent.columns[targets[i]].collation,
    ) ==
    0
  })
  .all(v => v)
}

///|
fn foreign_unchanged(
  store : Store,
  parent : Table,
  old : StoredRow,
  next : StoredRow?,
  fk : ForeignKey,
) -> Bool raise SqlError {
  if next is Some(next) {
    return foreign_targets(parent, fk).all(i => {
      compare_stored(
        store,
        old.values[i],
        next.values[i],
        parent.columns[i].collation,
      ) ==
      0
    })
  }
  false
}

///|
fn foreign_restrict(
  store : Store,
  table : Table,
  old : StoredRow,
  next : StoredRow?,
) -> Unit raise SqlError {
  if !FEATURE_FOREIGN_KEYS {
    return
  }
  if !store.foreign_keys {
    return
  }
  for child in store.tables {
    for fk in child.foreign_keys {
      if identifier(fk.parent) == identifier(table.name) &&
        foreign_action(fk, next is Some(_)) == "restrict" &&
        !foreign_unchanged(store, table, old, next, fk) &&
        child.rows.any(r => foreign_matches(store, table, old, r, fk)) {
        fail("FOREIGN KEY constraint failed")
      }
    }
  }
}

///|
fn foreign_actions(
  store : Store,
  table : Table,
  old : StoredRow,
  next : StoredRow?,
  depth : Int32,
) -> Unit raise SqlError {
  if !FEATURE_FOREIGN_KEYS {
    return
  }
  if !store.foreign_keys {
    return
  }
  guard depth <= 32 else { fail("foreign key cascade depth limit") }
  let changes = store.changes
  defer {
    store.changes = changes
  }
  for child in store.tables {
    for fk in child.foreign_keys {
      if identifier(fk.parent) != identifier(table.name) ||
        foreign_unchanged(store, table, old, next, fk) {
        continue
      }
      let action = foreign_action(fk, next is Some(_))
      if action == "no action" || action == "restrict" {
        continue
      }
      for row in child.rows.copy() {
        if !foreign_matches(store, table, old, row, fk) {
          continue
        }
        if action == "cascade" && next is None {
          ignore(delete_row(store, child, row, depth + 1, true))
          continue
        }
        let targets = foreign_targets(table, fk)
        let setters = foreign_columns(fk).mapi((i, c) => {
          (
            child.columns[c].name,
            if action == "set null" {
              Literal(Null)
            } else if action == "set default" {
              Literal(column_default(store, child, child.columns[c], []))
            } else {
              Literal(next.unwrap().values[targets[i]])
            },
          )
        })
        let updated = updated_row(store, child, row, setters, [], [])
        let columns = setters.map(s => s.0)
        prepare_trigger_event(store, child, "update", columns)
        if !run_triggers(
            store,
            child,
            "before",
            "update",
            columns,
            Some(row),
            Some(updated),
          ) {
          continue
        }
        ignore(check_updated_row(store, child, row, updated, []))
        foreign_restrict(store, child, row, Some(updated))
        replace_table_row(store, child, row, updated)
        foreign_actions(store, child, row, Some(updated), depth + 1)
        ignore(
          run_triggers(
            store,
            child,
            "after",
            "update",
            columns,
            Some(row),
            Some(updated),
          ),
        )
      }
    }
  }
}

///|
fn prepare_foreign_table(store : Store, table : Table) -> Unit raise SqlError {
  if !FEATURE_FOREIGN_KEYS || !store.foreign_keys {
    return
  }
  for fk in table.foreign_keys {
    let parent = get_table(store, fk.parent)
    let targets = foreign_targets(parent, fk)
    guard unique_keys(store, parent).any(k => {
      k.length() == targets.length() && targets.all(i => k.contains(i))
    }) else {
      fail("foreign key mismatch: " + table.name)
    }
  }
}
