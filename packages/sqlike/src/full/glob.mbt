///|
priv enum GlobAtom {
  GlobMany
  GlobOne
  GlobLiteral(Char)
  GlobClass(Bool, Array[(Char, Char)])
}

///|
fn glob_atom_matches(atom : GlobAtom, c : Char) -> Bool {
  match atom {
    GlobOne => true
    GlobLiteral(want) => c == want
    GlobClass(invert, ranges) =>
      ranges.any(range => c >= range.0 && c <= range.1) != invert
    GlobMany => false
  }
}

///|
/// Classes consume one Unicode scalar. Retry only the most recent star, so
/// hostile patterns do not cause recursive or exponential backtracking.
fn glob(text : String, pattern : String) -> Bool {
  let text = pattern_chars(text)
  let pattern = pattern_chars(pattern)
  let atoms : Array[GlobAtom] = []
  let mut i = 0
  while i < pattern.length() {
    let c = pattern[i]
    i += 1
    if c == '*' {
      atoms.push(GlobMany)
    } else if c == '?' {
      atoms.push(GlobOne)
    } else if c == '[' {
      let invert = i < pattern.length() && pattern[i] == '^'
      if invert {
        i += 1
      }
      let ranges : Array[(Char, Char)] = []
      if i < pattern.length() && pattern[i] == ']' {
        ranges.push((']', ']'))
        i += 1
      }
      let mut prior : Char? = None
      while i < pattern.length() && pattern[i] != ']' {
        let c = pattern[i]
        if c == '-' &&
          i + 1 < pattern.length() &&
          pattern[i + 1] != ']' &&
          prior is Some(low) {
          ranges.push((low, pattern[i + 1]))
          prior = None
          i += 2
        } else {
          ranges.push((c, c))
          prior = Some(c)
          i += 1
        }
      }
      guard i < pattern.length() else { return false }
      i += 1
      atoms.push(GlobClass(invert, ranges))
    } else {
      atoms.push(GlobLiteral(c))
    }
  }
  let mut p = 0
  let mut t = 0
  let mut star = -1
  let mut retry = 0
  while t < text.length() {
    if p < atoms.length() && atoms[p] is GlobMany {
      star = p
      retry = t
      p += 1
    } else if p < atoms.length() && glob_atom_matches(atoms[p], text[t]) {
      p += 1
      t += 1
    } else if star >= 0 {
      retry += 1
      t = retry
      p = star + 1
    } else {
      return false
    }
  }
  while p < atoms.length() && atoms[p] is GlobMany {
    p += 1
  }
  p == atoms.length()
}
