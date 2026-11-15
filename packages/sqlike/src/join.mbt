///|
fn unqualified_binding(b : Binding) -> Binding? {
  if !FEATURE_OUTER_JOIN {
    return Some(b)
  }
  match b.join_column {
    Some(SuppressedJoinColumn) => None
    Some(MergedJoinColumn(value, affinity, collation)) =>
      Some({ ..b, value, affinity, collation, })
    None => Some(b)
  }
}

///|
fn merged_comparison_value(
  e : Expr,
  value : Value,
  affinity : String,
  ctx : Evaluation,
) -> Value raise SqlError {
  if !FEATURE_OUTER_JOIN {
    return value
  }
  if e is Column("", name) &&
    find_context(ctx, "", name) is Some(b) &&
    b.join_column is Some(MergedJoinColumn(_, _, _)) {
    apply_affinity(value, affinity)
  } else {
    value
  }
}

///|
fn using_pairs(
  source : Source,
  left : Environment,
  right : Environment,
) -> Array[(Int32, Int32)] raise SqlError {
  if source.using_columns is None && source.natural != Some(true) {
    return []
  }
  guard FEATURE_OUTER_JOIN else {
    fail("feature disabled: rightFullJoin (USING/NATURAL)")
  }
  let names = source.using_columns.unwrap_or_else(() => {
    left
    .filter(b => {
      !b.hidden &&
      !(b.join_column is Some(SuppressedJoinColumn)) &&
      right.any(r => !r.hidden && identifier(r.name) == identifier(b.name))
    })
    .map(b => b.name)
  })
  let pairs : Array[(Int32, Int32)] = []
  for name in names {
    ignore(find_binding(left, "", name))
    let li = left
      .mapi((i, b) => (i, b))
      .filter(p => {
        !p.1.hidden &&
        !(p.1.join_column is Some(SuppressedJoinColumn)) &&
        identifier(p.1.name) == identifier(name)
      })
    let ri = right
      .mapi((i, b) => (i, b))
      .filter(p => !p.1.hidden && identifier(p.1.name) == identifier(name))
    guard li.length() == 1 &&
      ri.length() == 1 &&
      !pairs.any(p => p.0 == li[0].0) else {
      fail("cannot join using column: " + name)
    }
    pairs.push((li[0].0, ri[0].0))
  }
  pairs
}

///|
fn using_matches(
  left : Environment,
  right : Environment,
  pairs : Array[(Int32, Int32)],
  ctx : Evaluation,
) -> Bool raise SqlError {
  if !FEATURE_OUTER_JOIN {
    return true
  }
  for (li, ri) in pairs {
    let a = unqualified_binding(left[li]).unwrap()
    let b = right[ri]
    let row = [
      { ..a, name: "__l", qualifier: "", join_column: None, },
      { ..b, name: "__r", qualifier: "", join_column: None, },
    ]
    if truth(
        compare_expression(
          "=",
          Column("", "__l"),
          a.value,
          Column("", "__r"),
          b.value,
          { ..ctx, row, },
        ),
      ) !=
      1 {
      return false
    }
  }
  true
}

///|
fn using_row(
  source : Source,
  left : Environment,
  right : Environment,
  pairs : Array[(Int32, Int32)],
) -> Environment {
  let result = left + right
  if !FEATURE_OUTER_JOIN {
    return result
  }
  for (li, ri) in pairs {
    let a = unqualified_binding(left[li]).unwrap()
    let b = right[ri]
    let value = if source.right == Some(true) && !source.left {
      b.value
    } else if source.right == Some(true) && a.value is Null {
      b.value
    } else {
      a.value
    }
    let metadata = if source.right == Some(true) && !source.left {
      b
    } else {
      a
    }
    result[li] = {
      ..left[li],
      join_column: Some(
        MergedJoinColumn(value, metadata.affinity, metadata.collation),
      ),
    }
    result[left.length() + ri] = {
      ..b,
      join_column: Some(SuppressedJoinColumn),
    }
  }
  result
}
