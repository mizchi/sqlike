///|
/// Shared typed-IR facts for build-time inference and load-time validation.
/// These helpers must not depend on the SQL or SQL JSON parsers.
fn runtime_selection_parts(select : Selection) -> Array[String] {
  let parts : Array[String] = []
  if !select.ctes.is_empty() {
    parts.push("cte")
    if select.ctes.any(p => recursive_cte(select, p.0, p.1)) {
      parts.push("recursiveCte")
    }
  }
  if select.compound is Some(_) {
    parts.push("compound")
  }
  if select.sources.length() > 1 ||
    select.sources.any(s => {
      s.left ||
      s.right == Some(true) ||
      s.natural == Some(true) ||
      !s.using_columns.unwrap_or([]).is_empty() ||
      !(s.on is Literal(Integer(1L)))
    }) {
    parts.push("join")
  }
  parts
}

///|
fn runtime_json_may_have_subtype(expr : Expr) -> Bool {
  match expr {
    Call("coalesce", args)
    | Call("ifnull", args)
    | Call("iif", args)
    | Call("if", args)
    | Call("nullif", args)
    | Call("min", args)
    | Call("max", args) => args.any(runtime_json_may_have_subtype)
    Call(name, _) =>
      [
        "json", "json_quote", "json_array", "json_object", "json_extract", "json_set",
        "json_insert", "json_replace", "json_remove", "json_patch", "->", "json_group_array",
        "json_group_object",
      ].contains(name)
    Collate(e, _) | Unary("+", e) | Cast(e, "text") =>
      runtime_json_may_have_subtype(e)
    Case(_, arms, other) =>
      arms.any(p => runtime_json_may_have_subtype(p.1)) ||
      runtime_json_may_have_subtype(other)
    ScalarSelect(select) => runtime_json_selection_subtype(select)
    _ => false
  }
}

///|
fn runtime_json_selection_subtype(select : Selection) -> Bool {
  select.projections.any(p => runtime_json_may_have_subtype(p.expression)) ||
  select.compound.unwrap_or([]).any(p => runtime_json_selection_subtype(p.1))
}

///|
fn runtime_json_unsupported_subtype(expr : Expr) -> Bool {
  match expr {
    ScalarSelect(select) => runtime_json_selection_subtype(select)
    Collate(e, _) | Unary("+", e) | Cast(e, "text") =>
      runtime_json_unsupported_subtype(e)
    Call("min", args) | Call("max", args) =>
      args.any(runtime_json_may_have_subtype)
    Call("coalesce", args)
    | Call("ifnull", args)
    | Call("iif", args)
    | Call("if", args)
    | Call("nullif", args) => args.any(runtime_json_unsupported_subtype)
    Case(_, arms, other) =>
      arms.any(p => runtime_json_unsupported_subtype(p.1)) ||
      runtime_json_unsupported_subtype(other)
    _ => false
  }
}

///|
/// Only JSON VALUE positions propagate subtype. Labels and raw JSON inputs do not.
fn runtime_json_values(name : String, args : Array[Expr]) -> Array[Expr] {
  match name {
    "json_array" | "json_quote" => args
    "json_object" | "json_set" | "json_insert" | "json_replace" => {
      let values = []
      let start = if name == "json_object" { 1 } else { 2 }
      for i = start; i < args.length(); i = i + 2 {
        values.push(args[i])
      }
      values
    }
    "json_group_array" =>
      args.map(e => {
        let input = filter_input(e)
        match input {
          Call("$distinct", [inner]) => inner
          _ => input
        }
      })
    "json_group_object" => if args.length() == 2 { [args[1]] } else { [] }
    _ => []
  }
}

///|
fn runtime_json_value_subtype(name : String, args : Array[Expr]) -> Bool {
  runtime_json_values(name, args).any(runtime_json_may_have_subtype)
}

///|
fn validate_runtime_json_values(
  name : String,
  args : Array[Expr],
) -> Unit raise SqlError {
  if FEATURE_SQL_JSON {
    let values = runtime_json_values(name, args)
    guard !values.any(runtime_json_unsupported_subtype) else {
      fail(
        "unsupported JSON subtype propagation through scalar subquery or extrema",
      )
    }
    if values.any(runtime_json_may_have_subtype) {
      validate_runtime_query_part("jsonSubtype")
    }
  }
}
