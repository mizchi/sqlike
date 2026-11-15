// Generated from src/binary-wire.json by generate-binary-codecs.ts.
// Contract SHA256: f3e811d415bf6e48620b30d666547b023504647406200f3b8e0f9abbe367dd96
// Numeric variant tags and ordered fields are the versioned wire contract.

///|
impl Binary for Ordering with fn write(value, w) {
  Binary::write(value.expression, w)
  Binary::write(value.descending, w)
}

///|
impl Binary for Ordering with fn read(r) {
  r.enter()
  defer r.leave()
  let expression : Expr = Binary::read(r)
  let descending : Bool = Binary::read(r)
  let value : Ordering = { expression, descending, }

  value
}

///|
impl Binary for Projection with fn write(value, w) {
  Binary::write(value.expression, w)
  Binary::write(value.explicit_label, w)
  Binary::write(value.label, w)
}

///|
impl Binary for Projection with fn read(r) {
  r.enter()
  defer r.leave()
  let expression : Expr = Binary::read(r)
  let explicit_label : Bool = Binary::read(r)
  let label : String = Binary::read(r)
  let value : Projection = { expression, explicit_label, label, }

  value
}

///|
impl Binary for Source with fn write(value, w) {
  if value.right == Some(true) ||
    value.natural == Some(true) ||
    value.using_columns.unwrap_or([]).length() > 0 {
    w.require_feature(8U)
  }
  Binary::write(value.name, w)
  Binary::write(value.qualifier, w)
  Binary::write(value.left, w)
  Binary::write(value.right, w)
  Binary::write(value.using_columns, w)
  Binary::write(value.natural, w)
  Binary::write(value.on, w)
}

///|
impl Binary for Source with fn read(r) {
  r.enter()
  defer r.leave()
  let name : String = Binary::read(r)
  let qualifier : String = Binary::read(r)
  let left : Bool = Binary::read(r)
  let right : Bool? = Binary::read(r)
  let using_columns : Array[String]? = Binary::read(r)
  let natural : Bool? = Binary::read(r)
  let on : Expr = Binary::read(r)
  let value : Source = {
    name,
    qualifier,
    left,
    right,
    using_columns,
    natural,
    on,
  }
  if value.right == Some(true) ||
    value.natural == Some(true) ||
    value.using_columns.unwrap_or([]).length() > 0 {
    r.require_feature(8U)
  }
  value
}

///|
impl Binary for Selection with fn write(value, w) {
  Binary::write(value.ctes, w)
  Binary::write(value.projections, w)
  Binary::write(value.sources, w)
  Binary::write(value.predicate, w)
  Binary::write(value.groups, w)
  Binary::write(value.having, w)
  Binary::write(value.orders, w)
  Binary::write(value.limit, w)
  Binary::write(value.offset, w)
  Binary::write(value.distinct, w)
  Binary::write(value.compound, w)
  Binary::write(value.recursive, w)
  Binary::write(value.cte_names, w)
}

///|
impl Binary for Selection with fn read(r) {
  r.enter()
  defer r.leave()
  let ctes : Array[(String, Selection)] = Binary::read(r)
  let projections : Array[Projection] = Binary::read(r)
  let sources : Array[Source] = Binary::read(r)
  let predicate : Expr = Binary::read(r)
  let groups : Array[Expr] = Binary::read(r)
  let having : Expr = Binary::read(r)
  let orders : Array[Ordering] = Binary::read(r)
  let limit : Expr = Binary::read(r)
  let offset : Expr = Binary::read(r)
  let distinct : Bool = Binary::read(r)
  let compound : Array[(String, Selection)]? = Binary::read(r)
  let recursive : Bool? = Binary::read(r)
  let cte_names : Array[(String, Array[String])]? = Binary::read(r)
  let value : Selection = {
    ctes,
    projections,
    sources,
    predicate,
    groups,
    having,
    orders,
    limit,
    offset,
    distinct,
    compound,
    recursive,
    cte_names,
  }

  value
}

