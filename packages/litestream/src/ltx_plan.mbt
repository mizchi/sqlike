///|
#derive(FromJson)
priv struct LtxFile {
  id : String
  minTXID : String
  maxTXID : String
  size : Int32
}

///|
/// Pick a contiguous restore chain across snapshot and compaction levels.
fn plan_ltx_checked(
  catalog : String,
  current : String,
  target : String,
) -> String raise {
  let files : Array[LtxFile] = @json.from_json(@json.parse(catalog))
  let head = parse_txid(target)
  let mut pos = parse_txid(current)
  guard pos <= head else { raise Invalid("LTX replica regressed") }
  let result : Array[String] = []
  while pos < head {
    let mut best : LtxFile? = None
    let mut best_max = pos
    for file in files {
      let min = parse_txid(file.minTXID)
      let max = parse_txid(file.maxTXID)
      guard min > 0UL && min <= max && file.size > 0 else {
        raise Invalid("invalid LTX catalog entry")
      }
      if min <= pos + 1UL && max > pos && max <= head {
        if max > best_max ||
          (
            max == best_max &&
            best is Some(previous) &&
            file.size < previous.size
          ) {
          best = Some(file)
          best_max = max
        }
      }
    }
    match best {
      Some(file) => {
        result.push(file.id)
        pos = best_max
      }
      None => raise Invalid("LTX catalog gap; snapshot required")
    }
  }
  @json.to_json(result).stringify()
}

///|
pub fn plan_ltx(catalog : String, current : String, target : String) -> String {
  plan_ltx_checked(catalog, current, target) catch {
    Invalid(message) => ({ "error": message } : Json).stringify()
    _ => "{\"error\":\"invalid LTX catalog\"}"
  }
}
