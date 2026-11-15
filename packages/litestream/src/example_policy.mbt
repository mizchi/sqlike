///|
/// Example consumer policy. The host supplies a read-only match count and score.
/// Edit this function or register another policy; decisions are never sent as code.
pub fn note_policy(input : String) -> String {
  try {
    let context = @json.parse(input)
    guard context
      is {
        "phase": String(phase),
        "context": {
          "guard": {
            "intent": { "id": String(id), "score": Number(score, ..), .. },
            ..
          },
          ..
        },
        "matches": Number(matches, ..),
        ..
      } &&
      id != "" &&
      score >= 0 &&
      score <= 1000000 &&
      score.to_int().to_double() == score else {
      return "{\"action\":\"reject\",\"reason\":\"invalid note intent\"}"
    }
    let result : Json = if phase == "before" {
      { "action": "apply" }
    } else if matches != 1 {
      {
        "action": "defer",
        "reason": "user selection does not identify exactly one note",
      }
    } else if phase == "after" {
      if context is { "score": Number(actual, ..), .. } && actual == score {
        { "action": "apply" }
      } else {
        { "action": "reject", "reason": "note score invariant failed" }
      }
    } else {
      {
        "action": "resolve",
        "reason": "apply to the explicitly selected primary key",
        "statements": [
          {
            "sql": "UPDATE notes SET score=? WHERE id=?",
            "params": [
              { "t": "integer", "v": score.to_int().to_string() },
              { "t": "text", "v": id },
            ],
          },
        ],
        "assertions": [
          {
            "name": "selected note",
            "query": {
              "sql": "SELECT id FROM notes WHERE id=?",
              "params": [{ "t": "text", "v": id }],
            },
            "exactly": 1,
          },
        ],
      }
    }
    result.stringify()
  } catch {
    _ => "{\"action\":\"reject\",\"reason\":\"invalid policy context\"}"
  }
}
