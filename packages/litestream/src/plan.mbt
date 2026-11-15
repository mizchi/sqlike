///|
#derive(FromJson)
priv struct RowChange {
  table : String
  op : Int32
  old : Array[Json]
  new : Array[Json]
}

///|
fn quote_identifier(name : String) -> String {
  "\"" + name.replace_all(old="\"", new="\"\"") + "\""
}

///|
/// DO adapters execute this plan in one transaction. Old values define conflicts.
fn plan_changes_checked(
  changes_json : String,
  schema_json : String,
) -> String raise {
  let changes : Array[RowChange] = @json.from_json(@json.parse(changes_json))
  let schema : Map[String, Array[String]] = @json.from_json(
    @json.parse(schema_json),
  )
  let result : Array[Json] = []
  for change in changes {
    let columns = match schema.get(change.table) {
      Some(columns) => columns
      None => raise Invalid("unknown table")
    }
    let table = quote_identifier(change.table)
    let names = columns.map(quote_identifier).join(",")
    let placeholders = columns.map(_ => "?").join(",")
    if change.op == 18 {
      guard change.new.length() == columns.length() else {
        raise Invalid("column count")
      }
      result.push({
        "check": null,
        "write": {
          "sql": "INSERT INTO " +
          table +
          "(" +
          names +
          ") VALUES (" +
          placeholders +
          ")",
          "params": change.new,
        },
      })
      continue
    }
    guard change.old.length() == columns.length() else {
      raise Invalid("column count")
    }
    let predicates : Array[String] = []
    let expected : Array[Json] = []
    for i, column in columns {
      if !(change.old[i] is { "t": "undefined", .. }) {
        predicates.push(quote_identifier(column) + " IS ?")
        expected.push(change.old[i])
      }
    }
    guard !predicates.is_empty() else { raise Invalid("missing old values") }
    let predicate = predicates.join(" AND ")
    let check : Json = {
      "sql": "SELECT 1 FROM " + table + " WHERE " + predicate,
      "params": expected,
    }
    if change.op == 9 {
      result.push({
        "check": check,
        "write": {
          "sql": "DELETE FROM " + table + " WHERE " + predicate,
          "params": expected,
        },
      })
    } else {
      guard change.op == 23 && change.new.length() == columns.length() else {
        raise Invalid("invalid update")
      }
      let setters : Array[String] = []
      let values : Array[Json] = []
      for i, column in columns {
        if !(change.new[i] is { "t": "undefined", .. }) {
          setters.push(quote_identifier(column) + "=?")
          values.push(change.new[i])
        }
      }
      guard !setters.is_empty() else { raise Invalid("empty update") }
      result.push({
        "check": check,
        "write": {
          "sql": "UPDATE " +
          table +
          " SET " +
          setters.join(",") +
          " WHERE " +
          predicate,
          "params": values + expected,
        },
      })
    }
  }
  @json.to_json(result).stringify()
}

///|
pub fn plan_changes(changes_json : String, schema_json : String) -> String {
  plan_changes_checked(changes_json, schema_json) catch {
    _ => "{\"error\":\"invalid changeset apply plan\"}"
  }
}
