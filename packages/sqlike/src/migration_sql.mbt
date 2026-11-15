///|
/// Rewrite identifier spans, retaining unrelated DDL tokens for schema signatures.
fn migration_sql(
  sql : String,
  r : Rename,
  owner : String,
  kind : String,
  drop : Bool,
  quoted : Bool,
) -> String raise SqlError {
  let p = lex(sql)
  let tokens = p.tokens
  let replacements : Map[Int32, (Int32, String)] = Map([])
  if drop && kind == "table" && identifier(owner) == identifier(r.table) {
    let mut depth = 0
    let mut start = -1
    let mut previous_comma = -1
    for i, token in tokens {
      if token.word == "(" {
        depth += 1
        if depth == 1 {
          start = i + 1
        }
      } else if token.word == ")" {
        depth -= 1
      }
      if start >= 0 &&
        ((token.word == "," && depth == 1) || (token.word == ")" && depth == 0)) {
        if start < i && identifier(tokens[start].word) == identifier(r.column) {
          let a = if token.word == "," {
            tokens[start].start
          } else {
            tokens[previous_comma].start
          }
          let b = if token.word == "," { token.end } else { token.start }
          return @utf8.decode_lossy(p.source[0:a]) +
            @utf8.decode_lossy(p.source[b:])
        }
        previous_comma = i
        start = i + 1
      }
    }
    fail("missing column definition")
  }
  let reference_owner : Map[Int32, String] = Map([])
  for i, token in tokens {
    if identifier(token.word) == "references" &&
      i + 2 < tokens.length() &&
      tokens[i + 2].word == "(" {
      let mut j = i + 3
      while j < tokens.length() && tokens[j].word != ")" {
        if tokens[j].kind == 0 || tokens[j].kind == 2 {
          reference_owner[tokens[j].start] = tokens[i + 1].word
        }
        j += 1
      }
    }
  }
  let aliases : Map[String, String] = Map([])
  // CHECK/index expressions may qualify columns by their owning table without
  // a FROM clause. Keep stored SQL and the renamed expression tree consistent.
  if kind == "table" || kind == "index" {
    aliases[identifier(owner)] = owner
  }
  for i, token in tokens {
    if ["from", "join", "into", "update"].contains(identifier(token.word)) &&
      i + 1 < tokens.length() {
      let table = tokens[i + 1].word
      if ["of", "on"].contains(identifier(table)) {
        continue
      }
      aliases[identifier(table)] = table
      if i + 3 < tokens.length() && identifier(tokens[i + 2].word) == "as" {
        aliases[identifier(tokens[i + 3].word)] = table
      }
    }
  }
  aliases["old"] = owner
  aliases["new"] = owner
  let explicit_aliases : Array[String] = []
  for i, token in tokens {
    if identifier(token.word) == "as" && i + 1 < tokens.length() {
      explicit_aliases.push(identifier(tokens[i + 1].word))
    }
  }
  let mut segment_start = 0
  for i, token in tokens {
    if token.word == ";" || identifier(token.word) == "begin" {
      segment_start = i + 1
    }
    if token.kind != 0 && token.kind != 2 {
      continue
    }
    let previous = if i > 0 { identifier(tokens[i - 1].word) } else { "" }
    let next = if i + 1 < tokens.length() { tokens[i + 1].word } else { "" }
    let name = identifier(token.word)
    if r.column == "" {
      if name != identifier(r.table) {
        continue
      }
      let qualified = next == "." && !explicit_aliases.contains(name)
      let table_position = [
        "table", "references", "from", "join", "into", "update", "on",
      ].contains(previous)
      if qualified || table_position {
        replacements[token.start] = (token.end, sql_name(r.new_table))
      }
      continue
    }
    if name != identifier(r.column) {
      continue
    }
    let mut target = ""
    if previous == "." && i >= 2 {
      target = aliases.get(identifier(tokens[i - 2].word)).unwrap_or("")
    } else {
      target = if kind == "index" || kind == "table" { owner } else { "" }
      // Table/index expressions belong to their declared owner. In particular,
      // REFERENCES ... ON UPDATE CASCADE is not an UPDATE statement scope.
      let mut j = if kind == "table" || kind == "index" {
        tokens.length()
      } else {
        segment_start
      }
      while j < tokens.length() &&
            tokens[j].word != ";" &&
            identifier(tokens[j].word) != "end" {
        let word = identifier(tokens[j].word)
        if ["from", "join", "into", "update"].contains(word) &&
          j + 1 < tokens.length() &&
          !["of", "on"].contains(identifier(tokens[j + 1].word)) {
          target = tokens[j + 1].word
          break
        }
        j += 1
      }
      if kind == "trigger" &&
        i < tokens.length() &&
        !tokens[0:i].iter().any(t => identifier(t.word) == "begin") {
        target = owner
      }
      if kind == "table" {
        // REFERENCES column lists belong to the parent, not the owning table.
        let mut k = i - 1
        while k >= 0 && tokens[k].word != "," && tokens[k].word != "(" {
          k -= 1
        }
        if k >= 2 &&
          tokens[k].word == "(" &&
          identifier(tokens[k - 2].word) == "references" {
          target = tokens[k - 1].word
        }
      }
    }
    if reference_owner.get(token.start) is Some(parent) {
      target = parent
    }
    if identifier(target) == identifier(r.table) &&
      previous != "collate" &&
      next != "(" {
      replacements[token.start] = (
        token.end,
        if quoted || token.kind == 2 {
          sql_name(r.new_column)
        } else {
          r.new_column
        },
      )
    }
  }
  let out = @buffer.Buffer()
  let mut cursor = 0
  for token in tokens {
    if replacements.get(token.start) is Some((end, text)) {
      out.write_bytes(p.source[cursor:token.start].to_owned())
      out.write_bytes(@utf8.encode(text))
      cursor = end
    }
  }
  out.write_bytes(p.source[cursor:].to_owned())
  @utf8.decode_lossy(out.to_bytes())
}
