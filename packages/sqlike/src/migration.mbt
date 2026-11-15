///|
priv struct Rename {
  store : Store
  table : String
  new_table : String
  column : String
  new_column : String
  mut referenced : Bool
}

///|
fn rename_table_name(r : Rename, name : String) -> String {
  if identifier(name) == identifier(r.table) {
    r.new_table
  } else {
    name
  }
}

///|
fn rename_column_name(r : Rename, table : String, name : String) -> String {
  if r.column != "" &&
    identifier(table) == identifier(r.table) &&
    identifier(name) == identifier(r.column) {
    r.referenced = true
    r.new_column
  } else {
    name
  }
}

///|
fn rename_expr(r : Rename, e : Expr, scope : Array[(String, String)]) -> Expr {
  match e {
    Column(q, n) => {
      let mut owner = ""
      if q != "" {
        for (qualifier, table) in scope {
          if identifier(qualifier) == identifier(q) {
            owner = table
            break
          }
        }
      } else {
        for (qualifier, table) in scope {
          if qualifier == "old" || qualifier == "new" {
            continue
          }
          if r.store.tables.any(t => {
              identifier(t.name) == identifier(table) &&
              t.columns.any(c => identifier(c.name) == identifier(n))
            }) {
            owner = table
            break
          }
        }
      }
      Column(
        if identifier(owner) == identifier(r.table) &&
          identifier(q) == identifier(r.table) {
          r.new_table
        } else {
          q
        },
        rename_column_name(r, owner, n),
      )
    }
    Star(q) =>
      Star(
        if identifier(q) == identifier(r.table) &&
          scope.any(s => {
            identifier(s.0) == identifier(q) &&
            identifier(s.1) == identifier(r.table)
          }) {
          r.new_table
        } else {
          q
        },
      )
    Unary(op, e) => Unary(op, rename_expr(r, e, scope))
    Binary(op, a, b) =>
      Binary(op, rename_expr(r, a, scope), rename_expr(r, b, scope))
    Cast(e, t) => Cast(rename_expr(r, e, scope), t)
    Collate(e, c) => Collate(rename_expr(r, e, scope), c)
    Call(name, args) => Call(name, args.map(e => rename_expr(r, e, scope)))
    Between(a, b, c) =>
      Between(
        rename_expr(r, a, scope),
        rename_expr(r, b, scope),
        rename_expr(r, c, scope),
      )
    Case(base, arms, other) =>
      Case(
        base.map(e => rename_expr(r, e, scope)),
        arms.map(p => (rename_expr(r, p.0, scope), rename_expr(r, p.1, scope))),
        rename_expr(r, other, scope),
      )
    ScalarSelect(s) => ScalarSelect(rename_select(r, s, scope))
    Exists(s) => Exists(rename_select(r, s, scope))
    InSelect(e, s) =>
      InSelect(rename_expr(r, e, scope), rename_select(r, s, scope))
    RowNumber(orders) =>
      RowNumber(
        orders.map(o => {
          ..o,
          expression: rename_expr(r, o.expression, scope),
        }),
      )
    Window(name, args, parts, orders, frame) =>
      Window(
        name,
        args.map(e => rename_expr(r, e, scope)),
        parts.map(e => rename_expr(r, e, scope)),
        orders.map(o => {
          ..o,
          expression: rename_expr(r, o.expression, scope),
        }),
        frame,
      )
    _ => e
  }
}

