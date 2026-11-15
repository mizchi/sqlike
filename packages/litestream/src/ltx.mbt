///|
/// LTX v3, pinned to github.com/superfly/ltx v0.5.2.
/// The on-disk magic does not identify the format version; callers must supply it.
const MaxImage : Int32 = 67108864

///|
const ChecksumFlag : UInt64 = 0x8000000000000000UL

///|
priv struct LtxReader {
  data : Bytes
  mut pos : Int32
}

///|
fn LtxReader::take(self : LtxReader, n : Int32) -> BytesView raise {
  guard n >= 0 && n <= self.data.length() - self.pos else {
    raise Invalid("truncated LTX")
  }
  let start = self.pos
  self.pos += n
  self.data[start:self.pos]
}

///|
fn LtxReader::byte(self : LtxReader) -> Int32 raise {
  guard self.pos < self.data.length() else { raise Invalid("truncated LTX") }
  let b = self.data[self.pos].to_int()
  self.pos += 1
  b
}

///|
fn LtxReader::be32(self : LtxReader) -> Int32 raise {
  let mut n = 0UL
  for b in self.take(4) {
    n = (n << 8) | b.to_uint64()
  }
  guard n <= 2147483647UL else {
    raise Invalid("LTX integer exceeds allocation limit")
  }
  n.to_int()
}

///|
fn LtxReader::be64(self : LtxReader) -> UInt64 raise {
  let mut n = 0UL
  for b in self.take(8) {
    n = (n << 8) | b.to_uint64()
  }
  n
}

///|
/// Page indexes use Go binary.Uvarint, unlike SQLite's changeset varints.
fn LtxReader::uvarint(self : LtxReader) -> Int32 raise {
  let mut n = 0UL
  for i in 0..<5 {
    let b = self.byte()
    n = n | ((b & 127).to_uint64() << (i * 7))
    if b < 128 {
      guard n <= MaxImage.to_uint64() else {
        raise Invalid("oversized LTX index value")
      }
      return n.to_int()
    }
  }
  raise Invalid("oversized LTX index varint")
}

///|
let crc64_table : FixedArray[UInt64] = FixedArray::makei(256, i => {
  let mut n = i.to_uint64()
  for _ in 0..<8 {
    n = if (n & 1UL) != 0UL { (n >> 1) ^ 0xd800000000000000UL } else { n >> 1 }
  }
  n
})

///|
priv struct Crc64 {
  mut value : UInt64
}

///|
fn Crc64::write(self : Crc64, data : BytesView) -> Unit {
  for b in data {
    self.value = crc64_table[((self.value ^ b.to_uint64()) & 255UL).to_int()] ^
      (self.value >> 8)
  }
}

///|
fn Crc64::sum(self : Crc64) -> UInt64 {
  self.value ^ 0xffffffffffffffffUL
}

///|
/// Bounded LZ4 block decoder, including overlapping match copies.
fn lz4_block(input : Bytes, capacity : Int32) -> Bytes raise {
  let r = LtxReader::{ data: input, pos: 0, }
  let output : FixedArray[Byte] = FixedArray::make(capacity, b'\x00')
  let mut pos = 0
  while r.pos < input.length() {
    let token = r.byte()
    let mut literals = token >> 4
    if literals == 15 {
      while true {
        let n = r.byte()
        literals += n
        guard literals <= capacity else {
          raise Invalid("oversized LZ4 literal")
        }
        if n != 255 {
          break
        }
      }
    }
    guard literals <= capacity - pos else {
      raise Invalid("LZ4 output overflow")
    }
    output.blit_from_bytesview(pos, r.take(literals))
    pos += literals
    if r.pos == input.length() {
      break
    }
    let offset = r.byte() | (r.byte() << 8)
    guard offset > 0 && offset <= pos else {
      raise Invalid("invalid LZ4 match offset")
    }
    let mut length = (token & 15) + 4
    if (token & 15) == 15 {
      while true {
        let n = r.byte()
        length += n
        guard length <= capacity else { raise Invalid("oversized LZ4 match") }
        if n != 255 {
          break
        }
      }
    }
    guard length <= capacity - pos else { raise Invalid("LZ4 output overflow") }
    for _ in 0..<length {
      output[pos] = output[pos - offset]
      pos += 1
    }
  }
  Bytes::from_array(output[:pos])
}