///|
impl Binary for ForeignKey with fn write(value, w) {
  w.require_feature(1U)
  Binary::write(value.column, w)
  Binary::write(value.parent, w)
  Binary::write(value.target, w)
  Binary::write(value.cascade, w)
  Binary::write(value.columns, w)
  Binary::write(value.targets, w)
  Binary::write(value.delete_action, w)
  Binary::write(value.update_action, w)
  Binary::write(value.initially_deferred, w)
}

///|
impl Binary for ForeignKey with fn read(r) {
  r.enter()
  defer r.leave()
  let column : Int32 = Binary::read(r)
  let parent : String = Binary::read(r)
  let target : String = Binary::read(r)
  let cascade : Bool = Binary::read(r)
  let columns : Array[Int32]? = Binary::read(r)
  let targets : Array[String]? = Binary::read(r)
  let delete_action : String? = Binary::read(r)
  let update_action : String? = Binary::read(r)
  let initially_deferred : Bool? = Binary::read(r)
  let value : ForeignKey = {
    column,
    parent,
    target,
    cascade,
    columns,
    targets,
    delete_action,
    update_action,
    initially_deferred,
  }
  r.require_feature(1U)
  value
}

///|
impl Binary for ColumnDef with fn write(value, w) {
  Binary::write(value.name, w)
  Binary::write(value.declared, w)
  Binary::write(value.not_null, w)
  Binary::write(value.primary, w)
  Binary::write(value.primary_desc, w)
  Binary::write(value.default_value, w)
  Binary::write(value.default_source, w)
  Binary::write(value.collation, w)
}

///|
impl Binary for ColumnDef with fn read(r) {
  r.enter()
  defer r.leave()
  let name : String = Binary::read(r)
  let declared : String = Binary::read(r)
  let not_null : Bool = Binary::read(r)
  let primary : Int32 = Binary::read(r)
  let primary_desc : Bool? = Binary::read(r)
  let default_value : Expr = Binary::read(r)
  let default_source : String? = Binary::read(r)
  let collation : String = Binary::read(r)
  let value : ColumnDef = {
    name,
    declared,
    not_null,
    primary,
    primary_desc,
    default_value,
    default_source,
    collation,
  }

  value
}

///|
impl Binary for Table with fn write(value, w) {
  if value.strict == Some(true) {
    w.require_feature(4U)
  }
  Binary::write(value.name, w)
  Binary::write(value.sql, w)
  Binary::write(value.columns, w)
  Binary::write(value.unique_keys, w)
  Binary::write(value.checks, w)
  Binary::write(value.foreign_keys, w)
  Binary::write(value.without_rowid, w)
  Binary::write(value.strict, w)
  Binary::write(value.autoincrement, w)
}

///|
impl Binary for Table with fn read(r) {
  r.enter()
  defer r.leave()
  let name : String = Binary::read(r)
  let sql : String = Binary::read(r)
  let columns : Array[ColumnDef] = Binary::read(r)
  let unique_keys : Array[Array[Int32]] = Binary::read(r)
  let checks : Array[Expr] = Binary::read(r)
  let foreign_keys : Array[ForeignKey] = Binary::read(r)
  let without_rowid : Bool = Binary::read(r)
  let strict : Bool? = Binary::read(r)
  let autoincrement : Bool = Binary::read(r)
  let value : Table = {
    name,
    sql,
    columns,
    unique_keys,
    checks,
    foreign_keys,
    without_rowid,
    strict,
    autoincrement,
    sequence: 0L,
    sequence_present: None,
    rows: row_pages([]),
  }
  if value.strict == Some(true) {
    r.require_feature(4U)
  }
  value
}

///|
impl Binary for SchemaObject with fn write(value, w) {
  Binary::write(value.kind, w)
  Binary::write(value.name, w)
  Binary::write(value.table, w)
  Binary::write(value.sql, w)
  Binary::write(value.unique, w)
  Binary::write(value.columns, w)
  Binary::write(value.query, w)
  Binary::write(value.selection, w)
  Binary::write(value.index_terms, w)
  Binary::write(value.index_predicate, w)
  Binary::write(value.trigger, w)
}

