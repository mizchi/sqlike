///| A conservative lexer: one statement, no transaction escape, reserved names

///|
/// cannot be reached through quoted identifiers or comments. SQLite parses SQL.
pub fn sql_allowed(sql : String) -> Bool {
  let bytes = @utf8.encode(sql)
  let tokens : Array[String] = []
  let mut i = 0
  let mut ended = false
  while i < bytes.length() {
    let c = bytes[i].to_int()
    if c <= 32 {
      i += 1
    } else if c == 45 && i + 1 < bytes.length() && bytes[i + 1] == b'-' {
      while i < bytes.length() && bytes[i] != b'\n' {
        i += 1
      }
    } else if c == 47 && i + 1 < bytes.length() && bytes[i + 1] == b'*' {
      i += 2
      while i + 1 < bytes.length() &&
            !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
        i += 1
      }
      if i + 1 >= bytes.length() {
        return false
      }
      i += 2
    } else if ended {
      return false
    } else if c == 59 {
      ended = true
      i += 1
    } else if c == 34 || c == 39 || c == 96 || c == 91 {
      let end = if c == 91 { 93 } else { c }
      i += 1
      let word = @buffer.Buffer()
      let mut closed = false
      while i < bytes.length() {
        let b = bytes[i]
        i += 1
        if b.to_int() == end {
          if i < bytes.length() && bytes[i].to_int() == end && end != 93 {
            word.write_byte(b)
            i += 1
          } else {
            closed = true
            break
          }
        } else {
          word.write_byte(b)
        }
      }
      if !closed {
        return false
      }
      let token = @utf8.decode_lossy(word.to_bytes()).to_lower()
      if token.has_prefix("_bls_") ||
        token.has_prefix("_litestream_") ||
        token.has_prefix("__turso_") ||
        token.has_prefix("sqlite_") ||
        token == "load_extension" {
        return false
      }
      tokens.push("quoted")
    } else if (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 95 {
      let start = i
      while i < bytes.length() {
        let b = bytes[i].to_int()
        if (b >= 65 && b <= 90) ||
          (b >= 97 && b <= 122) ||
          (b >= 48 && b <= 57) ||
          b == 95 ||
          b >= 128 {
          i += 1
        } else {
          break
        }
      }
      let token = @utf8.decode_lossy(bytes[start:i]).to_lower()
      if token.has_prefix("_bls_") ||
        token.has_prefix("_litestream_") ||
        token.has_prefix("__turso_") ||
        token.has_prefix("sqlite_") ||
        token == "load_extension" {
        return false
      }
      tokens.push(token)
    } else {
      i += 1
    }
  }
  guard tokens.length() > 0 else { return false }
  match tokens[0] {
    "select"
    | "with"
    | "insert"
    | "update"
    | "delete"
    | "create"
    | "alter"
    | "drop"
    | "replace" => true
    _ => false
  }
}
