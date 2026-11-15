///|
#derive(FromJson)
priv struct QueryInput {
  name : String
  sql : String
}

///|
#derive(FromJson)
priv struct ProgramInput {
  schema : Array[String]
  queries : Array[QueryInput]
  storage : StoragePlan?
}

///|
pub fn compile_program(request : String) -> String {
  try {
    guard request.length() <= 1048576 else {
      fail("compiler input resource limit")
    }
    let input : ProgramInput = @json.from_json(@json.parse(request))
    let db = database_open()
    for sql in input.schema {
      let parser = lex(sql)
      let statement = parse_statement(parser)
      guard parser.parameter == 0 &&
        (statement is CreateTable(_, _) || statement is CreateObject(_, _)) else {
        fail("schema catalog accepts CREATE TABLE/INDEX/VIEW/TRIGGER only")
      }
      ignore(execute_statement(db.store, statement, []))
    }
    for object in db.store.objects {
      if object.kind == "trigger" {
        prepare_trigger(db.store, get_table(db.store, object.table), object)
      }
    }
    let queries : Array[CompiledQuery] = []
    for query in input.queries {
      let parser = lex(query.sql)
      let parsed = parse_statement(parser)
      let statement = match parsed {
        Transaction(op, name) => PreparedTransaction(op, name)
        Select(select) => PreparedSelect(select)
        Pragma(name, table, None) => PreparedPragma(name, table)
        Insert(insert) => PreparedInsert(insert)
        Update(name, setters, predicate, returning) =>
          PreparedUpdate(name, setters, predicate, returning)
        Delete(name, predicate, returning) =>
          PreparedDelete(name, predicate, returning)
        _ => fail("runtime query catalog cannot contain DDL or writable PRAGMA")
      }
      queries.push({
        name: query.name,
        parameters: parser.parameter,
        names: prepared_names(db.store, statement, parser.parameter),
        statement,
      })
    }
    // Declaration spelling is observable only through table_info/xinfo. Leave
    // other application artifacts byte-compatible and keep the AOT parser absent.
    if !queries.any(q => {
        match q.statement {
          PreparedPragma("table_info", _) | PreparedPragma("table_xinfo", _) =>
            true
          _ => false
        }
      }) {
      for table in db.store.tables {
        for col in table.columns {
          col.default_source = None
        }
      }
    }
    let program : CompiledProgram = {
      format: "moon-aot@1",
      schema: db.store,
      queries,
      storage: input.storage,
    }
    let result = @json.to_json(program).stringify()
    ignore(Program::load(result))
    result
  } catch {
    error =>
      (
        {
          "error": match error {
            SqlError(message) => message
            SqliteError(msg=message, ..) => message
            _ => error.to_string()
          },
        } : Json).stringify()
  }
}