///|
impl Binary for SchemaObject with fn read(r) {
  r.enter()
  defer r.leave()
  let kind : String = Binary::read(r)
  let name : String = Binary::read(r)
  let table : String = Binary::read(r)
  let sql : String = Binary::read(r)
  let unique : Bool = Binary::read(r)
  let columns : Array[String] = Binary::read(r)
  let query : String = Binary::read(r)
  let selection : Selection? = Binary::read(r)
  let index_terms : Array[Ordering]? = Binary::read(r)
  let index_predicate : Expr? = Binary::read(r)
  let trigger : TriggerDefinition? = Binary::read(r)
  let value : SchemaObject = {
    kind,
    name,
    table,
    sql,
    unique,
    columns,
    query,
    selection,
    index_terms,
    index_predicate,
    trigger,
  }

  value
}

///|
impl Binary for Store with fn write(value, w) {
  Binary::write(value.encoding, w)
  Binary::write(value.tables, w)
  Binary::write(value.objects, w)
  Binary::write(value.cookie, w)
  Binary::write(value.foreign_keys, w)
}

///|
impl Binary for Store with fn read(r) {
  r.enter()
  defer r.leave()
  let encoding : Int32? = Binary::read(r)
  let tables : Array[Table] = Binary::read(r)
  let objects : Array[SchemaObject] = Binary::read(r)
  let cookie : Int32 = Binary::read(r)
  let foreign_keys : Bool = Binary::read(r)
  let value : Store = {
    encoding,
    tables,
    objects,
    cookie,
    foreign_keys,
    changes: 0,
    last_rowid: 0L,
    deferred: false,
    indexes: Map([]),
    primary_indexes: Map([]),
    declaration_sources: Map([]),
    dirty: dirty_state(),
    transactions: transaction_runtime(),
    triggers: trigger_runtime(),
  }

  value
}

///|
impl Binary for Insertion with fn write(value, w) {
  Binary::write(value.table, w)
  Binary::write(value.columns, w)
  Binary::write(value.values, w)
  Binary::write(value.conflict, w)
  Binary::write(value.target, w)
  Binary::write(value.updates, w)
  Binary::write(value.predicate, w)
  Binary::write(value.returning, w)
  Binary::write(value.conflict_override, w)
  Binary::write(value.target_predicate, w)
  Binary::write(value.selection, w)
}

///|
impl Binary for Insertion with fn read(r) {
  r.enter()
  defer r.leave()
  let table : String = Binary::read(r)
  let columns : Array[String] = Binary::read(r)
  let values : Array[Array[Expr]] = Binary::read(r)
  let conflict : String = Binary::read(r)
  let target : Array[String] = Binary::read(r)
  let updates : Array[(String, Expr)] = Binary::read(r)
  let predicate : Expr = Binary::read(r)
  let returning : Array[Projection] = Binary::read(r)
  let conflict_override : String? = Binary::read(r)
  let target_predicate : Expr? = Binary::read(r)
  let selection : Selection? = Binary::read(r)
  let value : Insertion = {
    table,
    columns,
    values,
    conflict,
    target,
    updates,
    predicate,
    returning,
    conflict_override,
    target_predicate,
    selection,
  }

  value
}

///|
impl Binary for TriggerDefinition with fn write(value, w) {
  w.require_feature(2U)
  Binary::write(value.timing, w)
  Binary::write(value.event, w)
  Binary::write(value.columns, w)
  Binary::write(value.condition, w)
  Binary::write(value.body, w)
}

///|
impl Binary for TriggerDefinition with fn read(r) {
  r.enter()
  defer r.leave()
  let timing : String = Binary::read(r)
  let event : String = Binary::read(r)
  let columns : Array[String] = Binary::read(r)
  let condition : Expr = Binary::read(r)
  let body : Array[DataStatement] = Binary::read(r)
  let value : TriggerDefinition = { timing, event, columns, condition, body, }
  r.require_feature(2U)
  value
}

///|
impl Binary for WindowFrame with fn write(value, w) {
  Binary::write(value.kind, w)
  Binary::write(value.start, w)
  Binary::write(value.end, w)
}

///|
impl Binary for WindowFrame with fn read(r) {
  r.enter()
  defer r.leave()
  let kind : String = Binary::read(r)
  let start : WindowBound = Binary::read(r)
  let end : WindowBound = Binary::read(r)
  let value : WindowFrame = { kind, start, end, }

  value
}

