///|
/// Optional derived inverted index. No dependency on the SQL parser or database.
priv struct Position {
  column : Int32
  offset : Int32
}

///|
priv struct Document {
  fields : Array[String]
  length : Int32
  bytes : Int32
}

///|
pub struct SearchIndex {
  priv columns : Array[String]
  priv tokenizer : String
  priv documents : Map[Int64, Document]
  priv postings : Map[String, Map[Int64, Array[Position]]]
  priv mut bytes : Int32
  priv mut total : Int32
  priv error : String?
}

///|
priv suberror SearchError {
  SearchError(String)
}

///|
fn[T] fail(message : String) -> T raise SearchError {
  raise SearchError(message)
}

///|
fn error_json(e : Error) -> String {
  (
    {
      "error": match e {
        SearchError(s) => s
        _ => e.to_string()
      },
    } : Json).stringify()
}

///|
pub fn fts_open(columns : String, tokenizer : String) -> SearchIndex {
  try {
    let columns : Array[String] = @json.from_json(@json.parse(columns))
    guard columns.length() > 0 &&
      columns.length() <= 64 &&
      columns.all(name => {
        !name.is_empty() &&
        name.length() <= 256 &&
        columns
        .filter(other => {
          String::from_iter(other.iter().map(fold)) ==
          String::from_iter(name.iter().map(fold))
        })
        .length() ==
        1
      }) &&
      ["ascii", "trigram"].contains(tokenizer) else {
      fail("invalid search configuration")
    }
    {
      columns,
      tokenizer,
      documents: Map([]),
      postings: Map([]),
      bytes: 0,
      total: 0,
      error: None,
    }
  } catch {
    e =>
      {
        columns: [],
        tokenizer,
        documents: Map([]),
        postings: Map([]),
        bytes: 0,
        total: 0,
        error: Some(e.to_string()),
      }
  }
}

///|
pub fn fts_info(index : SearchIndex) -> String {
  match index.error {
    Some(s) => ({ "error": s } : Json).stringify()
    None =>
      (
        {
          "documents": index.documents.length(),
          "terms": index.postings.length(),
          "tokens": index.total,
        } : Json).stringify()
  }
}

///|
fn healthy(index : SearchIndex) -> Unit raise SearchError {
  if index.error is Some(s) {
    fail(s)
  }
}

///|
fn fold(c : Char) -> Char {
  if c >= 'A' && c <= 'Z' {
    (c.to_int() + 32).unsafe_to_char()
  } else {
    c
  }
}

///|
fn tokens(text : String, tokenizer : String) -> Array[String] {
  let chars = if tokenizer == "trigram" {
    text.iter().map(unicode_fold).to_array()
  } else {
    text.iter().map(fold).to_array()
  }
  let out : Array[String] = []
  if tokenizer == "trigram" {
    for i = 0; i + 2 < chars.length(); i = i + 1 {
      out.push(String::from_iter(chars[i:i + 3].iter()))
    }
  } else {
    let mut word : Array[Char] = []
    for c in chars {
      if c.to_int() >= 128 || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') {
        word.push(c)
      } else if !word.is_empty() {
        out.push(String::from_iter(word.iter()))
        word = []
      }
    }
    if !word.is_empty() {
      out.push(String::from_iter(word.iter()))
    }
  }
  out
}

///|
fn remove(index : SearchIndex, id : Int64) -> Unit {
  if index.documents.get(id) is Some(doc) {
    for text in doc.fields {
      for term in tokens(text, index.tokenizer) {
        if index.postings.get(term) is Some(posting) {
          posting.remove(id)
          if posting.is_empty() {
            index.postings.remove(term)
          }
        }
      }
    }
    index.bytes -= doc.bytes
    index.total -= doc.length
    index.documents.remove(id)
  }
}

