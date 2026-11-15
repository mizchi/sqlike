///|
/// Experimental rowid KV blocks. This package has no SQL/parser/IO dependency.
priv struct Entry {
  key : Int64
  sequence : Int32
  value : Bytes?
}

///|
pub struct Block {
  priv entries : Array[Entry]
  priv mut bytes : Int32
  priv error : String?
}

///|
priv suberror Invalid {
  Invalid(String)
}

///|
fn invalid(message : String) -> Block {
  { entries: [], bytes: 12, error: Some(message), }
}

///|
pub fn lsm_new() -> Block {
  { entries: [], bytes: 12, error: None, }
}

///|
pub fn lsm_info(block : Block) -> String {
  match block.error {
    None => "{}"
    Some(message) => "{\"error\":\"" + message + "\"}"
  }
}

///|
pub fn lsm_count(block : Block) -> Int32 {
  block.entries.length()
}

///|
pub fn lsm_size(block : Block) -> Int32 {
  block.bytes
}

///|
pub fn lsm_key(block : Block, index : Int32) -> String {
  block.entries[index].key.to_string()
}

///|
pub fn lsm_sequence(block : Block, index : Int32) -> Int32 {
  block.entries[index].sequence
}

///|
pub fn lsm_deleted(block : Block, index : Int32) -> Bool {
  block.entries[index].value is None
}

///|
pub fn lsm_value(block : Block, index : Int32) -> Bytes {
  block.entries[index].value.unwrap_or(b"")
}

///|
fn seek(block : Block, key : Int64) -> Int32 {
  let mut lo = 0
  let mut hi = block.entries.length()
  while lo < hi {
    let mid = lo + (hi - lo) / 2
    if block.entries[mid].key < key {
      lo = mid + 1
    } else {
      hi = mid
    }
  }
  lo
}

///|
pub fn lsm_seek(block : Block, key : String) -> Int32 {
  let key = @string.parse_int64(key) catch { _ => return -1 }
  seek(block, key)
}

///|
fn entry_size(entry : Entry) -> Int32 {
  16 +
  (match entry.value {
    None => 0
    Some(bytes) => bytes.length()
  })
}

///|
pub fn lsm_put(
  block : Block,
  key : String,
  sequence : Int32,
  value : Bytes,
  deleted : Bool,
) -> String {
  if block.error is Some(_) {
    return lsm_info(block)
  }
  let key = @string.parse_int64(key) catch {
    _ => return "{\"error\":\"invalid int64 key\"}"
  }
  if sequence <= 0 || value.length() > 1048576 {
    return "{\"error\":\"invalid sequence or value size\"}"
  }
  let index = seek(block, key)
  let replacing = index < block.entries.length() &&
    block.entries[index].key == key
  let old_size = if replacing { entry_size(block.entries[index]) } else { 0 }
  let size = block.bytes -
    old_size +
    16 +
    (if deleted { 0 } else { value.length() })
  if size > 4194304 || (!replacing && block.entries.length() >= 65536) {
    return "{\"error\":\"block resource limit\"}"
  }
  // Bytes are immutable within MoonBit, but JS callers can mutate Uint8Array.
  let entry = {
    key,
    sequence,
    value: if deleted {
      None
    } else {
      Some(Bytes::makei(value.length(), i => value[i]))
    },
  }
  if replacing {
    block.entries[index] = entry
  } else {
    block.entries.insert(index, entry)
  }
  block.bytes = size
  "{}"
}

///|
let crc_table : FixedArray[UInt32] = FixedArray::makei(256, i => {
  let mut crc = i.reinterpret_as_uint()
  for _ in 0..<8 {
    crc = if (crc & 1U) == 1U { (crc >> 1) ^ 0xedb88320U } else { crc >> 1 }
  }
  crc
})

///|
fn crc32(bytes : Bytes) -> UInt32 {
  let mut crc = 0xffffffffU
  for byte in bytes {
    crc = (crc >> 8) ^
      crc_table[((crc ^ byte.to_uint()) & 255U).reinterpret_as_int()]
  }
  crc ^ 0xffffffffU
}

///|
fn word(out : @buffer.Buffer, n : UInt64, width : Int32) -> Unit {
  for i in 0..<width {
    out.write_byte(((n >> (i * 8)) & 255UL).to_byte())
  }
}

