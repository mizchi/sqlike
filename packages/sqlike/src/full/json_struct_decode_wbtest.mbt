///|
// Independent compiler-derived readers preserve the old acceptance contract.
// These types are test-only and never enter a runtime bundle.
#derive(ToJson, FromJson)
priv struct ReferenceJsonTable {
  name : String
  sql : String
  columns : Array[ColumnDef]
  unique_keys : Array[Array[Int32]]
  checks : Array[Expr]
  foreign_keys : Array[ForeignKey]
  without_rowid : Bool
  strict : Bool?
  autoincrement : Bool
  sequence : Int64
  sequence_present : Bool?
  rows : RowPages
}

///|
#derive(ToJson, FromJson)
priv struct ReferenceJsonSelection {
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
#derive(ToJson, FromJson)
priv struct ReferenceJsonObject {
  kind : String
  name : String
  table : String
  sql : String
  unique : Bool
  columns : Array[String]
  query : String
  selection : Selection?
  index_terms : Array[Ordering]?
  index_predicate : Expr?
  trigger : TriggerDefinition?
}

///|
#derive(ToJson, FromJson)
priv struct ReferenceJsonInsertion {
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
fn[T : @json.FromJson + @json.ToJson] json_reader_value(
  json : Json,
  _type : T?,
) -> Json? {
  let value : T = @json.from_json(json) catch { _ => return None }
  Some(@json.to_json(value))
}

///|
fn json_struct_mutations(json : Json, optional : Array[String]) -> Array[Json] {
  guard json is Object(fields) else { return [json] }
  let result : Array[Json] = [json, Json::null(), [], true, "bad"]
  let extra = Map(fields.to_array())
  extra["unknown_extension"] = { "ignored": true }
  result.push(Json::object(extra))
  let names : Array[String] = fields.keys().collect()
  for name in optional {
    if !names.contains(name) {
      names.push(name)
    }
  }
  for name in names {
    result.push(Json::object(Map(fields.to_array().filter(p => p.0 != name))))
    for value in ([Json::null(), true, 1.5, "bad", [], {}] : Array[Json]) {
      let changed = Map(fields.to_array())
      changed[name] = value
      result.push(Json::object(changed))
    }
  }
  result
}

///|
test "compact JSON struct readers agree with derive on missing, unknown and mistyped fields" {
  guard parse_statement(
      lex(
        "CREATE TABLE t(id INTEGER PRIMARY KEY AUTOINCREMENT,v TEXT DEFAULT 'x' CHECK(length(v)>0)) STRICT",
      ),
    )
    is CreateTable(table, _) else {
    fail("table fixture")
  }
  for
    json in json_struct_mutations(@json.to_json(table), [
      "strict", "sequence_present",
    ]) {
    assert_eq(
      json_reader_value(json, (None : Table?)),
      json_reader_value(json, (None : ReferenceJsonTable?)),
    )
  }
  guard parse_statement(
      lex(
        "WITH a AS(SELECT 1 AS v) SELECT DISTINCT v FROM a ORDER BY v LIMIT 1",
      ),
    )
    is Select(selection) else {
    fail("selection fixture")
  }
  for
    json in json_struct_mutations(@json.to_json(selection), [
      "compound", "recursive", "cte_names",
    ]) {
    assert_eq(
      json_reader_value(json, (None : Selection?)),
      json_reader_value(json, (None : ReferenceJsonSelection?)),
    )
  }
  guard parse_statement(lex("CREATE VIEW v AS SELECT 1 AS x"))
    is CreateObject(object, _) else {
    fail("object fixture")
  }
  for
    json in json_struct_mutations(@json.to_json(object), [
      "selection", "index_terms", "index_predicate", "trigger",
    ]) {
    assert_eq(
      json_reader_value(json, (None : SchemaObject?)),
      json_reader_value(json, (None : ReferenceJsonObject?)),
    )
  }
  guard parse_statement(
      lex(
        "INSERT INTO t VALUES(1,'x') ON CONFLICT(id) DO UPDATE SET v=excluded.v RETURNING id,v",
      ),
    )
    is Insert(insertion) else {
    fail("insert fixture")
  }
  for
    json in json_struct_mutations(@json.to_json(insertion), [
      "conflict_override", "target_predicate", "selection",
    ]) {
    assert_eq(
      json_reader_value(json, (None : Insertion?)),
      json_reader_value(json, (None : ReferenceJsonInsertion?)),
    )
  }
}

///|
fn json_struct_bench_table() -> Json raise {
  guard parse_statement(
      lex(
        "CREATE TABLE t(id INTEGER PRIMARY KEY AUTOINCREMENT,v TEXT DEFAULT 'x' CHECK(length(v)>0)) STRICT",
      ),
    )
    is CreateTable(table, _) else {
    fail("table fixture")
  }
  @json.to_json(table)
}

///|
fn json_struct_bench_selection() -> Json raise {
  guard parse_statement(
      lex(
        "WITH a AS(SELECT 1 AS v) SELECT DISTINCT v FROM a ORDER BY v LIMIT 1",
      ),
    )
    is Select(selection) else {
    fail("selection fixture")
  }
  @json.to_json(selection)
}

///|
test "JSON struct Table compact" (b : @bench.T) {
  let json = json_struct_bench_table()
  b.bench(fn() {
    let value : Table = @json.from_json(json) catch { _ => abort("decode") }
    b.keep(value)
  })
}

///|
test "JSON struct Table derive" (b : @bench.T) {
  let json = json_struct_bench_table()
  b.bench(fn() {
    let value : ReferenceJsonTable = @json.from_json(json) catch {
      _ => abort("decode")
    }
    b.keep(value)
  })
}

///|
test "JSON struct Selection compact" (b : @bench.T) {
  let json = json_struct_bench_selection()
  b.bench(fn() {
    let value : Selection = @json.from_json(json) catch { _ => abort("decode") }
    b.keep(value)
  })
}

///|
test "JSON struct Selection derive" (b : @bench.T) {
  let json = json_struct_bench_selection()
  b.bench(fn() {
    let value : ReferenceJsonSelection = @json.from_json(json) catch {
      _ => abort("decode")
    }
    b.keep(value)
  })
}