///|
fn put(
  index : SearchIndex,
  id : Int64,
  fields : Array[String],
) -> Unit raise SearchError {
  healthy(index)
  guard fields.length() == index.columns.length() &&
    fields.all(v => v.length() <= 1048576) &&
    (index.documents.contains(id) || index.documents.length() < 100000) else {
    fail("search resource limit or column count mismatch")
  }
  let bytes = @utf8.encode(@json.to_json((id.to_string(), fields)).stringify()).length() +
    1
  guard index.bytes -
    index.documents.get(id).map(d => d.bytes).unwrap_or(0) +
    bytes <=
    67043328 else {
    fail("search byte resource limit")
  }
  let parsed = fields.map(s => tokens(s, index.tokenizer))
  remove(index, id)
  let mut length = 0
  for column, terms in parsed {
    length += terms.length()
    for offset, term in terms {
      if !index.postings.contains(term) {
        index.postings[term] = Map([])
      }
      let posting = index.postings[term]
      if !posting.contains(id) {
        posting[id] = []
      }
      posting[id].push({ column, offset, })
    }
  }
  index.documents[id] = { fields, length, bytes, }
  index.bytes += bytes
  index.total += length
}

///|
pub fn fts_put(index : SearchIndex, rowid : String, values : String) -> String {
  try {
    let fields : Array[String] = @json.from_json(@json.parse(values))
    put(index, @string.parse_int64(rowid), fields)
    "{}"
  } catch {
    e => error_json(e)
  }
}

///|
pub fn fts_delete(index : SearchIndex, rowid : String) -> String {
  try {
    healthy(index)
    remove(index, @string.parse_int64(rowid))
    "{}"
  } catch {
    e => error_json(e)
  }
}

///|
priv struct Phrase {
  terms : Array[String]
  prefix : Bool
  column : Int32
}

///|
priv enum SearchExpr {
  Phrase(Phrase)
  And(SearchExpr, SearchExpr)
  Or(SearchExpr, SearchExpr)
  Not(SearchExpr, SearchExpr)
}

///|
priv struct QueryToken {
  text : String
  quoted : Bool
}

///|
priv struct QueryParser {
  index : SearchIndex
  input : Array[QueryToken]
  mut position : Int32
}

///|
fn query_tokens(text : String) -> Array[QueryToken] raise SearchError {
  let chars = text.iter().to_array()
  let result : Array[QueryToken] = []
  let mut i = 0
  while i < chars.length() {
    let c = chars[i]
    if c <= ' ' {
      i += 1
      continue
    }
    if "():*+".iter().any(x => x == c) {
      result.push({ text: c.to_string(), quoted: false, })
      i += 1
      continue
    }
    if c == '"' {
      let word : Array[Char] = []
      i += 1
      let mut closed = false
      while i < chars.length() {
        if chars[i] == '"' {
          i += 1
          if i < chars.length() && chars[i] == '"' {
            word.push('"')
            i += 1
          } else {
            closed = true
            break
          }
        } else {
          word.push(chars[i])
          i += 1
        }
      }
      guard closed else { fail("unterminated search phrase") }
      result.push({ text: String::from_iter(word.iter()), quoted: true, })
    } else {
      let start = i
      while i < chars.length() &&
            chars[i] > ' ' &&
            !"():*+\"".iter().any(x => x == chars[i]) {
        guard chars[i].to_int() >= 128 ||
          (chars[i] >= 'a' && chars[i] <= 'z') ||
          (chars[i] >= 'A' && chars[i] <= 'Z') ||
          (chars[i] >= '0' && chars[i] <= '9') ||
          chars[i] == '_' else {
          fail("quote punctuation in search terms")
        }
        i += 1
      }
      result.push({
        text: String::from_iter(chars[start:i].iter()),
        quoted: false,
      })
    }
    guard result.length() <= 1000 else { fail("search query resource limit") }
  }
  result
}

///|
fn QueryParser::peek(p : QueryParser) -> String {
  if p.position < p.input.length() && !p.input[p.position].quoted {
    p.input[p.position].text
  } else {
    ""
  }
}

