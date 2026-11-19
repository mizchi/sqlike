///|
/// Access paths retain schema facts and parameter positions, never live indexes.
priv enum BoundAccess {
  BoundScan
  BoundRowid(BoundValue, Bool)
  BoundPrimary(Array[BoundKeyPart])
}

///|
priv struct BoundKeyPart {
  value : BoundValue
  affinity : String
  collation : String
}

///|
fn bind_key_terms(
  e : Expr,
  layout : Environment,
  terms : Map[Int32, BoundValue],
) -> Unit raise SqlError {
  match e {
    Binary("and", left, right) => {
      bind_key_terms(left, layout, terms)
      bind_key_terms(right, layout, terms)
    }
    Binary(op, left, right) =>
      if op == "=" || op == "==" {
        for (column, value) in [(left, right), (right, left)] {
          if column is Column(q, name) && bind_key_value(value) is Some(value) {
            terms[bound_column(layout, q, name)] = value
          }
        }
      }
    _ => ()
  }
}

///|
fn bind_access(
  table : Table,
  predicate : Expr,
  layout : Environment,
) -> BoundAccess raise SqlError {
  let terms : Map[Int32, BoundValue] = Map([])
  bind_key_terms(predicate, layout, terms)
  let ipk = integer_primary(table)
  let rowid = match terms.get(-1) {
    Some(value) => Some(value)
    None => if ipk >= 0 { terms.get(ipk) } else { None }
  }
  if rowid is Some(value) {
    // Preserve the existing non-indexed shortcut only for a whole rowid equality
    // with an INTEGER value; other storage classes retain the scan fallback.
    let linear = match predicate {
      Binary(op, _, _) => op == "=" || op == "=="
      _ => false
    }
    return BoundRowid(value, linear)
  }
  let keys = primary_key(table)
  guard !keys.is_empty() && keys.all(i => terms.contains(i)) else {
    return BoundScan
  }
  BoundPrimary(
    keys.map(i => {
      value: terms[i],
      affinity: column_affinity(table, table.columns[i]),
      collation: table.columns[i].collation,
    }),
  )
}

///|
fn bound_rowid(value : Value) -> Int64? {
  match apply_affinity(value, "integer") {
    Integer(id) => Some(id)
    Real(n) =>
      if n >= -9223372036854775808.0 &&
        n < 9223372036854775808.0 &&
        n.to_int64().to_double() == n {
        Some(n.to_int64())
      } else {
        None
      }
    _ => None
  }
}

///|
fn bound_candidates(
  access : BoundAccess,
  store : Store,
  table : Table,
  params : Array[Value],
) -> Array[StoredRow] raise SqlError {
  match access {
    BoundScan => table.rows.copy()
    BoundRowid(value, linear) => {
      let value = read_key_value(value, params)
      if !FEATURE_PRIMARY_INDEX {
        return match value {
          Integer(id) =>
            if linear {
              candidate_rows(store, table, Some(id))
            } else {
              table.rows.copy()
            }
          _ => table.rows.copy()
        }
      }
      match bound_rowid(value) {
        Some(id) =>
          primary_row(primary_index(store, table), table, id)
          .map(row => [row])
          .unwrap_or([])
        None => []
      }
    }
    BoundPrimary(fields) => {
      if !FEATURE_PRIMARY_INDEX {
        return table.rows.copy()
      }
      let parts : Array[Json] = []
      for field in fields {
        guard primary_part_key(
            read_key_value(field.value, params),
            field.affinity,
            field.collation,
          )
          is Some(part) else {
          return []
        }
        parts.push(part)
      }
      primary_key_row(
        primary_index(store, table),
        table,
        Json::array(parts).stringify(),
      )
      .map(row => [row])
      .unwrap_or([])
    }
  }
}
