///|
priv struct TransactionFrame {
  name : String
  store : Store
}

///|
priv struct TransactionRuntime {
  frames : Array[TransactionFrame]
  mut explicit : Bool
}

///|
fn transaction_runtime() -> TransactionRuntime {
  { frames: [], explicit: false, }
}

///|
pub fn database_autocommit(db : Database) -> Bool {
  db.store.transactions.frames.is_empty()
}

///|
/// Rollback restores schema/data/dirty edits, retaining connection-local counters.
fn restore_transaction(store : Store, state : Store) -> Unit {
  let copy = copy_store(state)
  store.tables.clear()
  for table in copy.tables {
    store.tables.push(table)
  }
  store.objects.clear()
  for object in copy.objects {
    store.objects.push(object)
  }
  store.cookie = copy.cookie
  store.encoding = copy.encoding
  store.dirty = copy.dirty
  store.indexes.clear()
  store.primary_indexes.clear()
}

///|
fn execute_transaction(
  store : Store,
  op : String,
  name : String,
) -> Array[Environment] raise SqlError {
  guard store.triggers.active.is_empty() else {
    fail("transaction control inside trigger")
  }
  let tx = store.transactions
  if op == "begin" || op == "savepoint" {
    if op == "begin" {
      guard tx.frames.is_empty() else {
        fail("cannot start a transaction within a transaction")
      }
    }
    guard tx.frames.length() < 1000 else { fail("savepoint resource limit") }
    let saved = copy_store(store)
    if tx.frames.is_empty() {
      tx.explicit = op == "begin"
    }
    tx.frames.push({
      name: if op == "begin" {
        ""
      } else {
        identifier(name)
      },
      store: saved,
    })
  } else if op == "commit" || op == "rollback" {
    guard !tx.frames.is_empty() else {
      fail("cannot " + op + " - no transaction is active")
    }
    if op == "commit" {
      validate_foreign_keys(store)
    } else {
      restore_transaction(store, tx.frames[0].store)
    }
    tx.frames.clear()
    tx.explicit = false
    store.deferred = false
  } else {
    let mut index = tx.frames.length() - 1
    while index >= 0 && tx.frames[index].name != identifier(name) {
      index -= 1
    }
    guard index >= 0 else { fail("no such savepoint: " + name) }
    if op == "rollback to" {
      restore_transaction(store, tx.frames[index].store)
      while tx.frames.length() > index + 1 {
        ignore(tx.frames.pop())
      }
    } else {
      if index == 0 && !tx.explicit {
        validate_foreign_keys(store)
      }
      while tx.frames.length() > index {
        ignore(tx.frames.pop())
      }
      if tx.frames.is_empty() {
        store.deferred = false
        tx.explicit = false
      }
    }
  }
  []
}