///|
impl Binary for CompiledQuery with fn write(value, w) {
  Binary::write(value.name, w)
  Binary::write(value.parameters, w)
  Binary::write(value.names, w)
  Binary::write(value.statement, w)
}

///|
impl Binary for CompiledQuery with fn read(r) {
  r.enter()
  defer r.leave()
  let name : String = Binary::read(r)
  let parameters : Int32 = Binary::read(r)
  let names : Array[String] = Binary::read(r)
  let statement : DataStatement = Binary::read(r)
  let value : CompiledQuery = { name, parameters, names, statement, }

  value
}

///|
impl Binary for StoredRow with fn write(value, w) {
  Binary::write(value.id, w)
  Binary::write(value.values, w)
}

///|
impl Binary for StoredRow with fn read(r) {
  r.enter()
  defer r.leave()
  let id : Int64 = Binary::read(r)
  let values : Array[Value] = Binary::read(r)
  let value : StoredRow = { id, values, }

  value
}

///|
impl Binary for StorageTree with fn write(value, w) {
  Binary::write(value.name, w)
  Binary::write(value.table, w)
  Binary::write(value.root, w)
  Binary::write(value.kind, w)
  Binary::write(value.fields, w)
  Binary::write(value.predicate, w)
}

///|
impl Binary for StorageTree with fn read(r) {
  r.enter()
  defer r.leave()
  let name : String = Binary::read(r)
  let table : String = Binary::read(r)
  let root : Int32 = Binary::read(r)
  let kind : String = Binary::read(r)
  let fields : Array[StorageField] = Binary::read(r)
  let predicate : Expr? = Binary::read(r)
  let value : StorageTree = { name, table, root, kind, fields, predicate, }

  value
}

///|
impl Binary for StorageField with fn write(value, w) {
  Binary::write(value.column, w)
  Binary::write(value.collation, w)
  Binary::write(value.descending, w)
  Binary::write(value.expression, w)
}

///|
impl Binary for StorageField with fn read(r) {
  r.enter()
  defer r.leave()
  let column : Int32 = Binary::read(r)
  let collation : String = Binary::read(r)
  let descending : Bool = Binary::read(r)
  let expression : Expr? = Binary::read(r)
  let value : StorageField = { column, collation, descending, expression, }

  value
}

///|
impl Binary for Expr with fn write(value, w) {
  match value {
    Literal(v0) => {
      w.uint(0U)

      Binary::write(v0, w)
    }
    TruthLiteral(v0) => {
      w.uint(1U)

      Binary::write(v0, w)
    }
    CurrentTime(v0) => {
      w.uint(2U)
      w.require_feature(32U)
      Binary::write(v0, w)
    }
    Parameter(v0) => {
      w.uint(3U)

      Binary::write(v0, w)
    }
    Column(v0, v1) => {
      w.uint(4U)

      Binary::write(v0, w)
      Binary::write(v1, w)
    }
    Star(v0) => {
      w.uint(5U)

      Binary::write(v0, w)
    }
    Unary(v0, v1) => {
      w.uint(6U)

      Binary::write(v0, w)
      Binary::write(v1, w)
    }
    Binary(v0, v1, v2) => {
      w.uint(7U)

      Binary::write(v0, w)
      Binary::write(v1, w)
      Binary::write(v2, w)
    }
    Call(v0, v1) => {
      w.uint(8U)
      w.require_feature(function_features(v0))
      Binary::write(v0, w)
      Binary::write(v1, w)
    }
    Collate(v0, v1) => {
      w.uint(9U)

      Binary::write(v0, w)
      Binary::write(v1, w)
    }
    Cast(v0, v1) => {
      w.uint(10U)

      Binary::write(v0, w)
      Binary::write(v1, w)
    }
    RowNumber(v0) => {
      w.uint(11U)
      w.require_feature(64U)
      Binary::write(v0, w)
    }
    Window(v0, v1, v2, v3, v4) => {
      w.uint(12U)
      w.require_feature(64U)
      Binary::write(v0, w)
      Binary::write(v1, w)
      Binary::write(v2, w)
      Binary::write(v3, w)
      Binary::write(v4, w)
    }
    Between(v0, v1, v2) => {
      w.uint(13U)

      Binary::write(v0, w)
      Binary::write(v1, w)
      Binary::write(v2, w)
    }
    Case(v0, v1, v2) => {
      w.uint(14U)

      Binary::write(v0, w)
      Binary::write(v1, w)
      Binary::write(v2, w)
    }
    InSelect(v0, v1) => {
      w.uint(15U)

      Binary::write(v0, w)
      Binary::write(v1, w)
    }
    ScalarSelect(v0) => {
      w.uint(16U)

      Binary::write(v0, w)
    }
    Exists(v0) => {
      w.uint(17U)

      Binary::write(v0, w)
    }
  }
}