///|
fn QueryParser::term(
  p : QueryParser,
  depth : Int32,
) -> SearchExpr raise SearchError {
  guard depth < 64 && p.position < p.input.length() else {
    fail("invalid search query")
  }
  if p.peek() == "(" {
    p.position += 1
    let e = p.expression(1, depth + 1)
    guard p.peek() == ")" else { fail("missing search parenthesis") }
    p.position += 1
    return e
  }
  let mut column = -1
  if p.position + 1 < p.input.length() && p.input[p.position + 1].text == ":" {
    let name = p.input[p.position].text
    for i, c in p.index.columns {
      if String::from_iter(c.iter().map(fold)) ==
        String::from_iter(name.iter().map(fold)) {
        column = i
        break
      }
    }
    guard column >= 0 else { fail("no such search column") }
    p.position += 2
  }
  guard p.position < p.input.length() &&
    !["AND", "OR", "NOT", ")", "*", ":"].contains(p.peek()) else {
    fail("invalid search term")
  }
  let mut terms = tokens(p.input[p.position].text, p.index.tokenizer)
  p.position += 1
  while p.peek() == "+" {
    p.position += 1
    guard p.position < p.input.length() else { fail("missing phrase term") }
    terms = terms + tokens(p.input[p.position].text, p.index.tokenizer)
    p.position += 1
  }
  let prefix = p.peek() == "*"
  if prefix {
    p.position += 1
  }
  Phrase({ terms, prefix, column, })
}

///|
fn QueryParser::expression(
  p : QueryParser,
  minimum : Int32,
  depth : Int32,
) -> SearchExpr raise SearchError {
  let mut left = p.term(depth)
  while p.position < p.input.length() && p.peek() != ")" {
    let op = p.peek()
    let precedence = match op {
      "OR" => 1
      "AND" => 2
      "NOT" => 3
      _ => 4
    }
    if precedence < minimum {
      break
    }
    if precedence < 4 {
      p.position += 1
    }
    let right = p.expression(precedence + 1, depth + 1)
    left = if op == "OR" {
      Or(left, right)
    } else if op == "NOT" {
      Not(left, right)
    } else {
      And(left, right)
    }
  }
  left
}

///|
fn phrase_matches(index : SearchIndex, phrase : Phrase) -> Map[Int64, Int32] {
  let results : Map[Int64, Int32] = Map([])
  if phrase.terms.is_empty() {
    return results
  }
  let postings : Array[Map[Int64, Array[Position]]] = []
  for i, term in phrase.terms {
    if phrase.prefix && i == phrase.terms.length() - 1 {
      let found : Map[Int64, Array[Position]] = Map([])
      for key, posting in index.postings {
        if key.has_prefix(term) {
          for id, positions in posting {
            found[id] = found.get(id).unwrap_or([]) + positions
          }
        }
      }
      postings.push(found)
    } else {
      postings.push(index.postings.get(term).unwrap_or(Map([])))
    }
  }
  for id, first in postings[0] {
    let mut frequency = 0
    for position in first {
      if phrase.column >= 0 && position.column != phrase.column {
        continue
      }
      if postings
        .mapi((i, posting) => {
          posting
          .get(id)
          .map(ps => {
            ps.any(p => {
              p.column == position.column && p.offset == position.offset + i
            })
          })
          .unwrap_or(false)
        })
        .all(v => v) {
        frequency += 1
      }
    }
    if frequency > 0 {
      results[id] = frequency
    }
  }
  results
}

///|
fn matching(index : SearchIndex, e : SearchExpr) -> Map[Int64, Bool] {
  match e {
    Phrase(p) => Map(phrase_matches(index, p).to_array().map(p => (p.0, true)))
    And(a, b) => {
      let left = matching(index, a)
      let right = matching(index, b)
      Map(left.to_array().filter(p => right.contains(p.0)))
    }
    Or(a, b) => {
      let left = matching(index, a)
      for id, _ in matching(index, b) {
        left[id] = true
      }
      left
    }
    Not(a, b) => {
      let left = matching(index, a)
      for id, _ in matching(index, b) {
        left.remove(id)
      }
      left
    }
  }
}

