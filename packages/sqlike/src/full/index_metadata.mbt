///|
priv struct MetadataIndex {
  name : String
  unique : Bool
  origin : String
  partial : Bool
  fields : Array[IndexField]
}

///|
fn implicit_index_metadata(
  table : Table,
) -> Array[MetadataIndex] raise SqlError {
  let primary = primary_key(table)
  let keys = table.unique_keys.copy()
  let ipk = integer_primary(table) >= 0
  if ipk && !primary.is_empty() {
    ignore(keys.pop()) // The parser appends the PRIMARY KEY constraint last.
  }
  let distinct : Array[Array[Int32]] = []
  for key in keys {
    if !distinct.any(k => k == key) {
      distinct.push(key)
    }
  }
  // Legacy tables retain constraints but not their interleaved PK/UNIQUE order
  // or table-level PK directions. Refuse metadata that cannot be recovered.
  guard ipk ||
    primary.is_empty() ||
    (distinct.length() <= 1 && !identifier(table.sql).contains("desc")) else {
    fail(
      "unsupported implicit index metadata: rebuild with declaration metadata",
    )
  }
  distinct.mapi((i, key) => {
    name: "sqlite_autoindex_" + table.name + "_" + (i + 1).to_string(),
    unique: true,
    origin: if !ipk && key == primary {
      "pk"
    } else {
      "u"
    },
    partial: false,
    fields: key.map(column => {
      column,
      collation: table.columns[column].collation,
      descending: false,
    }),
  })
}

///|
fn explicit_index_metadata(
  table : Table,
  object : SchemaObject,
) -> MetadataIndex raise SqlError {
  {
    name: object.name,
    unique: object.unique,
    origin: "c",
    partial: object.index_predicate is Some(_),
    fields: index_keys(table, object).map(k => {
      column: k.column,
      collation: k.collation,
      descending: k.descending,
    }),
  }
}

///|
fn index_metadata_rows(
  table : Table,
  index : MetadataIndex,
  wide : Bool,
) -> Array[Environment] raise SqlError {
  let fields = index.fields.copy()
  let keys = fields.length()
  if wide {
    if table.without_rowid {
      guard !identifier(table.sql).contains("desc") else {
        fail("unsupported primary index metadata direction")
      }
      let columns = if index.origin == "pk" {
        table.columns.mapi((i, _) => i)
      } else {
        primary_key(table)
      }
      for column in columns {
        let collation = table.columns[column].collation
        if !fields.any(f => f.column == column && f.collation == collation) {
          fields.push({ column, collation, descending: false, })
        }
      }
    } else {
      fields.push({ column: -1, collation: "binary", descending: false, })
    }
  }
  fields.mapi((i, f) => {
    let row = [
      binding("seqno", Integer(i.to_int64())),
      binding("cid", Integer(f.column.to_int64())),
      binding(
        "name",
        if f.column >= 0 {
          Text(table.columns[f.column].name)
        } else {
          Null
        },
      ),
    ]
    if wide {
      row.push(binding("desc", boolean(f.descending)))
      row.push(
        binding(
          "coll",
          Text(
            match f.collation {
              "nocase" => "NOCASE"
              "rtrim" => "RTRIM"
              _ => "BINARY"
            },
          ),
        ),
      )
      row.push(binding("key", boolean(i < keys)))
    }
    row
  })
}

///|
fn index_metadata(
  store : Store,
  pragma : String,
  name : String,
) -> Array[Environment] raise SqlError {
  let lookup = identifier(name)
  if pragma == "index_list" {
    let found = store.tables.filter(t => identifier(t.name) == lookup)
    if found.is_empty() {
      return []
    }
    let table = found[0]
    let indexes : Array[MetadataIndex] = []
    for i = store.objects.length() - 1; i >= 0; i = i - 1 {
      let object = store.objects[i]
      if object.kind == "index" && identifier(object.table) == lookup {
        indexes.push(explicit_index_metadata(table, object))
      }
    }
    let implicit = implicit_index_metadata(table)
    for i = implicit.length() - 1; i >= 0; i = i - 1 {
      indexes.push(implicit[i])
    }
    return indexes.mapi((i, index) => {
      [
        binding("seq", Integer(i.to_int64())),
        binding("name", Text(index.name)),
        binding("unique", boolean(index.unique)),
        binding("origin", Text(index.origin)),
        binding("partial", boolean(index.partial)),
      ]
    })
  }
  for object in store.objects {
    if object.kind == "index" && identifier(object.name) == lookup {
      let table = get_table(store, object.table)
      return index_metadata_rows(
        table,
        explicit_index_metadata(table, object),
        pragma == "index_xinfo",
      )
    }
  }
  for table in store.tables {
    if (table.without_rowid && identifier(table.name) == lookup) ||
      lookup.has_prefix("sqlite_autoindex_" + identifier(table.name) + "_") {
      for index in implicit_index_metadata(table) {
        if identifier(index.name) == lookup ||
          (
            table.without_rowid &&
            identifier(table.name) == lookup &&
            index.origin == "pk"
          ) {
          return index_metadata_rows(table, index, pragma == "index_xinfo")
        }
      }
    }
  }
  []
}
