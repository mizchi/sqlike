///|
fn sql_name(name : String) -> String {
  "\"" + name.replace_all(old="\"", new="\"\"") + "\""
}
