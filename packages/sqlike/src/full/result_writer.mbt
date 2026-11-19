///|
/// Keep the existing Cell wire representation without allocating Json objects
/// and Maps for each cell. Strings/numbers retain the core JSON formatter.
fn write_result_cell(output : StringBuilder, value : Value) -> Unit {
  match value {
    Null => output.write_string("{\"t\":\"null\"}")
    Integer(n) => {
      output.write_string("{\"t\":\"integer\",\"v\":\"")
      output.write_string(n.to_string())
      output.write_string("\"}")
    }
    Real(n) => {
      output.write_string("{\"t\":\"real\",\"v\":")
      if !n.is_finite() {
        output.write_string(
          if n < 0.0 {
            "\"-Infinity\""
          } else {
            "\"Infinity\""
          },
        )
      } else if n.reinterpret_as_uint64() == 0x8000000000000000UL {
        output.write_string("-0.0")
      } else {
        output.write_string(Json::number(n).stringify())
      }
      output.write_char('}')
    }
    Text(s) => {
      output.write_string("{\"t\":\"text\",\"v\":")
      output.write_string(Json::string(s).stringify())
      output.write_char('}')
    }
    Blob(bytes) => {
      output.write_string("{\"t\":\"blob\",\"v\":[")
      for i, byte in bytes {
        if i > 0 {
          output.write_char(',')
        }
        output.write_string(byte.to_int().to_string())
      }
      output.write_string("]}")
    }
  }
}

///|
fn write_result_row(output : StringBuilder, row : Environment) -> Unit {
  output.write_char('[')
  let mut first = true
  for binding in row {
    if !binding.hidden {
      if !first {
        output.write_char(',')
      }
      first = false
      write_result_cell(output, binding.value)
    }
  }
  output.write_char(']')
}

///|
fn positional_result_json(
  rows : Array[Environment],
  read_only : Bool,
) -> String {
  let output = StringBuilder()
  output.write_string("{\"rows\":[")
  for i, row in rows {
    if i > 0 {
      output.write_char(',')
    }
    write_result_row(output, row)
  }
  output.write_string("],\"readonly\":")
  output.write_string(if read_only { "true" } else { "false" })
  output.write_char('}')
  output.to_string()
}
