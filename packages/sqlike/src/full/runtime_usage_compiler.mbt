///|
priv struct RuntimeUsageState {
  mut features : UInt32
  functions : Map[String, Bool]
  groups : Map[String, Bool]
  expressions : Map[String, Bool]
  statements : Map[String, Bool]
  parts : Map[String, Bool]
}

///|
fn collect_runtime_call(
  name : String,
  arity : Int32,
  state : RuntimeUsageState,
) -> Unit {
  state.features = state.features | function_features(name)
  state.functions[name] = true
  if runtime_call_capability(name, arity) is Some(group) {
    state.groups[group] = true
  }
}

///|
fn sorted_usage_names(names : Map[String, Bool]) -> Array[String] {
  let values : Array[String] = names.keys().collect()
  values.sort_by((a, b) => bytes_compare(@utf8.encode(a), @utf8.encode(b)))
  values
}

///|
/// Build-only analysis over validated typed IR, including all schema expressions.
pub fn program_runtime_requirements(artifact : String) -> String {
  try {
    let program = Program::load(artifact)
    let state : RuntimeUsageState = {
      features: 0U,
      functions: Map([]),
      groups: Map([]),
      expressions: Map([]),
      statements: Map([]),
      parts: Map([]),
    }
    RuntimeUsage::collect(program.schema.tables, state)
    RuntimeUsage::collect(program.schema.objects, state)
    for _, query in program.queries {
      RuntimeUsage::collect(query, state)
    }
    if program.storage is Some(storage) {
      RuntimeUsage::collect(storage.trees, state)
    }
    (
      {
        "format": "sqlike-runtime-requirements@1",
        "featureBits": state.features.reinterpret_as_int(),
        "functions": sorted_usage_names(state.functions),
        "functionGroups": sorted_usage_names(state.groups),
        "expressionGroups": sorted_usage_names(state.expressions),
        "statements": sorted_usage_names(state.statements),
        "queryParts": sorted_usage_names(state.parts),
      } : Json).stringify()
  } catch {
    error => public_error_json(error).stringify()
  }
}