///|
impl Binary for Expr with fn read(r) {
  r.enter()
  defer r.leave()
  match r.uint() {
    0U => {
      let v0 : Value = Binary::read(r)

      Literal(v0)
    }
    1U => {
      let v0 : Bool = Binary::read(r)

      TruthLiteral(v0)
    }
    2U => {
      let v0 : String = Binary::read(r)
      r.require_feature(32U)
      CurrentTime(v0)
    }
    3U => {
      let v0 : Int32 = Binary::read(r)

      Parameter(v0)
    }
    4U => {
      let v0 : String = Binary::read(r)
      let v1 : String = Binary::read(r)

      Column(v0, v1)
    }
    5U => {
      let v0 : String = Binary::read(r)

      Star(v0)
    }
    6U => {
      let v0 : String = Binary::read(r)
      let v1 : Expr = Binary::read(r)

      Unary(v0, v1)
    }
    7U => {
      let v0 : String = Binary::read(r)
      let v1 : Expr = Binary::read(r)
      let v2 : Expr = Binary::read(r)

      Binary(v0, v1, v2)
    }
    8U => {
      let v0 : String = Binary::read(r)
      let v1 : Array[Expr] = Binary::read(r)
      r.require_feature(function_features(v0))
      Call(v0, v1)
    }
    9U => {
      let v0 : Expr = Binary::read(r)
      let v1 : String = Binary::read(r)

      Collate(v0, v1)
    }
    10U => {
      let v0 : Expr = Binary::read(r)
      let v1 : String = Binary::read(r)

      Cast(v0, v1)
    }
    11U => {
      let v0 : Array[Ordering] = Binary::read(r)
      r.require_feature(64U)
      RowNumber(v0)
    }
    12U => {
      let v0 : String = Binary::read(r)
      let v1 : Array[Expr] = Binary::read(r)
      let v2 : Array[Expr] = Binary::read(r)
      let v3 : Array[Ordering] = Binary::read(r)
      let v4 : WindowFrame = Binary::read(r)
      r.require_feature(64U)
      Window(v0, v1, v2, v3, v4)
    }
    13U => {
      let v0 : Expr = Binary::read(r)
      let v1 : Expr = Binary::read(r)
      let v2 : Expr = Binary::read(r)

      Between(v0, v1, v2)
    }
    14U => {
      let v0 : Expr? = Binary::read(r)
      let v1 : Array[(Expr, Expr)] = Binary::read(r)
      let v2 : Expr = Binary::read(r)

      Case(v0, v1, v2)
    }
    15U => {
      let v0 : Expr = Binary::read(r)
      let v1 : Selection = Binary::read(r)

      InSelect(v0, v1)
    }
    16U => {
      let v0 : Selection = Binary::read(r)

      ScalarSelect(v0)
    }
    17U => {
      let v0 : Selection = Binary::read(r)

      Exists(v0)
    }
    _ => fail("unknown binary Expr tag")
  }
}

///|
impl Binary for DataStatement with fn write(value, w) {
  match value {
    PreparedTransaction(v0, v1) => {
      w.uint(0U)

      Binary::write(v0, w)
      Binary::write(v1, w)
    }
    PreparedSelect(v0) => {
      w.uint(1U)

      Binary::write(v0, w)
    }
    PreparedPragma(v0, v1) => {
      w.uint(2U)

      Binary::write(v0, w)
      Binary::write(v1, w)
    }
    PreparedInsert(v0) => {
      w.uint(3U)

      Binary::write(v0, w)
    }
    PreparedUpdate(v0, v1, v2, v3) => {
      w.uint(4U)

      Binary::write(v0, w)
      Binary::write(v1, w)
      Binary::write(v2, w)
      Binary::write(v3, w)
    }
    PreparedDelete(v0, v1, v2) => {
      w.uint(5U)

      Binary::write(v0, w)
      Binary::write(v1, w)
      Binary::write(v2, w)
    }
  }
}

