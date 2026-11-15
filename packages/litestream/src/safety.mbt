///|
/// Platform-independent, fail-closed order for application guard checks.
pub fn assess_apply(
  head : Int32,
  base : Int32,
  kind : Int32,
  same_database : Bool,
  same_schema : Bool,
  matching_assertions : Bool,
  matching_effects : Bool,
) -> String {
  if !same_database {
    "database"
  } else if !same_schema {
    "schema"
  } else if base > head || base < 0 {
    "future"
  } else if kind == 1 && base != head {
    "stale"
  } else if !matching_assertions {
    "cardinality"
  } else if !matching_effects {
    "effects"
  } else {
    "apply"
  }
}
