///|
/// Durable, serializable checksum metadata; no database image or clean page
/// bytes are retained. The caller publishes the next state with the LTX file.
#derive(ToJson, FromJson)
priv struct LtxPageState {
  format : String
  pageSize : Int32
  pageCount : Int32
  txid : String
  checksum : String
  pages : Array[(Int32, String)]
}

///|
#derive(FromJson)
priv struct LtxPageInput {
  pageSize : Int32
  pageCount : Int32
  pages : Array[Int32]
  min : String
  max : String
  timestamp : String
  snapshot : Bool
}

///|
fn ltx_json_int(value : Json) -> Int32 raise {
  guard value is Number(n, ..) &&
    n >= 0 &&
    n <= 2147483647 &&
    n.to_int().to_double() == n else {
    raise Invalid("invalid LTX page integer")
  }
  n.to_int()
}

///|
fn ltx_page_crc(page : Int32, data : BytesView) -> UInt64 {
  let crc = Crc64::{ value: 0xffffffffffffffffUL, }
  let head = @buffer.Buffer()
  head.write_int_be(page)
  crc.write(head.to_bytes())
  crc.write(data)
  crc.sum()
}

///|
fn encode_ltx_pages_checked(
  state : String,
  metadata : String,
  data : Bytes,
) -> LtxResult raise {
  guard state.length() <= 8388608 &&
    metadata.length() <= 2097152 &&
    data.length() <= MaxImage else {
    raise Invalid("LTX page input limit")
  }
  let json = @json.parse(metadata)
  guard json
    is { "pageSize": size, "pageCount": count, "pages": Array(raw), .. } else {
    raise Invalid("invalid LTX page metadata")
  }
  let size = ltx_json_int(size)
  let count = ltx_json_int(count)
  guard size >= 512 &&
    size <= 65536 &&
    (size & (size - 1)) == 0 &&
    count <= MaxImage / size &&
    raw.length() <= count else {
    raise Invalid("invalid LTX page size/count")
  }
  for page in raw {
    ignore(ltx_json_int(page))
  }
  let input : LtxPageInput = @json.from_json(json)
  guard data.length() == input.pages.length() * size else {
    raise Invalid("LTX page payload size mismatch")
  }
  let min = parse_txid(input.min)
  let max = parse_txid(input.max)
  let time = @string.parse_int64(input.timestamp)
  guard min > 0UL && min <= max && time >= 0L else {
    raise Invalid("invalid LTX page transaction/time")
  }
  let checksums : Map[Int32, UInt64] = Map([])
  let mut pre = 0UL
  let mut post = ChecksumFlag
  let mut before_count = 0
  if state != "" {
    let json = @json.parse(state)
    guard json
      is {
        "pageSize": old_size,
        "pageCount": old_count,
        "pages": Array(raw),
        ..
      } else {
      raise Invalid("invalid LTX page state")
    }
    ignore(ltx_json_int(old_size))
    before_count = ltx_json_int(old_count)
    guard before_count <= MaxImage / size && raw.length() == before_count else {
      raise Invalid("incomplete LTX page state")
    }
    for i, pair in raw {
      guard pair is Array([number, String(_)]) && ltx_json_int(number) == i + 1 else {
        raise Invalid("invalid LTX page checksum entry")
      }
    }
    let old : LtxPageState = @json.from_json(json)
    guard old.format == "ltx-page-state@1" &&
      old.pageSize == size &&
      parse_txid(old.txid) < 0xffffffffffffffffUL &&
      min == parse_txid(old.txid) + 1UL else {
      raise Invalid("LTX page state/transaction mismatch")
    }
    for (page, checksum) in old.pages {
      let crc = @string.parse_uint64(checksum, radix=10)
      checksums[page] = crc
      post = ChecksumFlag | (post ^ crc)
    }
    pre = @string.parse_uint64(old.checksum, radix=10)
    guard post == pre else { raise Invalid("LTX page state checksum mismatch") }
  } else {
    guard min == 1UL && input.snapshot else {
      raise Invalid("initial LTX pages require snapshot")
    }
  }
  let mut previous = 0
  for i, page in input.pages {
    guard page > previous && page <= count else {
      raise Invalid("invalid LTX page order/range")
    }
    previous = page
    let bytes = data[i * size:(i + 1) * size]
    if page == 1 {
      guard bytes[0:16] == b"SQLite format 3\x00" &&
        (
          (bytes[28].to_int() << 24) |
          (bytes[29].to_int() << 16) |
          (bytes[30].to_int() << 8) |
          bytes[31].to_int()
        ) ==
        count &&
        ((bytes[16].to_int() << 8) | bytes[17].to_int()) ==
        (if size == 65536 { 1 } else { size }) else {
        raise Invalid("LTX page header mismatch")
      }
    }
    let crc = ltx_page_crc(page, bytes)
    post = ChecksumFlag | (post ^ checksums.get(page).unwrap_or(0UL) ^ crc)
    checksums[page] = crc
  }
  for page in (before_count + 1)..<=count {
    guard checksums.contains(page) else {
      raise Invalid("missing grown LTX page")
    }
  }
  if input.snapshot {
    guard input.pages.length() == count else {
      raise Invalid("incomplete LTX page snapshot")
    }
  }
  if before_count != count && count > 0 {
    guard input.pages.contains(1) else {
      raise Invalid("missing LTX header page")
    }
  }
  if count < before_count {
    for page in (count + 1)..<=before_count {
      post = ChecksumFlag | (post ^ checksums[page])
      checksums.remove(page)
    }
  }
  let frames = input.pages
    .mapi((i, page) => (page, data[i * size:(i + 1) * size]))
    .iter()
  let result = ltx_write_pages(
    size,
    count,
    input.min,
    input.max,
    time,
    pre,
    post,
    data.length() / 4,
    frames,
  )
  let next : LtxPageState = {
    format: "ltx-page-state@1",
    pageSize: size,
    pageCount: count,
    txid: input.max,
    checksum: post.to_string(),
    pages: Array::makei(count, i => (i + 1, checksums[i + 1].to_string())),
  }
  let info = @json.parse(result.metadata)
  if info is Object(fields) {
    fields["pageState"] = @json.to_json(next)
  }
  ltx_result(result.data, info.stringify())
}

///|
pub fn encode_ltx_pages(
  state : String,
  metadata : String,
  data : Bytes,
) -> LtxResult {
  encode_ltx_pages_checked(state, metadata, data) catch {
    e =>
      ltx_result(
        b"",
        (
          {
            "error": match e {
              Invalid(message) => message
              _ => e.to_string()
            },
          } : Json).stringify(),
      )
  }
}

///|
pub fn encode_ltx_pages_base64(
  state : String,
  metadata : String,
  data : String,
) -> LtxResult {
  try {
    guard data.length() <= 89478488 else {
      raise Invalid("LTX page payload input limit")
    }
    encode_ltx_pages(state, metadata, @base64.decode(data))
  } catch {
    e =>
      ltx_result(
        b"",
        (
          {
            "error": match e {
              Invalid(message) => message
              _ => e.to_string()
            },
          } : Json).stringify(),
      )
  }
}