///|
fn positive_phrases(e : SearchExpr, out : Array[Phrase]) -> Unit {
  match e {
    Phrase(p) => out.push(p)
    And(a, b) | Or(a, b) => {
      positive_phrases(a, out)
      positive_phrases(b, out)
    }
    Not(a, _) => positive_phrases(a, out)
  }
}

///|
pub fn fts_search(index : SearchIndex, query : String, limit : Int32) -> String {
  try {
    healthy(index)
    guard limit >= 0 && limit <= 100000 && query.length() <= 1048576 else {
      fail("search resource limit")
    }
    let parser = { index, input: query_tokens(query), position: 0, }
    let expr = parser.expression(1, 0)
    guard parser.position == parser.input.length() else {
      fail("trailing search query")
    }
    let found = matching(index, expr)
    let phrases : Array[Phrase] = []
    positive_phrases(expr, phrases)
    let frequencies = phrases.map(p => phrase_matches(index, p))
    let count = index.documents.length().to_double()
    let average = if count == 0.0 {
      1.0
    } else {
      index.total.to_double() / count
    }
    let hits = found
      .to_array()
      .map(pair => {
        let id = pair.0
        let length = index.documents[id].length.to_double()
        let mut score = 0.0
        for frequency in frequencies {
          let df = frequency.length().to_double()
          let f = frequency.get(id).unwrap_or(0).to_double()
          let idf = @math.ln((count - df + 0.5) / (df + 0.5)).max(0.000001)
          if f > 0.0 {
            score -= idf *
              (f * 2.2) /
              (f + 1.2 * (0.25 + 0.75 * length / average))
          }
        }
        (id, score)
      })
    hits.sort_by((a, b) => {
      let c = a.1.compare(b.1)
      if c == 0 {
        a.0.compare(b.0)
      } else {
        c
      }
    })
    let hits = hits[0:limit.min(hits.length())]
      .to_owned()
      .map(p => ({ "rowid": p.0.to_string(), "rank": p.1 } : Json))
    ({ "hits": Json::array(hits) } : Json).stringify()
  } catch {
    e => error_json(e)
  }
}

///|
#derive(ToJson, FromJson)
priv struct Image {
  format : String
  columns : Array[String]
  tokenizer : String
  documents : Array[(String, Array[String])]
}

///|
pub fn fts_dump(index : SearchIndex) -> String {
  let docs = index.documents.to_array()
  docs.sort_by((a, b) => a.0.compare(b.0))
  let image : Image = {
    format: "sqlike-search@1",
    columns: index.columns,
    tokenizer: index.tokenizer,
    documents: docs.map(p => (p.0.to_string(), p.1.fields)),
  }
  @json.to_json(image).stringify()
}

///|
pub fn fts_restore(index : SearchIndex, input : String) -> String {
  try {
    healthy(index)
    guard input.length() <= 67108864 else {
      fail("search image resource limit")
    }
    let image : Image = @json.from_json(@json.parse(input))
    guard image.format == "sqlike-search@1" &&
      image.columns == index.columns &&
      image.tokenizer == index.tokenizer else {
      fail("search image configuration mismatch")
    }
    let candidate = fts_open(
      @json.to_json(image.columns).stringify(),
      image.tokenizer,
    )
    for (id, fields) in image.documents {
      let id = @string.parse_int64(id)
      guard !candidate.documents.contains(id) else {
        fail("duplicate search rowid")
      }
      put(candidate, id, fields)
    }
    index.documents.clear()
    for id, doc in candidate.documents {
      index.documents[id] = doc
    }
    index.postings.clear()
    for term, posting in candidate.postings {
      index.postings[term] = posting
    }
    index.bytes = candidate.bytes
    index.total = candidate.total
    "{}"
  } catch {
    e => error_json(e)
  }
}
