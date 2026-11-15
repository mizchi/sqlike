///|
/// SQL text entry point for development/build tools. The AOT runtime constructs
/// the same Statement through statement_new without retaining this function.
pub fn Connection::prepare(
  self : Connection,
  sql : String,
) -> Statement raise SqliteError {
  self.healthy()
  guard self.program is None else {
    raise sqlite_misuse("compiled connections require prepare_compiled")
  }
  try {
    let parser = lex(sql)
    let statement = parse_statement(parser)
    let params = Array::make(parser.parameter, Value::Null)
    let names = match statement {
      Select(select) =>
        selection_template(select, evaluation(self.database.store, params, [])).map(b => {
            b.name
          },
        )
      Insert(insertion) =>
        project_template(
          insertion.returning,
          evaluation(
            self.database.store,
            params,
            row_environment(
              get_table(self.database.store, insertion.table),
              {
                id: 0L,
                values: Array::make(
                  get_table(self.database.store, insertion.table).columns.length(),
                  Null,
                ),
              },
              insertion.table,
            ),
          ),
        ).map(b => b.name)
      Update(name, _, _, returning) | Delete(name, _, returning) => {
        let table = get_table(self.database.store, name)
        project_template(
          returning,
          evaluation(
            self.database.store,
            params,
            row_environment(
              table,
              { id: 0L, values: Array::make(table.columns.length(), Null), },
              name,
            ),
          ),
        ).map(b => b.name)
      }
      Pragma(name, table, None) => {
        let result = execute_pragma(
          self.database.store,
          name,
          table,
          None,
          params,
        )
        if result.is_empty() {
          []
        } else {
          result[0].filter(b => !b.hidden).map(b => b.name)
        }
      }
      _ => []
    }
    let read_only = match statement {
      Select(_) | Pragma(_, _, None) => true
      _ => false
    }
    statement_new(
      self,
      parser.parameter,
      names,
      read_only,
      parameters => {
        execute_statement(self.database.store, statement, parameters)
      },
      tracks_changes=statement is Insert(_) ||
        statement is Update(_, _, _, _) ||
        statement is Delete(_, _, _),
    )
  } catch {
    error => raise interface_error(public_error(error))
  }
}
