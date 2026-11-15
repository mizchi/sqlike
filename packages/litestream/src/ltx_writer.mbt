///|
/// LTX v3 writer. Checksums cover logical uncompressed pages, not LZ4 bytes.
fn ltx_be(out : @buffer.Buffer, value : UInt64, bytes : Int32) -> Unit {
  for i = bytes - 1; i >= 0; i = i - 1 {
    out.write_byte(((value >> (i * 8)) & 255UL).to_byte())
  }
}

///|
fn ltx_varint(out : @buffer.Buffer, value : Int32) -> Unit {
  let mut value = value
  while value >= 128 {
    out.write_byte(((value & 127) | 128).to_byte())
    value = value >> 7
  }
  out.write_byte(value.to_byte())
}

///|
fn lz4_length(out : @buffer.Buffer, value : Int32) -> Unit {
  let mut value = value
  while value >= 255 {
    out.write_byte(b'\xff')
    value -= 255
  }
  out.write_byte(value.to_byte())
}

///|
fn lz4_hash(page : BytesView, pos : Int32) -> Int32 {
  ((le32(page, pos) * 2654435761U) >> 20).reinterpret_as_int()
}

///|
/// Greedy 4-byte matches with a bounded hash table. Keep the last five bytes as
/// literals and the final match start twelve bytes from the end (LZ4 format).
fn lz4_compress(page : BytesView) -> Bytes {
  let out = @buffer.Buffer(size_hint=page.length() + page.length() / 255 + 16)
  let table : FixedArray[Int32] = FixedArray::make(4096, -1)
  let mut anchor = 0
  let mut pos = 0
  while pos <= page.length() - 12 {
    let hash = lz4_hash(page, pos)
    let previous = table[hash]
    table[hash] = pos
    if previous < 0 ||
      pos - previous > 65535 ||
      page[previous:previous + 4] != page[pos:pos + 4] {
      pos += 1
      continue
    }
    let mut length = 4
    while pos + length < page.length() - 5 &&
          page[previous + length] == page[pos + length] {
      length += 1
    }
    let literals = pos - anchor
    out.write_byte(((literals.min(15) << 4) | (length - 4).min(15)).to_byte())
    if literals >= 15 {
      lz4_length(out, literals - 15)
    }
    out.write_bytes(page[anchor:pos])
    let distance = pos - previous
    out.write_byte((distance & 255).to_byte())
    out.write_byte((distance >> 8).to_byte())
    if length >= 19 {
      lz4_length(out, length - 19)
    }
    pos += length
    anchor = pos
    if pos >= 2 && pos <= page.length() - 4 {
      table[lz4_hash(page, pos - 2)] = pos - 2
    }
  }
  let literals = page.length() - anchor
  out.write_byte((literals.min(15) << 4).to_byte())
  if literals >= 15 {
    lz4_length(out, literals - 15)
  }
  out.write_bytes(page[anchor:])
  out.to_bytes()
}

///|
fn ltx_image_size(data : Bytes) -> Int32 raise {
  guard data.length() >= 100 && data[0:16] == b"SQLite format 3\x00" else {
    raise Invalid("invalid SQLite image header")
  }
  let encoded = (data[16].to_int() << 8) | data[17].to_int()
  let size = if encoded == 1 { 65536 } else { encoded }
  guard size >= 512 &&
    size <= 65536 &&
    (size & (size - 1)) == 0 &&
    data.length() % size == 0 else {
    raise Invalid("invalid SQLite image page size")
  }
  size
}