///|
fn le32(bytes : BytesView, pos : Int32) -> UInt32 {
  bytes[pos].to_uint() |
  (bytes[pos + 1].to_uint() << 8) |
  (bytes[pos + 2].to_uint() << 16) |
  (bytes[pos + 3].to_uint() << 24)
}

///|
fn rotl(value : UInt32, bits : Int32) -> UInt32 {
  (value << bits) | (value >> (32 - bits))
}

///|
/// XXH32 validates the wrapper on legacy LZ4 frames.
fn xxhash32(data : BytesView) -> UInt32 {
  let p1 = 2654435761U
  let p2 = 2246822519U
  let p3 = 3266489917U
  let p4 = 668265263U
  let p5 = 374761393U
  let mut i = 0
  let mut hash = p5
  if data.length() >= 16 {
    let v : FixedArray[UInt32] = [p1 + p2, p2, 0U, 0U - p1]
    while i <= data.length() - 16 {
      for j in 0..<4 {
        v[j] = rotl(v[j] + le32(data, i) * p2, 13) * p1
        i += 4
      }
    }
    hash = rotl(v[0], 1) + rotl(v[1], 7) + rotl(v[2], 12) + rotl(v[3], 18)
  }
  hash += data.length().reinterpret_as_uint()
  while i <= data.length() - 4 {
    hash = rotl(hash + le32(data, i) * p3, 17) * p4
    i += 4
  }
  while i < data.length() {
    hash = rotl(hash + data[i].to_uint() * p5, 11) * p1
    i += 1
  }
  hash = (hash ^ (hash >> 15)) * p2
  hash = (hash ^ (hash >> 13)) * p3
  hash ^ (hash >> 16)
}

///|
/// Legacy v3 page frames; only independent blocks without dictionaries.
fn lz4_frame(r : LtxReader, page_size : Int32) -> Bytes raise {
  guard r.take(4) == b"\x04\x22\x4d\x18" else {
    raise Invalid("invalid LZ4 frame magic")
  }
  let start = r.pos
  let flags = r.byte()
  let bd = r.byte()
  guard (flags & 0xe3) == 0x60 &&
    (bd & 0x8f) == 0 &&
    bd >> 4 >= 4 &&
    bd >> 4 <= 7 else {
    raise Invalid("unsupported LZ4 frame flags")
  }
  if (flags & 8) != 0 {
    let size = r.take(8)
    let n = le32(size, 0).to_uint64() | (le32(size, 4).to_uint64() << 32)
    guard n == page_size.to_uint64() else {
      raise Invalid("LZ4 content size mismatch")
    }
  }
  let descriptor = r.data[start:r.pos]
  guard r.byte() == ((xxhash32(descriptor) >> 8) & 255U).reinterpret_as_int() else {
    raise Invalid("LZ4 header checksum mismatch")
  }
  let out = @buffer.Buffer()
  while true {
    let block_size = le32(r.take(4), 0)
    if block_size == 0U {
      break
    }
    let n = (block_size & 0x7fffffffU).reinterpret_as_int()
    guard n > 0 && n <= page_size + 1024 else {
      raise Invalid("oversized LZ4 frame block")
    }
    let compressed = r.take(n)
    if (flags & 16) != 0 {
      guard le32(r.take(4), 0) == xxhash32(compressed) else {
        raise Invalid("LZ4 block checksum mismatch")
      }
    }
    let bytes = if (block_size & 0x80000000U) != 0U {
      compressed.to_owned()
    } else {
      lz4_block(compressed.to_owned(), page_size - out.length())
    }
    out.write_bytes(bytes)
    guard out.length() <= page_size else {
      raise Invalid("LZ4 frame output overflow")
    }
  }
  let bytes = out.to_bytes()
  guard bytes.length() == page_size else {
    raise Invalid("LZ4 page size mismatch")
  }
  if (flags & 4) != 0 {
    guard le32(r.take(4), 0) == xxhash32(bytes) else {
      raise Invalid("LZ4 content checksum mismatch")
    }
  }
  bytes
}