///|
pub fn lsm_encode(block : Block) -> Bytes {
  let out = @buffer.Buffer(size_hint=block.bytes)
  out.write_bytes(b"SLM1"[:])
  word(out, block.entries.length().to_uint64(), 4)
  for entry in block.entries {
    word(out, entry.key.reinterpret_as_uint64(), 8)
    word(out, entry.sequence.to_uint64(), 4)
    match entry.value {
      None => word(out, 0xffffffffUL, 4)
      Some(bytes) => {
        word(out, bytes.length().to_uint64(), 4)
        out.write_bytes(bytes[:])
      }
    }
  }
  word(out, crc32(out.to_bytes()).to_uint64(), 4)
  out.to_bytes()
}

///|
fn read_word(bytes : Bytes, offset : Int32, width : Int32) -> UInt64 {
  let mut n = 0UL
  for i in 0..<width {
    n = n | (bytes[offset + i].to_uint64() << (i * 8))
  }
  n
}

///|
fn decode(bytes : Bytes) -> Block raise Invalid {
  let length = bytes.length()
  guard length >= 12 && length <= 4194304 && bytes[0:4] == b"SLM1"[:] else {
    raise Invalid("invalid block header")
  }
  guard read_word(bytes, length - 4, 4) ==
    crc32(bytes[0:length - 4].to_owned()).to_uint64() else {
    raise Invalid("block checksum mismatch")
  }
  let count = read_word(bytes, 4, 4)
  guard count <= 65536UL && count <= ((length - 12) / 16).to_uint64() else {
    raise Invalid("invalid entry count")
  }
  let entries : Array[Entry] = []
  let mut offset = 8
  for _ in 0..<count.to_int() {
    guard offset <= length - 20 else { raise Invalid("truncated entry") }
    let key = read_word(bytes, offset, 8).reinterpret_as_int64()
    let sequence = read_word(bytes, offset + 8, 4)
    let size = read_word(bytes, offset + 12, 4)
    offset += 16
    guard sequence > 0UL && sequence <= 2147483647UL else {
      raise Invalid("invalid sequence")
    }
    guard entries.is_empty() || entries[entries.length() - 1].key < key else {
      raise Invalid("unordered or duplicate key")
    }
    let value = if size == 0xffffffffUL {
      None
    } else {
      guard size <= 1048576UL && size <= (length - 4 - offset).to_uint64() else {
        raise Invalid("invalid value length")
      }
      let value = bytes[offset:offset + size.to_int()].to_owned()
      offset += size.to_int()
      Some(value)
    }
    entries.push({ key, sequence: sequence.to_int(), value, })
  }
  guard offset == length - 4 else { raise Invalid("trailing block bytes") }
  { entries, bytes: length, error: None, }
}

///|
pub fn lsm_decode(bytes : Bytes) -> Block {
  decode(bytes) catch {
    Invalid(message) => invalid(message)
  }
}

///|
/// Inputs remain immutable after publication; equal sequences must agree.
pub fn lsm_merge(left : Block, right : Block) -> Block {
  if left.error is Some(_) {
    return left
  }
  if right.error is Some(_) {
    return right
  }
  let out = lsm_new()
  let mut a = 0
  let mut b = 0
  while a < left.entries.length() || b < right.entries.length() {
    let entry = if b >= right.entries.length() ||
      (a < left.entries.length() && left.entries[a].key < right.entries[b].key) {
      let entry = left.entries[a]
      a += 1
      entry
    } else if a >= left.entries.length() ||
      right.entries[b].key < left.entries[a].key {
      let entry = right.entries[b]
      b += 1
      entry
    } else {
      let x = left.entries[a]
      let y = right.entries[b]
      a += 1
      b += 1
      if x.sequence == y.sequence && x.value != y.value {
        return invalid("conflicting equal sequence")
      }
      if x.sequence > y.sequence {
        x
      } else {
        y
      }
    }
    out.entries.push(entry)
    out.bytes += entry_size(entry)
  }
  out
}

///|
pub fn lsm_slice(block : Block, start : Int32, count : Int32) -> Block {
  let out = lsm_new()
  for i in start..<(start + count) {
    let entry = block.entries[i]
    out.entries.push(entry)
    out.bytes += entry_size(entry)
  }
  out
}