///|
fn rename_select(
  r : Rename,
  s : Selection,
  outer : Array[(String, String)],
) -> Selection {
  let scope = s.sources.map(source => (source.qualifier, source.name)) + outer
  {
    ..s,
    sources: s.sources.map(source => {
      ..source,
      name: rename_table_name(r, source.name),
      qualifier: if identifier(source.name) == identifier(r.table) &&
        identifier(source.qualifier) == identifier(r.table) {
        r.new_table
      } else {
        source.qualifier
      },
      on: rename_expr(r, source.on, scope),
    }),
    ctes: s.ctes.map(p => (p.0, rename_select(r, p.1, outer))),
    projections: s.projections.map(p => {
      let expression = rename_expr(r, p.expression, scope)
      {
        ..p,
        expression,
        label: if !p.explicit_label && expression is Column(_, n) {
          n
        } else {
          p.label
        },
      }
    }),
    predicate: rename_expr(r, s.predicate, scope),
    groups: s.groups.map(e => rename_expr(r, e, scope)),
    having: rename_expr(r, s.having, scope),
    orders: s.orders.map(o => {
      ..o,
      expression: rename_expr(r, o.expression, scope),
    }),
    compound: s.compound.map(arms => {
      arms.map(p => (p.0, rename_select(r, p.1, outer)))
    }),
  }
}

///|
fn rename_data(
  r : Rename,
  statement : DataStatement,
  outer : Array[(String, String)],
) -> DataStatement {
  match statement {
    PreparedSelect(s) => PreparedSelect(rename_select(r, s, outer))
    PreparedInsert(i) => {
      let scope = [(i.table, i.table), ("excluded", i.table)] + outer
      PreparedInsert({
        ..i,
        table: rename_table_name(r, i.table),
        columns: i.columns.map(n => rename_column_name(r, i.table, n)),
        values: i.values.map(row => row.map(e => rename_expr(r, e, outer))),
        selection: i.selection.map(s => rename_select(r, s, outer)),
        target: i.target.map(n => rename_column_name(r, i.table, n)),
        target_predicate: i.target_predicate.map(e => rename_expr(r, e, scope)),
        updates: i.updates.map(p => {
          (rename_column_name(r, i.table, p.0), rename_expr(r, p.1, scope))
        }),
        predicate: rename_expr(r, i.predicate, scope),
        returning: i.returning.map(p => {
          ..p,
          expression: rename_expr(r, p.expression, scope),
        }),
      })
    }
    PreparedUpdate(name, setters, predicate, returning) => {
      let scope = [(name, name)] + outer
      PreparedUpdate(
        rename_table_name(r, name),
        setters.map(p => {
          (rename_column_name(r, name, p.0), rename_expr(r, p.1, scope))
        }),
        rename_expr(r, predicate, scope),
        returning.map(p => {
          ..p,
          expression: rename_expr(r, p.expression, scope),
        }),
      )
    }
    PreparedDelete(name, predicate, returning) => {
      let scope = [(name, name)] + outer
      PreparedDelete(
        rename_table_name(r, name),
        rename_expr(r, predicate, scope),
        returning.map(p => {
          ..p,
          expression: rename_expr(r, p.expression, scope),
        }),
      )
    }
    _ => statement
  }
}

///|
fn rename_object(r : Rename, o : SchemaObject) -> SchemaObject {
  let scope = [(o.table, o.table), ("old", o.table), ("new", o.table)]
  let trigger = o.trigger.map(t => {
    ..t,
    columns: t.columns.map(n => rename_column_name(r, o.table, n)),
    condition: rename_expr(r, t.condition, scope),
    body: t.body.map(s => {
      rename_data(r, s, [("old", o.table), ("new", o.table)])
    }),
  })
  let next = {
    ..o,
    table: if o.kind == "view" {
      o.table
    } else {
      rename_table_name(r, o.table)
    },
    columns: o.columns.map(n => rename_column_name(r, o.table, n)),
    index_terms: o.index_terms.map(orders => {
      orders.map(order => {
        ..order,
        expression: rename_expr(r, order.expression, scope),
      })
    }),
    index_predicate: o.index_predicate.map(e => rename_expr(r, e, scope)),
    selection: o.selection.map(s => rename_select(r, s, [])),
    trigger,
  }
  next
}