///|
fn db_checksum(data : Bytes, page_size : Int32) -> UInt64 {
  let mut result = ChecksumFlag
  let lock_page = 0x40000000 / page_size + 1
  for i in 0..<(data.length() / page_size) {
    if i + 1 == lock_page {
      continue
    }
    let crc = Crc64::{ value: 0xffffffffffffffffUL, }
    let head = @buffer.Buffer()
    head.write_int_be(i + 1)
    crc.write(head.to_bytes())
    crc.write(data[i * page_size:(i + 1) * page_size])
    result = ChecksumFlag | (result ^ crc.sum())
  }
  result
}

///|
fn parse_txid(value : String) -> UInt64 raise {
  guard !value.is_empty() && value.to_array().all(c => c >= '0' && c <= '9') else {
    raise Invalid("invalid TXID")
  }
  @string.parse_uint64(value, base=10)
}

///|
priv struct LtxImage {
  data : Bytes
  info : Json
}

///|
fn apply_ltx_checked(
  base : Bytes,
  current : String,
  input : Bytes,
  version : Int32,
) -> LtxImage raise {
  guard version == 3 else { raise Invalid("unsupported LTX format version") }
  guard input.length() <= MaxImage && base.length() <= MaxImage else {
    raise Invalid("LTX exceeds 64 MiB limit")
  }
  let r = LtxReader::{ data: input, pos: 0, }
  guard r.take(4) == b"LTX1" else { raise Invalid("invalid LTX magic") }
  let flags = r.be32()
  let page_size = r.be32()
  let commit = r.be32()
  let min_txid = r.be64()
  let max_txid = r.be64()
  let _timestamp = r.be64()
  let pre_checksum = r.be64()
  let _wal_offset = r.be64()
  let _wal_size = r.be64()
  let _salts_and_node = r.take(16)
  guard r.take(20).to_array().all(b => b == b'\x00') else {
    raise Invalid("nonzero LTX reserved bytes")
  }
  guard flags == 0 || flags == 2 else {
    raise Invalid("invalid LTX header flags")
  }
  guard page_size >= 512 &&
    page_size <= 65536 &&
    (page_size & (page_size - 1)) == 0 &&
    commit <= MaxImage / page_size else {
    raise Invalid("invalid LTX database size")
  }
  let txid = parse_txid(current)
  guard min_txid > 0UL && min_txid <= max_txid else {
    raise Invalid("invalid LTX TXID range")
  }
  guard max_txid > txid else { raise Invalid("stale or repeated LTX") }
  guard min_txid <= txid + 1UL else {
    raise Invalid("LTX TXID gap; snapshot required")
  }
  let snapshot = min_txid == 1UL
  guard !(snapshot || flags == 2) || pre_checksum == 0UL else {
    raise Invalid("invalid LTX pre checksum")
  }
  guard snapshot || flags == 2 || (pre_checksum & ChecksumFlag) != 0UL else {
    raise Invalid("invalid LTX pre checksum format")
  }
  if !snapshot {
    guard base.length() >= page_size && base.length() % page_size == 0 else {
      raise Invalid("LTX snapshot required")
    }
    guard base[0:16] == b"SQLite format 3\x00" else {
      raise Invalid("invalid base database")
    }
    let size = (base[16].to_int() << 8) | base[17].to_int()
    guard (if size == 1 { 65536 } else { size }) == page_size else {
      raise Invalid("database page size changed; snapshot required")
    }
    if flags == 0 && min_txid == txid + 1UL {
      guard pre_checksum == db_checksum(base, page_size) else {
        raise Invalid("LTX base checksum mismatch")
      }
    }
  }
  let output : FixedArray[Byte] = FixedArray::make(commit * page_size, b'\x00')
  if !snapshot {
    output.blit_from_bytes(
      0,
      base,
      0,
      Int32::min(base.length(), output.length()),
    )
  }
  let crc = Crc64::{ value: 0xffffffffffffffffUL, }
  crc.write(input[0:100])
  let pages : Array[(Int32, Int32, Int32)] = []
  let mut previous = 0
  while true {
    let start = r.pos
    let pgno = r.be32()
    let page_flags = (r.byte() << 8) | r.byte()
    crc.write(input[start:r.pos])
    if pgno == 0 {
      guard page_flags == 0 else { raise Invalid("invalid LTX terminator") }
      break
    }
    guard pgno > previous &&
      pgno <= commit &&
      (page_flags == 0 || page_flags == 1) else {
      raise Invalid("invalid LTX page ordering or flags")
    }
    if snapshot || pgno > base.length() / page_size {
      let expected = if snapshot {
        previous + 1
      } else {
        Int32::max(previous, base.length() / page_size) + 1
      }
      guard pgno == expected else {
        raise Invalid("missing LTX snapshot or growth page")
      }
    }
    let page = if page_flags == 1 {
      let size_pos = r.pos
      let n = r.be32()
      guard n > 0 && n <= page_size + 1024 else {
        raise Invalid("oversized LZ4 page")
      }
      crc.write(input[size_pos:r.pos])
      lz4_block(r.take(n).to_owned(), page_size)
    } else {
      lz4_frame(r, page_size)
    }
    guard page.length() == page_size else {
      raise Invalid("LZ4 page size mismatch")
    }
    crc.write(page)
    output.blit_from_bytes((pgno - 1) * page_size, page, 0, page_size)
    pages.push((pgno, start, r.pos - start))
    previous = pgno
  }
  if snapshot || commit > base.length() / page_size {
    guard previous == commit else {
      raise Invalid("incomplete LTX snapshot or growth")
    }
  }
  let index_start = r.pos
  for (pgno, offset, size) in pages {
    guard r.uvarint() == pgno && r.uvarint() == offset && r.uvarint() == size else {
      raise Invalid("LTX page index mismatch")
    }
  }
  guard r.uvarint() == 0 else { raise Invalid("extra LTX index entries") }
  let index_size = r.pos - index_start
  guard r.be64() == index_size.to_uint64() else {
    raise Invalid("LTX index size mismatch")
  }
  let post_checksum = r.be64()
  crc.write(input[index_start:r.pos])
  let expected_checksum = r.be64()
  guard r.pos == input.length() else { raise Invalid("trailing LTX data") }
  guard (ChecksumFlag | crc.sum()) == expected_checksum else {
    raise Invalid("LTX file checksum mismatch")
  }
  let data = Bytes::from_array(output[:])
  if flags == 2 {
    guard post_checksum == 0UL else {
      raise Invalid("invalid LTX post checksum")
    }
  } else {
    guard post_checksum == db_checksum(data, page_size) else {
      raise Invalid("LTX post checksum mismatch")
    }
  }
  if commit > 0 {
    guard data[0:16] == b"SQLite format 3\x00" else {
      raise Invalid("invalid restored SQLite header")
    }
    let size = (data[16].to_int() << 8) | data[17].to_int()
    guard (if size == 1 { 65536 } else { size }) == page_size else {
      raise Invalid("restored SQLite page size mismatch")
    }
  }
  let info : Json = {
    "minTXID": min_txid.to_string(),
    "maxTXID": max_txid.to_string(),
    "pageSize": page_size,
    "pageCount": commit,
    "pagesApplied": pages.length(),
    "postChecksum": post_checksum.to_string(),
  }
  LtxImage::{ data, info, }
}

