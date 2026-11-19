///|
#derive(ToJson, FromJson)
priv struct LtxBinaryPageState {
  format : String
  pageSize : Int32
  pageCount : Int32
  txid : String
  checksum : String
  seal : String
}

///|
/// Header seal detects accidental cursor corruption without scanning the catalog.
fn ltx_binary_seal(
  size : Int32,
  count : Int32,
  txid : UInt64,
  checksum : UInt64,
) -> String {
  let bytes = @buffer.Buffer()
  bytes.write_bytes(b"LTXCRC2\x00")
  ltx_be(bytes, size.to_uint64(), 4)
  ltx_be(bytes, count.to_uint64(), 4)
  ltx_be(bytes, txid, 8)
  ltx_be(bytes, checksum, 8)
  let crc = Crc64::{ value: 0xffffffffffffffffUL, }
  crc.write(bytes.to_bytes())
  crc.sum().to_string()
}

///|
fn ltx_binary_result(
  result : LtxResult,
  size : Int32,
  count : Int32,
  txid : String,
  checksum : UInt64,
  crcs : Bytes,
) -> LtxResult raise {
  let state : LtxBinaryPageState = {
    format: "ltx-page-state@2",
    pageSize: size,
    pageCount: count,
    txid,
    checksum: checksum.to_string(),
    seal: ltx_binary_seal(size, count, parse_txid(txid), checksum),
  }
  let info = @json.parse(result.metadata)
  guard info is Object(fields) else { raise Invalid("invalid LTX result") }
  fields["pageState"] = @json.to_json(state)
  fields["pageChecksums"] = @json.to_json(@base64.encode(crcs))
  ltx_result(result.data, info.stringify())
}

///|
/// previous contains BE64 CRCs for existing input pages, then truncated pages.
/// Snapshot frames recompute the whole post checksum and need no old entries.
fn encode_ltx_pages_binary_checked(
  state : String,
  metadata : String,
  data : Bytes,
  previous : Bytes,
) -> LtxResult raise {
  guard state.length() <= 8388608 &&
    metadata.length() <= 2097152 &&
    data.length() <= MaxImage &&
    previous.length() <= 1048576 else {
    raise Invalid("LTX binary page input limit")
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
  let old = @json.parse(if state == "" { "{}" } else { state })
  // The old full catalog is validated once during migration by the legacy codec.
  if old is { "format": "ltx-page-state@1", .. } {
    guard previous.is_empty() else {
      raise Invalid("unexpected legacy CRC payload")
    }
    let result = encode_ltx_pages_checked(state, metadata, data)
    let info = @json.parse(result.metadata)
    guard info is { "pageState": next, .. } else {
      raise Invalid("missing legacy LTX state")
    }
    let next : LtxPageState = @json.from_json(next)
    let crcs = @buffer.Buffer()
    for page in input.pages {
      ltx_be(crcs, @string.parse_uint64(next.pages[page - 1].1, radix=10), 8)
    }
    return ltx_binary_result(
      result,
      size,
      count,
      input.max,
      @string.parse_uint64(next.checksum, radix=10),
      crcs.to_bytes(),
    )
  }
  let mut before_count = 0
  let mut pre = 0UL
  if state != "" {
    guard state.length() <= 1024 &&
      old is { "pageSize": old_size, "pageCount": old_count, .. } else {
      raise Invalid("invalid binary LTX page state")
    }
    ignore(ltx_json_int(old_size))
    before_count = ltx_json_int(old_count)
    let old : LtxBinaryPageState = @json.from_json(old)
    let txid = parse_txid(old.txid)
    pre = @string.parse_uint64(old.checksum, radix=10)
    guard old.format == "ltx-page-state@2" &&
      old.pageSize == size &&
      before_count <= MaxImage / size &&
      txid > 0UL &&
      txid < 0xffffffffffffffffUL &&
      min == txid + 1UL &&
      (pre & ChecksumFlag) != 0UL &&
      old.seal == ltx_binary_seal(size, before_count, txid, pre) else {
      raise Invalid("binary LTX page state/transaction/seal mismatch")
    }
  } else {
    guard min == 1UL && input.snapshot else {
      raise Invalid("initial LTX pages require snapshot")
    }
  }
  let reader = LtxReader::{ data: previous, pos: 0, }
  let crcs = @buffer.Buffer()
  let mut post = if input.snapshot { ChecksumFlag } else { pre }
  let mut last = 0
  let mut grown = 0
  for i, page in input.pages {
    guard page > last && page <= count else {
      raise Invalid("invalid LTX page order/range")
    }
    last = page
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
    let old_crc = if !input.snapshot && page <= before_count {
      reader.be64()
    } else {
      0UL
    }
    if page > before_count {
      grown += 1
    }
    post = ChecksumFlag | (post ^ old_crc ^ crc)
    ltx_be(crcs, crc, 8)
  }
  if input.snapshot {
    guard input.pages.length() == count else {
      raise Invalid("incomplete LTX page snapshot")
    }
  } else {
    guard grown == (if count > before_count { count - before_count } else { 0 }) else {
      raise Invalid("missing grown LTX page")
    }
    for _ in count..<before_count {
      post = ChecksumFlag | (post ^ reader.be64())
    }
  }
  guard reader.pos == previous.length() else {
    raise Invalid("unexpected binary CRC payload")
  }
  if before_count != count && count > 0 {
    guard input.pages.contains(1) else {
      raise Invalid("missing LTX header page")
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
  ltx_binary_result(result, size, count, input.max, post, crcs.to_bytes())
}

///|
pub fn encode_ltx_pages_binary(
  state : String,
  metadata : String,
  data : Bytes,
  previous : Bytes,
) -> LtxResult {
  encode_ltx_pages_binary_checked(state, metadata, data, previous) catch {
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
pub fn encode_ltx_pages_binary_base64(
  state : String,
  metadata : String,
  data : String,
  previous : String,
) -> LtxResult {
  try {
    guard data.length() <= 89478488 && previous.length() <= 1398104 else {
      raise Invalid("LTX binary page input limit")
    }
    encode_ltx_pages_binary(
      state,
      metadata,
      @base64.decode(data),
      @base64.decode(previous),
    )
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
