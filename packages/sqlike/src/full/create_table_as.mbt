///|
/// CTAS persists a normalized CREATE TABLE, never the source SELECT. SQL text
/// formatting follows SQLite build.c (public domain), including its width rule.
fn ctas_identifier(name : String) -> String {
  let bytes = @utf8.encode(name)
  let safe = !bytes.is_empty() &&
    !(bytes[0] >= b'0' && bytes[0] <= b'9') &&
    bytes
    .to_array()
    .all(b => {
      (b >= b'a' && b <= b'z') ||
      (b >= b'A' && b <= b'Z') ||
      (b >= b'0' && b <= b'9') ||
      b == b'_'
    })
  let keywords = " abort action add after all alter always analyze and as asc attach autoincrement before begin between by cascade case cast check collate column commit conflict constraint create cross current current_date current_time current_timestamp database default deferrable deferred delete desc detach distinct do drop each else end escape except exclude exclusive exists explain fail filter first following for foreign from full generated glob group groups having if ignore immediate in index indexed initially inner insert instead intersect into is isnull join key last left like limit match materialized natural no not nothing notnull null nulls of offset on or order others outer over partition plan pragma preceding primary query raise range recursive references regexp reindex release rename replace restrict returning right rollback row rows savepoint select set table temp temporary then ties to transaction trigger unbounded union unique update using vacuum values view virtual when where window with without "
  if safe && !keywords.contains(" " + identifier(name) + " ") {
    name
  } else {
    "\"" + name.replace(old="\"", new="\"\"") + "\""
  }
}

///|
fn ctas_identifier_length(name : String) -> Int32 {
  @utf8.encode(name).length() +
  @utf8.encode(name).to_array().filter(b => b == b'"').length() +
  2
}

///|
fn ctas_sql(name : String, columns : Array[ColumnDef]) -> String {
  let width = columns.fold(init=ctas_identifier_length(name), (n, c) => {
    n + ctas_identifier_length(c.name) + 5
  })
  let multiline = width >= 50
  "CREATE TABLE " +
  ctas_identifier(name) +
  "(" +
  (if multiline { "\n  " } else { "" }) +
  columns
  .map(c => {
    ctas_identifier(c.name) +
    (if c.declared == "" { "" } else { " " + c.declared })
  })
  .join(if multiline { ",\n  " } else { "," }) +
  (if multiline { "\n)" } else { ")" })
}

///|
fn ctas_column_name(
  name : String,
  names : Map[String, Bool],
) -> String raise SqlError {
  let mut candidate = name
  let mut suffix = 0
  while names.contains(identifier(candidate)) {
    guard suffix < 4 else {
      fail(
        "unsupported CTAS random duplicate column suffix; use explicit aliases",
      )
    }
    let bytes = @utf8.encode(candidate)
    let mut j = bytes.length() - 1
    while j > 0 && bytes[j] >= b'0' && bytes[j] <= b'9' {
      j -= 1
    }
    let base = if j >= 0 && bytes[j] == b':' {
      @utf8.decode_lossy(bytes[0:j])
    } else {
      candidate
    }
    suffix += 1
    candidate = base + ":" + suffix.to_string()
  }
  names[identifier(candidate)] = true
  candidate
}

///|
/// Compound-derived affinities have additional SQLite rules. Reject them until
/// those metadata rules are implemented; ordinary SELECT/CTE/JOIN remain usable.
fn validate_ctas_selection(
  store : Store,
  select : Selection,
  build_only : Bool,
  depth : Int32,
) -> Unit raise SqlError {
  guard depth <= 16 else { fail("CTAS query recursion limit") }
  guard select.compound.unwrap_or([]).is_empty() else {
    fail("unsupported compound affinity in CTAS")
  }
  for (_, cte) in select.ctes {
    validate_ctas_selection(store, cte, build_only, depth + 1)
  }
  for source in select.sources {
    validate_ctas_expression(store, source.on, build_only, depth)
    for object in store.objects {
      if object.kind == "view" &&
        matches_identifier(object.name, identifier(source.name)) &&
        object.selection is Some(view) {
        validate_ctas_selection(store, view, build_only, depth + 1)
      }
    }
  }
  for p in select.projections {
    validate_ctas_expression(store, p.expression, build_only, depth)
  }
  for e in select.groups {
    validate_ctas_expression(store, e, build_only, depth)
  }
  for o in select.orders {
    validate_ctas_expression(store, o.expression, build_only, depth)
  }
  for e in [select.predicate, select.having, select.limit, select.offset] {
    validate_ctas_expression(store, e, build_only, depth)
  }
}