///|
fn migrate_schema(
  store : Store,
  name : String,
  new_table : String,
  column : String,
  new_column : String,
  drop : Bool,
  quoted~ : Bool = false,
) -> Unit raise SqlError {
  let original = copy_store(store)
  let table = get_table(original, name)
  let index = if column == "" { -1 } else { column_index(table, column) }
  if column == "" {
    guard !store.tables.any(t => identifier(t.name) == identifier(new_table)) &&
      !store.objects.any(o => identifier(o.name) == identifier(new_table)) else {
      fail("table already exists")
    }
  } else if !drop {
    guard !table.columns.any(c => identifier(c.name) == identifier(new_column)) else {
      fail("duplicate column name")
    }
  }
  if drop {
    guard table.columns.length() > 1 &&
      table.columns[index].primary == 0 &&
      !table.unique_keys.any(key => key.contains(index)) else {
      fail("cannot drop PRIMARY KEY or UNIQUE column")
    }
  }
  let rename : Rename = {
    store: original,
    table: name,
    new_table,
    column,
    new_column,
    referenced: false,
  }
  let objects = original.objects.map(o => {
    let next = rename_object(rename, o)
    let sql = migration_sql(o.sql, rename, o.table, o.kind, drop, quoted)
    ignore(next)
    guard parse_statement(lex(sql)) is CreateObject(parsed, _) else {
      fail("invalid migrated schema object")
    }
    parsed
  })
  if drop {
    guard !rename.referenced else { fail("cannot drop referenced column") }
  }
  let tables : Array[Table] = []
  for t in original.tables {
    let scope = [(t.name, t.name)]
    let checks = t.checks.map(e => rename_expr(rename, e, scope))
    let foreign_keys = t.foreign_keys.map(fk => {
      let targets = fk.targets.map(names => {
        names.map(n => rename_column_name(rename, fk.parent, n))
      })
      let target = rename_column_name(rename, fk.parent, fk.target)
      if drop &&
        identifier(t.name) == identifier(name) &&
        foreign_columns(fk).contains(index) {
        rename.referenced = true
      }
      let columns = if drop && identifier(t.name) == identifier(name) {
        fk.columns.map(cols => cols.map(i => if i > index { i - 1 } else { i }))
      } else {
        fk.columns
      }
      {
        ..fk,
        parent: rename_table_name(rename, fk.parent),
        target,
        targets,
        columns,
        column: if drop &&
          identifier(t.name) == identifier(name) &&
          fk.column > index {
          fk.column - 1
        } else {
          fk.column
        },
      }
    })
    if drop {
      guard !rename.referenced else { fail("cannot drop referenced column") }
    }
    let own = identifier(t.name) == identifier(name)
    let columns = t.columns
      .mapi((i, c) => (i, c))
      .filter(p => !drop || !own || p.0 != index)
      .map(p => {
        ..p.1,
        name: if own && p.0 == index {
          new_column
        } else {
          p.1.name
        },
      })
    let next = {
      ..t,
      name: if own {
        new_table
      } else {
        t.name
      },
      columns,
      checks,
      foreign_keys,
      unique_keys: if drop && own {
        t.unique_keys.map(key => key.map(i => if i > index { i - 1 } else { i }))
      } else {
        t.unique_keys
      },
      rows: if drop && own {
        row_pages(
          t.rows.map(row => {
            ..row,
            values: row.values
            .mapi((i, v) => (i, v))
            .filter(p => p.0 != index)
            .map(p => p.1),
          }),
        )
      } else {
        t.rows
      },
    }
    tables.push({
      ..next,
      sql: migration_sql(t.sql, rename, t.name, "table", drop, quoted),
    })
  }
  store.tables.clear()
  for t in tables {
    store.tables.push(t)
  }
  store.objects.clear()
  for o in objects {
    store.objects.push(o)
  }
  schema_changed(store)
  validate_image(store)
  for o in store.objects {
    if o.kind == "view" && o.selection is Some(s) {
      ignore(selection_template(s, evaluation(store, [], [])))
    }
    if o.kind == "trigger" {
      prepare_trigger(store, get_table(store, o.table), o)
    }
  }
}