///|
fn encode_ltx_checked(
  base : Bytes,
  data : Bytes,
  minimum : String,
  maximum : String,
  time : String,
) -> LtxResult raise {
  guard base.length() <= MaxImage && data.length() <= MaxImage else {
    raise Invalid("LTX image exceeds 64 MiB limit")
  }
  let min = parse_txid(minimum)
  let max = parse_txid(maximum)
  guard min > 0UL && min <= max else { raise Invalid("invalid LTX TXID range") }
  let timestamp = @string.parse_int64(time)
  guard timestamp >= 0L else { raise Invalid("invalid LTX timestamp") }
  let size = if !data.is_empty() {
    ltx_image_size(data)
  } else if !base.is_empty() {
    ltx_image_size(base)
  } else {
    4096
  }
  if min != 1UL {
    guard !base.is_empty() else {
      raise Invalid("LTX base SQLite image required")
    }
    guard ltx_image_size(base) == size else {
      raise Invalid("SQLite page size changed; snapshot required")
    }
  }
  let pre = if min == 1UL { 0UL } else { db_checksum(base, size) }
  let post = db_checksum(data, size)
  let out = @buffer.Buffer(size_hint=(data.length() / 4).max(256))
  out.write_bytes(b"LTX1")
  ltx_be(out, 0UL, 4)
  ltx_be(out, size.to_uint64(), 4)
  ltx_be(out, (data.length() / size).to_uint64(), 4)
  ltx_be(out, min, 8)
  ltx_be(out, max, 8)
  ltx_be(out, timestamp.reinterpret_as_uint64(), 8)
  ltx_be(out, pre, 8)
  for _ in 0..<52 {
    out.write_byte(b'\x00')
  }
  let crc = Crc64::{ value: 0xffffffffffffffffUL, }
  crc.write(out.to_bytes()[:])
  let index = @buffer.Buffer()
  let mut pages = 0
  for page in 0..<(data.length() / size) {
    let start = page * size
    let bytes = data[start:start + size]
    if min != 1UL &&
      start + size <= base.length() &&
      bytes == base[start:start + size] {
      continue
    }
    let offset = out.length()
    let frame = @buffer.Buffer(size_hint=10)
    ltx_be(frame, (page + 1).to_uint64(), 4)
    ltx_be(frame, 1UL, 2)
    let compressed = lz4_compress(bytes)
    ltx_be(frame, compressed.length().to_uint64(), 4)
    let header = frame.to_bytes()
    out.write_bytes(header[:])
    out.write_bytes(compressed[:])
    crc.write(header[:])
    crc.write(bytes)
    ltx_varint(index, page + 1)
    ltx_varint(index, offset)
    ltx_varint(index, out.length() - offset)
    pages += 1
    guard out.length() + index.length() + 31 <= MaxImage else {
      raise Invalid("encoded LTX exceeds 64 MiB limit")
    }
  }
  let tail = @buffer.Buffer()
  for _ in 0..<6 {
    tail.write_byte(b'\x00')
  }
  ltx_varint(index, 0)
  let index_size = index.length()
  tail.write_bytes(index.to_bytes()[:])
  ltx_be(tail, index_size.to_uint64(), 8)
  ltx_be(tail, post, 8)
  let bytes = tail.to_bytes()
  out.write_bytes(bytes[:])
  crc.write(bytes[:])
  ltx_be(out, ChecksumFlag | crc.sum(), 8)
  ltx_result(
    out.to_bytes(),
    (
      {
        "minTXID": minimum,
        "maxTXID": maximum,
        "pageSize": size,
        "pageCount": data.length() / size,
        "pagesApplied": pages,
        "postChecksum": post.to_string(),
      } : Json).stringify(),
  )
}

///|
pub fn encode_ltx(
  base : Bytes,
  data : Bytes,
  min : String,
  max : String,
  timestamp : String,
) -> LtxResult {
  encode_ltx_checked(base, data, min, max, timestamp) catch {
    error =>
      ltx_result(
        b"",
        (
          {
            "error": match error {
              Invalid(message) => message
              _ => error.to_string()
            },
          } : Json).stringify(),
      )
  }
}

///|
pub fn encode_ltx_base64(
  base : String,
  data : String,
  min : String,
  max : String,
  timestamp : String,
) -> LtxResult {
  encode_ltx(@base64.decode(base), @base64.decode(data), min, max, timestamp) catch {
    _ => ltx_result(b"", "{\"error\":\"invalid base64 LTX input\"}")
  }
}