///|
impl Binary for DataStatement with fn read(r) {
  r.enter()
  defer r.leave()
  match r.uint() {
    0U => {
      let v0 : String = Binary::read(r)
      let v1 : String = Binary::read(r)

      PreparedTransaction(v0, v1)
    }
    1U => {
      let v0 : Selection = Binary::read(r)

      PreparedSelect(v0)
    }
    2U => {
      let v0 : String = Binary::read(r)
      let v1 : String = Binary::read(r)

      PreparedPragma(v0, v1)
    }
    3U => {
      let v0 : Insertion = Binary::read(r)

      PreparedInsert(v0)
    }
    4U => {
      let v0 : String = Binary::read(r)
      let v1 : Array[(String, Expr)] = Binary::read(r)
      let v2 : Expr = Binary::read(r)
      let v3 : Array[Projection] = Binary::read(r)

      PreparedUpdate(v0, v1, v2, v3)
    }
    5U => {
      let v0 : String = Binary::read(r)
      let v1 : Expr = Binary::read(r)
      let v2 : Array[Projection] = Binary::read(r)

      PreparedDelete(v0, v1, v2)
    }
    _ => fail("unknown binary DataStatement tag")
  }
}

///|
impl Binary for WindowBound with fn write(value, w) {
  match value {
    UnboundedPreceding => w.uint(0U)
    Preceding(v0) => {
      w.uint(1U)

      Binary::write(v0, w)
    }
    Current => w.uint(2U)
    Following(v0) => {
      w.uint(3U)

      Binary::write(v0, w)
    }
    UnboundedFollowing => w.uint(4U)
  }
}

///|
impl Binary for WindowBound with fn read(r) {
  r.enter()
  defer r.leave()
  match r.uint() {
    0U => UnboundedPreceding
    1U => {
      let v0 : Expr = Binary::read(r)

      Preceding(v0)
    }
    2U => Current
    3U => {
      let v0 : Expr = Binary::read(r)

      Following(v0)
    }
    4U => UnboundedFollowing
    _ => fail("unknown binary WindowBound tag")
  }
}

///|
impl Binary for RowEdit with fn write(value, w) {
  match value {
    AppendRow(v0, v1) => {
      w.uint(0U)

      Binary::write(v0, w)
      Binary::write(v1, w)
    }
    ReplaceRow(v0, v1, v2) => {
      w.uint(1U)

      Binary::write(v0, w)
      Binary::write(v1, w)
      Binary::write(v2, w)
    }
    DeleteRow(v0, v1) => {
      w.uint(2U)

      Binary::write(v0, w)
      Binary::write(v1, w)
    }
    PatchRow(v0, v1, v2, v3) => {
      w.uint(3U)

      Binary::write(v0, w)
      Binary::write(v1, w)
      Binary::write(v2, w)
      Binary::write(v3, w)
    }
  }
}

///|
impl Binary for RowEdit with fn read(r) {
  r.enter()
  defer r.leave()
  match r.uint() {
    0U => {
      let v0 : String = Binary::read(r)
      let v1 : StoredRow = Binary::read(r)

      AppendRow(v0, v1)
    }
    1U => {
      let v0 : String = Binary::read(r)
      let v1 : Int64 = Binary::read(r)
      let v2 : StoredRow = Binary::read(r)

      ReplaceRow(v0, v1, v2)
    }
    2U => {
      let v0 : String = Binary::read(r)
      let v1 : Int64 = Binary::read(r)

      DeleteRow(v0, v1)
    }
    3U => {
      let v0 : String = Binary::read(r)
      let v1 : Int64 = Binary::read(r)
      let v2 : Int64 = Binary::read(r)
      let v3 : Array[(Int32, Value)] = Binary::read(r)

      PatchRow(v0, v1, v2, v3)
    }
    _ => fail("unknown binary RowEdit tag")
  }
}