///|
fn validate_ctas_expression(
  store : Store,
  e : Expr,
  build_only : Bool,
  depth : Int32,
) -> Unit raise SqlError {
  match e {
    CurrentTime(_) => {
      guard !build_only else { fail("nondeterministic clock in catalog CTAS") }
    }
    Unary(_, e) | Cast(e, _) | Collate(e, _) =>
      validate_ctas_expression(store, e, build_only, depth)
    Binary(_, a, b) => {
      validate_ctas_expression(store, a, build_only, depth)
      validate_ctas_expression(store, b, build_only, depth)
    }
    Between(e, a, b) =>
      for item in [e, a, b] {
        validate_ctas_expression(store, item, build_only, depth)
      }
    Case(base, arms, otherwise) => {
      if base is Some(e) {
        validate_ctas_expression(store, e, build_only, depth)
      }
      for (a, b) in arms {
        validate_ctas_expression(store, a, build_only, depth)
        validate_ctas_expression(store, b, build_only, depth)
      }
      validate_ctas_expression(store, otherwise, build_only, depth)
    }
    Call(name, args) => {
      guard !build_only ||
        (
          (function_features(name) & 32U) == 0U &&
          !["changes", "last_insert_rowid", "random", "randomblob"].contains(
            name,
          )
        ) else {
        fail("nondeterministic function in catalog CTAS: " + name)
      }
      for arg in args {
        validate_ctas_expression(store, arg, build_only, depth)
      }
    }
    InSelect(left, select) => {
      validate_ctas_expression(store, left, build_only, depth)
      validate_ctas_selection(store, select, build_only, depth + 1)
    }
    ScalarSelect(select) | Exists(select) =>
      validate_ctas_selection(store, select, build_only, depth + 1)
    RowNumber(orders) =>
      for o in orders {
        validate_ctas_expression(store, o.expression, build_only, depth)
      }
    Window(_, args, partitions, orders, frame) => {
      for bound in [frame.start, frame.end] {
        match bound {
          Preceding(value) | Following(value) =>
            validate_ctas_expression(store, value, build_only, depth)
          _ => ()
        }
      }
      for e in args + partitions {
        validate_ctas_expression(store, e, build_only, depth)
      }
      for o in orders {
        validate_ctas_expression(store, o.expression, build_only, depth)
      }
    }
    _ => ()
  }
}

///|
fn create_table_as(
  store : Store,
  name : String,
  select : Selection,
  params : Array[Value],
) -> Table raise SqlError {
  guard !identifier(name).has_prefix("sqlite_") else {
    fail("reserved table name: " + name)
  }
  validate_ctas_selection(store, select, false, 0)
  let naming = {
    ..select,
    projections: select.projections.map(p => {
      let mut expression = p.expression
      while expression is Collate(inner, _) {
        expression = inner
      }
      if !p.explicit_label && expression is Column(_, _) {
        { ..p, expression, }
      } else {
        p
      }
    }),
  }
  let template = selection_template(naming, evaluation(store, params, []))
  guard !template.is_empty() && template.length() <= 2000 else {
    fail("CTAS column resource limit")
  }
  let names : Map[String, Bool] = Map([])
  let columns = template.mapi((i, b) => {
    let label = if ["true", "false"].contains(identifier(b.name)) {
      "column" + (i + 1).to_string()
    } else {
      b.name
    }
    let declared = match b.affinity {
      "text" => "TEXT"
      "numeric" => "NUM"
      "integer" => "INT"
      "real" => "REAL"
      _ => ""
    }
    (
      {
        name: ctas_column_name(label, names),
        declared,
        not_null: false,
        primary: 0,
        primary_desc: None,
        default_value: Literal(Null),
        default_source: Some(""),
        collation: "binary",
      } : ColumnDef)
  })
  let selected = select_rows(store, select, params, 0)
  guard selected.length() <= 100000 else { fail("CTAS row resource limit") }
  let rows = selected.mapi((i, row) => {
    (
      {
        id: (i + 1).to_int64(),
        values: row
        .filter(b => !b.hidden)
        .mapi((j, b) => {
          apply_affinity(b.value, affinity_name(columns[j].declared))
        }),
      } : StoredRow)
  })
  {
    name,
    sql: ctas_sql(name, columns),
    columns,
    unique_keys: [],
    checks: [],
    foreign_keys: [],
    without_rowid: false,
    strict: None,
    autoincrement: false,
    sequence: 0L,
    sequence_present: None,
    rows: row_pages(rows),
  }
}