///|
/// Opaque portable result; JavaScript only marshals metadata at the ABI boundary.
struct LtxResult {
  data : Bytes
  metadata : String
}

///|
fn ltx_result(data : Bytes, metadata : String) -> LtxResult {
  { data, metadata, }
}

///|
pub fn ltx_data(result : LtxResult) -> Bytes {
  result.data
}

///|
pub fn ltx_info(result : LtxResult) -> String {
  result.metadata
}

///|
/// String ABI for hosts where MoonBit GC byte arrays are opaque references.
pub fn ltx_data_base64(result : LtxResult) -> String {
  @base64.encode(result.data)
}

///|
pub fn apply_ltx(
  base : Bytes,
  txid : String,
  data : Bytes,
  version : Int32,
) -> LtxResult {
  try {
    let result = apply_ltx_checked(base, txid, data, version)
    ltx_result(result.data, result.info.stringify())
  } catch {
    Invalid(message) =>
      ltx_result(b"", ({ "error": message } : Json).stringify())
    _ => ltx_result(b"", "{\"error\":\"invalid LTX\"}")
  }
}

///|
pub fn apply_ltx_base64(
  base : String,
  txid : String,
  data : String,
  version : Int32,
) -> LtxResult {
  try {
    guard base.length() <= 89478488 && data.length() <= 89478488 else {
      raise Invalid("LTX base64 resource limit")
    }
    apply_ltx(@base64.decode(base), txid, @base64.decode(data), version)
  } catch {
    _ => ltx_result(b"", "{\"error\":\"invalid LTX base64\"}")
  }
}
